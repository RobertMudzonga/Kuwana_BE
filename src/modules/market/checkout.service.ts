import crypto from 'crypto';
import { Currency, PaymentMethod, Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { sendSms } from '../../lib/sms';
import { hashSecret, randomDigits, verifySecret } from '../../lib/secrets';
import {
  AppError, BadRequestError, ConflictWithDetailsError, NotFoundError,
} from '../../middleware/error.middleware';
import { currencyService, roundMoney, usdToZwg, RateSnapshot } from '../currency/currency.service';
import { buyBoxService, getDeliveryPricing } from '../catalog/buybox.service';
import { assertPickupCapacity } from '../control/locations.service';
import { collateralFor } from '../delivery/fees';
import { acceptDeadline, storeOrdersService } from '../store/store-orders.service';
import { paymentsService, registerPaymentPurpose, PaymentSummary } from '../payments/payments.service';
import { getMarketSettings } from './market.settings';
import { ledgerService } from './ledger.service';
import { walletService } from './wallet.service';
import {
  codEligibility, codSplit, DEPOSIT_METHODS, Destination, paymentMethodOptions, planShipments, PricedLine, ShipmentPlan, MethodOption,
} from './pricing';
import { PlaceOrderDto, QuoteDto } from './market.schema';
import { marketOrderInclude, toMarketOrderDto, toQuoteDto } from './market.serializers';

type Tx = Prisma.TransactionClient;
const Decimal = Prisma.Decimal;

const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_COOLDOWN_MS = 60_000;
const REFERENCE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const offerInclude = {
  product: {
    select: {
      id: true, sku: true, slug: true, title: true, status: true, weightKg: true,
      images: { orderBy: { sortOrder: 'asc' }, take: 1, select: { url: true, thumbUrl: true } },
      requiredVehicleClass: true,
      category: { select: { commissionRate: true, fulfilmentFeeUsd: true, requiredVehicleClass: true } },
    },
  },
  seller: { select: { id: true, businessName: true, isFirstParty: true, kycStatus: true } },
  hub: { select: { id: true, cityId: true, isActive: true, city: { select: { name: true } } } },
  storeBranch: {
    select: {
      id: true, name: true, code: true, cityId: true, suburbId: true, isActive: true, isPaused: true, lat: true, lng: true, operatingHours: true, phone: true,
      suburb: { select: { name: true } },
    },
  },
  dispatchCity: { select: { id: true, name: true } },
} satisfies Prisma.OfferInclude;

export type LoadedOffer = Prisma.OfferGetPayload<{ include: typeof offerInclude }>;

export interface LineIssue {
  offerId: string;
  type: 'UNAVAILABLE' | 'INSUFFICIENT_STOCK' | 'UNDELIVERABLE';
  message: string;
  availableQty: number;
}

export interface ResolvedLine {
  offer: LoadedOffer;
  requested: number;
  quantity: number;
  priced: PricedLine;
}

export interface ResolvedDestination {
  destination: Destination;
  city: { id: string; name: string; slug: string; zone: 'METRO' | 'INTERCITY'; codEligible: boolean };
  snapshot: Prisma.InputJsonObject;
  addressId: string | null;
  pickupPointId: string | null;
}

/** Everything a quote or order needs, computed the same way for both */
interface Priced {
  lines: ResolvedLine[];
  issues: LineIssue[];
  dest: ResolvedDestination | null;
  plan: ShipmentPlan;
  cod: { eligible: boolean; reasons: string[] };
  codFeeUsd: Prisma.Decimal;
  /** Cash on delivery only: what is paid upfront online vs in cash at the door */
  codDeposit: { depositUsd: Prisma.Decimal; cashDueUsd: Prisma.Decimal } | null;
  totalUsd: Prisma.Decimal;
  methods: MethodOption[];
  rate: RateSnapshot | null;
  isGift: boolean;
  buyer: { id: string; email: string; phone: string | null; phoneVerified: boolean; codTrustScore: number; fullName: string } | null;
}

function generateReference(): string {
  return 'KM' + Array.from(crypto.randomBytes(6), (b) => REFERENCE_ALPHABET[b % REFERENCE_ALPHABET.length]).join('');
}

function addDays(d: Date, days: number) {
  return new Date(d.getTime() + days * 24 * 60 * 60 * 1000);
}

async function loadLines(items: { offerId: string; quantity: number }[]): Promise<{ lines: ResolvedLine[]; issues: LineIssue[] }> {
  const [offers, settings] = await Promise.all([
    prisma.offer.findMany({ where: { id: { in: items.map((i) => i.offerId) } }, include: offerInclude }),
    getMarketSettings(),
  ]);
  const byId = new Map(offers.map((o) => [o.id, o]));
  const lines: ResolvedLine[] = [];
  const issues: LineIssue[] = [];

  for (const item of items) {
    const o = byId.get(item.offerId);
    const buyable = o && o.isActive && o.product.status === 'ACTIVE' && o.seller.kycStatus === 'APPROVED'
      && (o.fulfilmentType === 'PLATFORM_FULFILLED'
        ? settings.hubsEnabled && !!o.hub?.isActive
        : !!o.storeBranch?.isActive && !o.storeBranch.isPaused);
    if (!o || !buyable) {
      issues.push({ offerId: item.offerId, type: 'UNAVAILABLE', message: `${o?.product.title ?? 'An item'} is no longer available`, availableQty: 0 });
      continue;
    }
    if (o.stockQty <= 0) {
      issues.push({ offerId: o.id, type: 'UNAVAILABLE', message: `${o.product.title} has sold out`, availableQty: 0 });
      continue;
    }
    const quantity = Math.min(item.quantity, o.stockQty);
    if (quantity < item.quantity) {
      issues.push({ offerId: o.id, type: 'INSUFFICIENT_STOCK', message: `Only ${o.stockQty} of ${o.product.title} left`, availableQty: o.stockQty });
    }
    lines.push({
      offer: o,
      requested: item.quantity,
      quantity,
      priced: {
        offerId: o.id,
        quantity,
        unitPriceUsd: o.priceUsd,
        shippingFeeUsd: o.shippingFeeUsd,
        fulfilmentType: o.fulfilmentType,
        hubId: o.hubId,
        hubCityId: o.hub?.cityId ?? null,
        hubCityName: o.hub?.city.name ?? null,
        sellerId: o.sellerId,
        sellerName: o.seller.businessName,
        dispatchCityId: o.dispatchCityId,
        dispatchCityName: o.dispatchCity?.name ?? null,
        leadTimeDays: o.leadTimeDays,
        weightKg: o.product.weightKg,
        branch: o.storeBranch
          ? {
              id: o.storeBranch.id, name: o.storeBranch.name, sellerName: o.seller.businessName, cityId: o.storeBranch.cityId,
              suburb: o.storeBranch.suburb?.name ?? null, suburbId: o.storeBranch.suburbId, lat: o.storeBranch.lat, lng: o.storeBranch.lng, operatingHours: o.storeBranch.operatingHours,
            }
          : null,
        prepTimeMins: o.prepTimeMins,
        vehicleClass: o.product.requiredVehicleClass ?? o.product.category.requiredVehicleClass,
      },
    });
  }
  return { lines, issues };
}

/** Where on the map a drop-off is (its own pin, else the suburb centre, else the city centre) and its suburb */
async function dropOffPoint(
  cityId: string,
  suburbName: string | null | undefined,
  lat: number | null | undefined,
  lng: number | null | undefined,
  knownSuburbId?: string | null,
): Promise<{ lat: number | null; lng: number | null; suburbId: string | null }> {
  const sub = knownSuburbId
    ? await prisma.suburb.findUnique({ where: { id: knownSuburbId }, select: { id: true, lat: true, lng: true } })
    : suburbName
      ? await prisma.suburb.findFirst({ where: { cityId, name: { equals: suburbName.trim(), mode: 'insensitive' } }, select: { id: true, lat: true, lng: true } })
      : null;
  const suburbId = sub?.id ?? null;
  if (lat != null && lng != null) return { lat, lng, suburbId };
  if (sub?.lat != null && sub.lng != null) return { lat: sub.lat, lng: sub.lng, suburbId };
  const city = await prisma.city.findUnique({ where: { id: cityId }, select: { lat: true, lng: true } });
  return { lat: city?.lat ?? null, lng: city?.lng ?? null, suburbId };
}

type CityRow = { id: string; name: string; slug: string; zone: 'METRO' | 'INTERCITY'; codEligible: boolean };
const cityDto = (c: CityRow) => ({ id: c.id, name: c.name, slug: c.slug, zone: c.zone, codEligible: c.codEligible });

async function resolveDestination(userId: string | null, f: NonNullable<QuoteDto['fulfilment']>): Promise<ResolvedDestination> {
  if (f.mode === 'DELIVERY' && f.address) {
    // One-off address typed at checkout (e.g. a diaspora gift to family); kept only on the order
    const a = f.address;
    const city = await prisma.city.findUnique({ where: { id: a.cityId } });
    if (!city || !city.isActive) throw new BadRequestError('Choose a listed town');
    const suburb = a.suburbId ? await prisma.suburb.findFirst({ where: { id: a.suburbId, cityId: city.id } }) : null;
    if (a.suburbId && !suburb) throw new BadRequestError('That suburb is not in the selected town');
    const point = await dropOffPoint(city.id, suburb?.name, a.lat, a.lng, suburb?.id);
    return {
      destination: { cityId: city.id, zone: city.zone, codEligible: city.codEligible, ...point },
      city: cityDto(city),
      snapshot: {
        type: 'ADDRESS', label: 'Delivery address', line1: a.line1, line2: null, suburb: suburb?.name ?? null,
        landmark: a.landmark, city: city.name, lat: point.lat, lng: point.lng, suburbId: point.suburbId, pinned: a.lat !== undefined, instructions: a.instructions ?? null,
      },
      addressId: null,
      pickupPointId: null,
    };
  }
  if (f.mode === 'DELIVERY') {
    if (!f.addressId) throw new BadRequestError('Choose a delivery address');
    if (!userId) throw new AppError('Sign in to deliver to a saved address', 401);
    const address = await prisma.address.findFirst({ where: { id: f.addressId, userId } });
    if (!address) throw new NotFoundError('Address');
    const city = address.cityId
      ? await prisma.city.findUnique({ where: { id: address.cityId } })
      : await prisma.city.findFirst({ where: { name: { equals: address.city.trim(), mode: 'insensitive' } } });
    if (!city || !city.isActive) throw new BadRequestError(`We don't deliver to "${address.city}" yet. Choose a listed town, or collect from a pickup point.`);
    const point = await dropOffPoint(city.id, address.suburb, address.lat, address.lng);
    return {
      destination: { cityId: city.id, zone: city.zone, codEligible: city.codEligible, ...point },
      city: cityDto(city),
      snapshot: {
        type: 'ADDRESS', label: address.label, line1: address.line1, line2: address.line2, suburb: address.suburb,
        landmark: address.landmark, city: city.name, lat: point.lat, lng: point.lng, suburbId: point.suburbId, pinned: address.lat != null, instructions: address.instructions,
      },
      addressId: address.id,
      pickupPointId: null,
    };
  }
  const pickupPoint = await prisma.pickupPoint.findFirst({ where: { id: f.pickupPointId, isActive: true }, include: { city: true } });
  if (!pickupPoint) throw new NotFoundError('Pickup point');
  await assertPickupCapacity(pickupPoint);
  const city = pickupPoint.city;
  const point = await dropOffPoint(city.id, pickupPoint.suburb, pickupPoint.lat, pickupPoint.lng, pickupPoint.suburbId);
  return {
    destination: { cityId: city.id, zone: city.zone, codEligible: city.codEligible, ...point },
    city: cityDto(city),
    snapshot: {
      type: 'PICKUP_POINT', code: pickupPoint.code, name: pickupPoint.name, address: pickupPoint.address, suburb: pickupPoint.suburb,
      landmark: pickupPoint.landmark, city: city.name, operatingHours: pickupPoint.operatingHours, lat: point.lat, lng: point.lng, suburbId: point.suburbId,
    },
    addressId: null,
    pickupPointId: pickupPoint.id,
  };
}

async function price(userId: string | null, dto: QuoteDto): Promise<Priced> {
  const [settings, { bands, zones }, rate, loaded, dest, buyerRow] = await Promise.all([
    getMarketSettings(),
    getDeliveryPricing(),
    currencyService.getUsdToZwg(),
    loadLines(dto.items),
    dto.fulfilment ? resolveDestination(userId, dto.fulfilment) : Promise.resolve(null),
    userId
      ? prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, phone: true, phoneVerified: true, codTrustScore: true, profile: { select: { fullName: true } } } })
      : Promise.resolve(null),
  ]);
  if (dto.paymentCurrency === 'ZWG' && !rate) throw new BadRequestError('ZiG payments are unavailable until an exchange rate is set');

  const buyer = buyerRow ? { ...buyerRow, fullName: buyerRow.profile?.fullName ?? '' } : null;
  const plan = planShipments(loaded.lines.map((l) => l.priced), {
    destination: dest?.destination ?? null,
    mode: dto.fulfilment?.mode ?? 'DELIVERY',
    speed: dto.speed,
    settings,
    bands,
    zones,
  });
  // Parcels that can't reach the destination become cart issues (the buyer removes them or picks another place)
  const issues = [
    ...loaded.issues,
    ...plan.undeliverable.flatMap((u) => {
      const shipment = plan.shipments.find((sh) => sh.key === u.key)!;
      return shipment.lines.map((l) => ({ offerId: l.offerId, type: 'UNDELIVERABLE' as const, message: u.reason, availableQty: l.quantity }));
    }),
  ];
  const isGift = !!dto.recipient && dto.recipient.phone !== buyer?.phone;
  const preCodTotal = plan.itemsSubtotalUsd.plus(plan.deliveryFeeUsd).plus(plan.sellerShippingUsd);
  const codTotal = roundMoney(preCodTotal.plus(settings.codFeeUsd));
  const split = codSplit(codTotal, plan.itemsSubtotalUsd, settings.codDepositRequired);
  const cod = codEligibility({
    settings,
    mode: dto.fulfilment?.mode ?? 'DELIVERY',
    destination: dest?.destination ?? null,
    orderTotalUsd: preCodTotal,
    depositUsd: split.depositUsd,
    depositPayable: DEPOSIT_METHODS.some((m) => paymentsService.gatewaySupports(m as PaymentMethod)),
    buyer: buyer ? { trustScore: buyer.codTrustScore, phoneVerified: buyer.phoneVerified } : null,
    isGift,
  });
  const codFeeUsd = dto.paymentMethod === 'CASH' && cod.eligible ? new Decimal(settings.codFeeUsd) : new Decimal(0);
  const totalUsd = roundMoney(preCodTotal.plus(codFeeUsd));
  const wallet = buyer ? await walletService.balance(buyer.id) : null;
  const methods = paymentMethodOptions({
    currency: dto.paymentCurrency,
    gatewaySupports: (m) => paymentsService.gatewaySupports(m as PaymentMethod),
    walletBalanceUsd: wallet,
    totalUsd,
    cod,
  });
  const codDeposit = dto.paymentMethod === 'CASH' && cod.eligible ? split : null;
  return { ...loaded, issues, dest, plan, cod, codFeeUsd, codDeposit, totalUsd, methods, rate, isGift, buyer };
}

function amountIn(currency: Currency, usd: Prisma.Decimal, rate: Prisma.Decimal) {
  return currency === 'USD' ? roundMoney(usd) : usdToZwg(usd, rate);
}

export class MarketCheckoutService {
  async quote(userId: string | null, dto: QuoteDto) {
    const p = await price(userId, dto);
    return toQuoteDto(p, dto);
  }

  /**
   * Create the order: re-price everything, reserve stock, split into shipments, lock the exchange rate.
   * Then: wallet pays immediately; COD sends an SMS code; online methods start a gateway payment.
   */
  async placeOrder(userId: string, dto: PlaceOrderDto) {
    const p = await price(userId, dto);
    const buyer = p.buyer!;
    const dest = p.dest!;

    if (p.issues.length) {
      throw new ConflictWithDetailsError('Some items in your cart have changed. Review your cart and try again.', { issues: p.issues });
    }
    const method = p.methods.find((m) => m.method === dto.paymentMethod);
    if (!method?.available) throw new BadRequestError(method?.reason ?? 'That payment method is not available');
    if (dto.speed === 'EXPRESS' && !p.plan.express.available) throw new BadRequestError(p.plan.express.reason ?? 'Same-day delivery is not available');
    if (p.totalUsd.minus(dto.expectedTotalUsd).abs().gt(0.009)) {
      throw new ConflictWithDetailsError('Prices or delivery charges have changed. Review the new total and try again.', {
        expectedTotalUsd: dto.expectedTotalUsd, totalUsd: p.totalUsd.toNumber(),
      });
    }

    // Cash on delivery: the delivery + COD fee is a deposit paid now by EcoCash / InnBucks
    const deposit = dto.paymentMethod === 'CASH' ? p.codDeposit : null;
    const needsDeposit = !!deposit && deposit.depositUsd.gt(0);
    if (needsDeposit) {
      if (!dto.depositMethod) throw new BadRequestError('Choose EcoCash or InnBucks to pay the delivery fee upfront');
      if (!dto.paymentPhone) throw new BadRequestError('Enter the mobile number to charge the delivery fee');
      if (!paymentsService.gatewaySupports(dto.depositMethod)) throw new BadRequestError(`${dto.depositMethod === 'ECOCASH' ? 'EcoCash' : 'InnBucks'} is not available right now`);
    }

    let recipient: { name: string; phone: string; idNumber?: string };
    if (dto.recipient) recipient = dto.recipient;
    else if (buyer.phone && buyer.phoneVerified && /^\+2637\d{8}$/.test(buyer.phone)) recipient = { name: buyer.fullName || 'Customer', phone: buyer.phone };
    else throw new BadRequestError('Add the phone number of the person receiving this order');

    const settings = await getMarketSettings();
    const rate = p.rate?.rate ?? new Decimal(0);
    const currency = dto.paymentCurrency;
    // What is paid online now: everything, or just the deposit on a COD order
    const amountDue = amountIn(currency, needsDeposit ? deposit!.depositUsd : p.totalUsd, rate);
    const now = new Date();
    const isCod = dto.paymentMethod === 'CASH';
    const isWallet = dto.paymentMethod === 'WALLET';
    const deadlineMinutes = isCod && !needsDeposit ? settings.codOtpTimeoutMinutes : settings.paymentTimeoutMinutes;
    const expiresAt = isWallet ? null : new Date(now.getTime() + deadlineMinutes * 60_000);
    // No deposit due (e.g. free delivery and no COD fee): confirm the COD order by SMS code as before
    const otp = isCod && !needsDeposit ? randomDigits() : null;
    const productIds = [...new Set(p.lines.map((l) => l.offer.productId))].sort();

    const { orderId, reference, pinNotice } = await prisma.$transaction(async (tx) => {
      // Reserve stock; the conditional update fails if someone else bought the last units
      for (const line of p.lines) {
        const { count } = await tx.offer.updateMany({
          where: { id: line.offer.id, isActive: true, stockQty: { gte: line.quantity } },
          data: { stockQty: { decrement: line.quantity } },
        });
        if (count === 0) {
          throw new ConflictWithDetailsError(`${line.offer.product.title} just sold out. Review your cart and try again.`, {
            issues: [{ offerId: line.offer.id, type: 'INSUFFICIENT_STOCK', message: `${line.offer.product.title} just sold out`, availableQty: 0 }],
          });
        }
      }

      let reference = generateReference();
      while (await tx.marketOrder.findUnique({ where: { reference }, select: { id: true } })) reference = generateReference();

      const order = await tx.marketOrder.create({
        data: {
          reference,
          userId,
          status: needsDeposit ? 'AWAITING_DEPOSIT' : isCod ? 'AWAITING_COD_OTP' : 'PENDING_PAYMENT',
          paymentMethod: dto.paymentMethod,
          paymentCurrency: currency,
          paymentPhone: dto.paymentPhone,
          lockedExchangeRate: rate,
          exchangeRateId: p.rate?.id,
          deliveryMode: dto.fulfilment.mode,
          deliverySpeed: dto.speed,
          addressId: dest.addressId,
          deliveryAddress: dest.snapshot,
          destinationCityId: dest.city.id,
          pickupPointId: dest.pickupPointId,
          recipientName: recipient.name,
          recipientPhone: recipient.phone,
          recipientIdNumber: recipient.idNumber,
          isGift: p.isGift,
          itemsSubtotalUsd: p.plan.itemsSubtotalUsd,
          deliveryFeeUsd: p.plan.deliveryFeeUsd,
          sellerShippingUsd: p.plan.sellerShippingUsd,
          codFeeUsd: p.codFeeUsd,
          totalUsd: p.totalUsd,
          totalZwg: usdToZwg(p.totalUsd, rate),
          amountDue,
          freeDeliveryApplied: p.plan.shipments.some((s) => s.feeWaived),
          depositUsd: needsDeposit ? deposit!.depositUsd : 0,
          cashDueUsd: isCod ? (deposit?.cashDueUsd ?? p.totalUsd) : 0,
          notes: dto.notes,
          expiresAt,
          codOtpHash: otp ? hashSecret(`cod:${reference}`, otp) : null,
          codOtpExpiresAt: otp ? expiresAt : null,
          codOtpSentAt: otp ? now : null,
        },
      });

      const lineByOffer = new Map(p.lines.map((l) => [l.offer.id, l]));
      for (const [i, planned] of p.plan.shipments.entries()) {
        const shipment = await tx.shipment.create({
          data: {
            orderId: order.id,
            reference: `${reference}-${i + 1}`,
            sequence: i + 1,
            sourceType: planned.sourceType,
            hubId: planned.hubId,
            sellerId: planned.sellerId,
            dispatchCityId: planned.dispatchCityId,
            tier: planned.tier!,
            feeUsd: planned.feeUsd ?? 0,
            weightKg: planned.weightKg,
            etaMinDays: planned.etaMinDays ?? 0,
            etaMaxDays: planned.etaMaxDays ?? 0,
            storeBranchId: planned.storeBranchId,
            distanceKm: planned.distanceKm,
            vehicleClass: planned.vehicleClass,
            driverFeeUsd: planned.driverFeeUsd,
            etaMinutes: planned.etaMinutes,
          },
        });
        await tx.marketOrderItem.createMany({
          data: planned.lines.map((pl) => {
            const { offer, quantity } = lineByOffer.get(pl.offerId)!;
            const lineTotal = roundMoney(offer.priceUsd.times(quantity));
            const commissionRate = offer.product.category.commissionRate;
            const commission = roundMoney(lineTotal.times(commissionRate).dividedBy(100));
            const fulfilmentFee = offer.fulfilmentType === 'PLATFORM_FULFILLED'
              ? roundMoney(offer.product.category.fulfilmentFeeUsd.times(quantity))
              : new Decimal(0);
            return {
              orderId: order.id,
              shipmentId: shipment.id,
              offerId: offer.id,
              productId: offer.productId,
              sellerId: offer.sellerId,
              title: offer.product.title,
              sku: offer.product.sku,
              imageUrl: offer.product.images[0]?.thumbUrl ?? offer.product.images[0]?.url,
              fulfilmentType: offer.fulfilmentType,
              quantity,
              unitPriceUsd: offer.priceUsd,
              lineTotalUsd: lineTotal,
              commissionRate,
              commissionUsd: commission,
              fulfilmentFeeUsd: fulfilmentFee,
              sellerNetUsd: lineTotal.minus(commission).minus(fulfilmentFee),
            };
          }),
        });
      }

      // Stock moved, so Buy Box winners may change (locks taken in id order to avoid deadlocks)
      for (const productId of productIds) await buyBoxService.recomputeProduct(productId, tx);

      let pinNotice: PinNotice | null = null;
      if (isWallet) {
        const payment = await tx.payment.create({
          data: {
            checkoutRef: order.id, purpose: 'MARKET_ORDER', method: 'WALLET', gateway: 'MANUAL',
            amount: p.totalUsd, currency: 'USD', status: 'SUCCEEDED',
          },
        });
        await walletService.debit(tx, { userId, amountUsd: p.totalUsd, orderId: order.id, paymentId: payment.id, rate, memo: `Order ${reference}` });
        pinNotice = await this.confirmOrder(tx, order.id, payment.id, 'PAID');
      }
      return { orderId: order.id, reference, pinNotice };
    });

    let payment: PaymentSummary | { status: 'FAILED'; message: string } | null = null;
    if (isCod && !needsDeposit) {
      await this.sendSmsSafely(buyer.phone!, `Your Kuwana code to confirm order ${reference} is ${otp}. It expires in ${settings.codOtpTimeoutMinutes} minutes.`);
    } else if (pinNotice) {
      await this.sendPin(pinNotice);
    } else {
      try {
        payment = await paymentsService.startPayment({
          purpose: 'MARKET_ORDER',
          checkoutRef: orderId,
          amount: amountDue.toNumber(),
          currency,
          method: needsDeposit ? dto.depositMethod! : dto.paymentMethod,
          phone: dto.paymentPhone,
          customerEmail: buyer.email,
          description: needsDeposit ? `Kuwana order ${reference} delivery fee (cash on delivery)` : `Kuwana order ${reference}`,
        });
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        // The order exists; the buyer can retry payment from the order page until it expires
        payment = { status: 'FAILED', message: err.message };
      }
    }
    return { order: await this.getOrder(userId, orderId), payment };
  }

  /** Move a paid / COD-confirmed order into fulfilment and record its money */
  private async confirmOrder(tx: Tx, orderId: string, paymentId: string | null, paymentStatus: 'PAID' | 'COD_PENDING'): Promise<PinNotice> {
    const order = await tx.marketOrder.findUniqueOrThrow({
      where: { id: orderId },
      include: { items: { include: { offer: { select: { leadTimeDays: true, prepTimeMins: true } } } }, shipments: { include: { storeBranch: { select: { operatingHours: true } } } } },
    });
    const now = new Date();
    const pin = randomDigits();
    const pinHash = hashSecret(`pin:${order.reference}`, pin);
    await tx.marketOrder.update({
      where: { id: orderId },
      data: {
        status: 'CONFIRMED', paymentStatus, confirmedAt: now, expiresAt: null, codOtpHash: null,
        collectionPinHash: pinHash,
        ...(order.status === 'AWAITING_DEPOSIT' ? { depositPaidAt: now } : {}),
      },
    });
    const settings = await getMarketSettings();
    const cod = order.paymentMethod === 'CASH';
    for (const sh of order.shipments) {
      const items = order.items.filter((i) => i.shipmentId === sh.id);
      let dispatchBy: Date | null = null;
      let acceptBy: Date | null = null;
      if (sh.storeBranchId) {
        // The store has a few minutes (from opening, if closed) to accept, or the parcel moves on
        acceptBy = acceptDeadline(sh.storeBranch?.operatingHours, settings.storeAcceptSlaMinutes, now);
        // Store must have it packed by (its opening time, if closed, plus) its packing time
        const travelMins = Math.round(Number(sh.distanceKm ?? 0) * 3) + 15;
        dispatchBy = new Date(now.getTime() + Math.max(0, (sh.etaMinutes ?? 0) - travelMins) * 60_000);
      } else if (sh.sourceType === 'SELLER_FULFILLED') {
        dispatchBy = addDays(now, Math.max(0, ...items.map((i) => i.offer.leadTimeDays)));
      }
      await tx.shipment.update({ where: { id: sh.id }, data: { status: 'PROCESSING', dispatchBy, acceptBy } });

      if (sh.storeBranchId) {
        // The run a gig driver will claim once the store has packed it (Phase 3 / 4)
        const parcelValueUsd = items.reduce((sum, i) => sum.plus(i.lineTotalUsd), new Decimal(0));
        const snapshot = order.deliveryAddress as Record<string, unknown>;
        // With a deposit the fees are already paid, so the driver collects only the goods.
        // At a pickup point the agent collects the cash, not the driver.
        const codAmountUsd = !cod || order.deliveryMode === 'PICKUP' ? new Decimal(0)
          : order.depositUsd.gt(0) ? parcelValueUsd : parcelValueUsd.plus(sh.feeUsd);
        await tx.deliveryJob.create({
          data: {
            reference: `DJ-${sh.reference}`,
            shipmentId: sh.id,
            pickupBranchId: sh.storeBranchId,
            dropoffType: order.deliveryMode === 'PICKUP' ? 'PICKUP_POINT' : 'ADDRESS',
            pickupPointId: order.pickupPointId,
            dropoffAddress: order.deliveryAddress as Prisma.InputJsonValue,
            dropoffLat: typeof snapshot.lat === 'number' ? snapshot.lat : null,
            dropoffLng: typeof snapshot.lng === 'number' ? snapshot.lng : null,
            recipientName: order.recipientName,
            recipientPhone: order.recipientPhone,
            vehicleRequired: sh.vehicleClass ?? 'BIKE',
            distanceKm: sh.distanceKm ?? 0,
            customerFeeUsd: sh.feeUsd,
            driverFeeUsd: sh.driverFeeUsd ?? 0,
            parcelValueUsd,
            codAmountUsd,
            // Covers whichever the driver holds at its largest: the goods, or the cash collected for them
            collateralRequiredUsd: collateralFor(Decimal.max(parcelValueUsd, codAmountUsd), settings.collateralBufferPct),
            deliveryOtpHash: pinHash,
          },
        });
      }
    }
    await ledgerService.recordOrderConfirmed(tx, order, paymentId);
    return { orderId: order.id, phone: order.recipientPhone, reference: order.reference, pin, mode: order.deliveryMode };
  }

  /** After confirmation: PIN to the recipient, dispatch reminder to each seller shipping a parcel themselves */
  private async sendPin(n: PinNotice) {
    const where = n.mode === 'PICKUP' ? 'the pickup agent' : 'the driver';
    await this.sendSmsSafely(n.phone, `Kuwana order ${n.reference} is confirmed. Your collection PIN is ${n.pin}. Give it to ${where} only when you receive your parcel.`);
    const parcels = await prisma.shipment.findMany({
      where: { orderId: n.orderId, sourceType: 'SELLER_FULFILLED' },
      select: { id: true, reference: true, dispatchBy: true, storeBranchId: true, seller: { select: { phone: true } } },
    });
    for (const p of parcels) {
      if (p.storeBranchId) {
        // SMS + push to the branch, and the accept-deadline timer
        await storeOrdersService.notifyNewOrder(p.id).catch((err) => logger.error('Store notification failed', { shipmentId: p.id, err: (err as Error).message }));
        continue;
      }
      const to = p.seller?.phone;
      if (!to) continue;
      const by = p.dispatchBy ? ` by ${p.dispatchBy.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Africa/Harare' })}` : '';
      await this.sendSmsSafely(to, `New Kuwana order: parcel ${p.reference} to dispatch${by}. Open the Kuwana seller portal for the address.`);
    }
  }

  private async sendSmsSafely(to: string, body: string) {
    try {
      await sendSms(to, body);
    } catch (err) {
      logger.error('SMS failed', { to, err: (err as Error).message });
    }
  }

  // ── Payment results (registered with the payments service) ──

  async onPaymentSucceeded(paymentId: string, paidAmount?: number) {
    const notice = await prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({ where: { id: paymentId } });
      if (!payment || payment.status === 'SUCCEEDED') return null;
      if (paidAmount !== undefined && Math.abs(paidAmount - payment.amount.toNumber()) > 0.009) {
        logger.error('Market payment amount mismatch — not confirming', { paymentId, expected: payment.amount.toNumber(), paidAmount });
        await tx.payment.update({ where: { id: paymentId }, data: { status: 'FAILED', failureCode: 'amount_mismatch' } });
        return null;
      }
      await tx.payment.update({ where: { id: paymentId }, data: { status: 'SUCCEEDED' } });
      await tx.$queryRaw`SELECT id FROM market_orders WHERE id = ${payment.checkoutRef} FOR UPDATE`;
      const order = await tx.marketOrder.findUnique({ where: { id: payment.checkoutRef } });
      if (!order) return null;
      if (order.status === 'PENDING_PAYMENT') return this.confirmOrder(tx, order.id, payment.id, 'PAID');
      // COD deposit in: the order goes ahead; the goods are paid in cash at the door
      if (order.status === 'AWAITING_DEPOSIT') return this.confirmOrder(tx, order.id, payment.id, 'COD_PENDING');
      if (order.status === 'CANCELLED' && order.paymentStatus !== 'PAID') {
        await tx.marketOrder.update({
          where: { id: order.id },
          data: { paymentStatus: 'PAID', cancelReason: `${order.cancelReason ?? 'Cancelled'} — payment arrived afterwards; refund due` },
        });
        logger.warn('Payment received for a cancelled market order — needs refund', { orderId: order.id, paymentId });
      }
      return null;
    });
    if (notice) await this.sendPin(notice);
  }

  async onPaymentFailed(paymentId: string, failureCode: string) {
    const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment || payment.status === 'SUCCEEDED') return;
    await prisma.$transaction([
      prisma.payment.update({ where: { id: paymentId }, data: { status: 'FAILED', failureCode } }),
      prisma.marketOrder.updateMany({ where: { id: payment.checkoutRef, status: { in: ['PENDING_PAYMENT', 'AWAITING_DEPOSIT'] } }, data: { paymentStatus: 'FAILED' } }),
    ]);
  }

  // ── Cash on delivery confirmation ──────────────────────

  private async ownedOrder(userId: string, orderId: string) {
    const order = await prisma.marketOrder.findUnique({ where: { id: orderId } });
    if (!order || order.userId !== userId) throw new NotFoundError('Order');
    return order;
  }

  async verifyCodOtp(userId: string, orderId: string, code: string) {
    const order = await this.ownedOrder(userId, orderId);
    if (order.status !== 'AWAITING_COD_OTP') throw new BadRequestError('This order does not need a confirmation code');
    if (!order.codOtpExpiresAt || order.codOtpExpiresAt < new Date()) throw new BadRequestError('This code has expired. Request a new one.');
    if (order.codOtpAttempts >= OTP_MAX_ATTEMPTS) throw new BadRequestError('Too many wrong attempts. Request a new code.');
    if (!verifySecret(`cod:${order.reference}`, code, order.codOtpHash)) {
      await prisma.marketOrder.update({ where: { id: orderId }, data: { codOtpAttempts: { increment: 1 } } });
      throw new BadRequestError('That code is incorrect');
    }
    const notice = await prisma.$transaction(async (tx) => {
      const { count } = await tx.marketOrder.updateMany({ where: { id: orderId, status: 'AWAITING_COD_OTP' }, data: { codOtpAttempts: 0 } });
      if (count === 0) throw new BadRequestError('This order has already been confirmed or cancelled');
      return this.confirmOrder(tx, orderId, null, 'COD_PENDING');
    });
    await this.sendPin(notice);
    return this.getOrder(userId, orderId);
  }

  async resendCodOtp(userId: string, orderId: string) {
    const order = await this.ownedOrder(userId, orderId);
    if (order.status !== 'AWAITING_COD_OTP') throw new BadRequestError('This order does not need a confirmation code');
    if (order.codOtpSentAt && Date.now() - order.codOtpSentAt.getTime() < OTP_RESEND_COOLDOWN_MS) {
      throw new AppError('Please wait a minute before requesting another code', 429);
    }
    if (order.expiresAt && order.expiresAt < new Date()) throw new BadRequestError('This order has expired. Place it again.');
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { phone: true } });
    const otp = randomDigits();
    await prisma.marketOrder.update({
      where: { id: orderId },
      data: { codOtpHash: hashSecret(`cod:${order.reference}`, otp), codOtpSentAt: new Date(), codOtpAttempts: 0 },
    });
    await this.sendSmsSafely(user.phone!, `Your Kuwana code to confirm order ${order.reference} is ${otp}.`);
    return this.getOrder(userId, orderId);
  }

  // ── Retry payment / cancel ─────────────────────────────

  async payOrder(userId: string, orderId: string, method: Exclude<PaymentMethod, 'CASH'>, phone?: string) {
    const order = await this.ownedOrder(userId, orderId);
    if (order.status === 'AWAITING_DEPOSIT') return this.payDeposit(userId, order, method, phone);
    if (order.status !== 'PENDING_PAYMENT') throw new BadRequestError('This order does not need payment');
    if (order.expiresAt && order.expiresAt < new Date()) throw new BadRequestError('This order has expired. Place it again.');
    if ((method === 'CARD' || method === 'WALLET') && order.paymentCurrency !== 'USD') {
      throw new BadRequestError(`${method === 'CARD' ? 'Cards are' : 'Wallet credit is'} charged in USD; this order is priced in ZiG`);
    }

    if (method === 'WALLET') {
      const notice = await prisma.$transaction(async (tx) => {
        const { count } = await tx.marketOrder.updateMany({ where: { id: orderId, status: 'PENDING_PAYMENT' }, data: { paymentMethod: 'WALLET' } });
        if (count === 0) throw new BadRequestError('This order does not need payment');
        const payment = await tx.payment.create({
          data: { checkoutRef: orderId, purpose: 'MARKET_ORDER', method: 'WALLET', gateway: 'MANUAL', amount: order.totalUsd, currency: 'USD', status: 'SUCCEEDED' },
        });
        await walletService.debit(tx, { userId, amountUsd: order.totalUsd, orderId, paymentId: payment.id, rate: order.lockedExchangeRate, memo: `Order ${order.reference}` });
        return this.confirmOrder(tx, orderId, payment.id, 'PAID');
      });
      await this.sendPin(notice);
      return { order: await this.getOrder(userId, orderId), payment: { status: 'PAID' as const } };
    }

    const chargePhone = phone ?? order.paymentPhone ?? undefined;
    if (['ECOCASH', 'ONEMONEY', 'INNBUCKS'].includes(method) && !chargePhone) throw new BadRequestError('Enter the mobile number to charge');
    await prisma.marketOrder.update({ where: { id: orderId }, data: { paymentMethod: method, paymentPhone: chargePhone, paymentStatus: 'UNPAID' } });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
    const payment = await paymentsService.startPayment({
      purpose: 'MARKET_ORDER',
      checkoutRef: orderId,
      amount: order.amountDue.toNumber(),
      currency: order.paymentCurrency,
      method,
      phone: chargePhone,
      customerEmail: user.email,
      description: `Kuwana order ${order.reference}`,
    });
    return { order: await this.getOrder(userId, orderId), payment };
  }

  /** Retry the upfront delivery-fee deposit on a COD order */
  private async payDeposit(userId: string, order: Prisma.MarketOrderGetPayload<object>, method: Exclude<PaymentMethod, 'CASH'>, phone?: string) {
    if (!DEPOSIT_METHODS.includes(method)) throw new BadRequestError('Pay the delivery fee deposit with EcoCash or InnBucks');
    if (order.expiresAt && order.expiresAt < new Date()) throw new BadRequestError('This order has expired. Place it again.');
    const chargePhone = phone ?? order.paymentPhone ?? undefined;
    if (!chargePhone) throw new BadRequestError('Enter the mobile number to charge');
    await prisma.marketOrder.update({ where: { id: order.id }, data: { paymentPhone: chargePhone, paymentStatus: 'UNPAID' } });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
    const payment = await paymentsService.startPayment({
      purpose: 'MARKET_ORDER',
      checkoutRef: order.id,
      amount: order.amountDue.toNumber(),
      currency: order.paymentCurrency,
      method,
      phone: chargePhone,
      customerEmail: user.email,
      description: `Kuwana order ${order.reference} delivery fee (cash on delivery)`,
    });
    return { order: await this.getOrder(userId, order.id), payment };
  }

  /**
   * Cancel within a transaction: release reserved stock, cancel shipments, refresh Buy Boxes.
   * `allowed` guards against racing a confirmation.
   */
  private async cancelInTx(tx: Tx, orderId: string, allowed: ('PENDING_PAYMENT' | 'AWAITING_COD_OTP' | 'AWAITING_DEPOSIT' | 'CONFIRMED')[], reason: string) {
    const { count } = await tx.marketOrder.updateMany({
      where: { id: orderId, status: { in: allowed } },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: reason, expiresAt: null, codOtpHash: null },
    });
    if (count === 0) return false;
    const items = await tx.marketOrderItem.findMany({ where: { orderId }, select: { offerId: true, productId: true, quantity: true } });
    for (const item of items) {
      await tx.offer.update({ where: { id: item.offerId }, data: { stockQty: { increment: item.quantity } } });
    }
    await tx.shipment.updateMany({ where: { orderId }, data: { status: 'CANCELLED' } });
    await tx.deliveryJob.updateMany({
      where: { shipment: { orderId }, status: { in: ['AWAITING_STORE', 'OPEN'] } },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: reason },
    });
    for (const productId of [...new Set(items.map((i) => i.productId))].sort()) {
      await buyBoxService.recomputeProduct(productId, tx);
    }
    return true;
  }

  async cancelOrder(userId: string, orderId: string, reason?: string) {
    const order = await this.ownedOrder(userId, orderId);
    const why = reason ? `Cancelled by buyer: ${reason}` : 'Cancelled by buyer';

    if (order.status === 'PENDING_PAYMENT' || order.status === 'AWAITING_COD_OTP' || order.status === 'AWAITING_DEPOSIT') {
      await prisma.$transaction((tx) => this.cancelInTx(tx, orderId, ['PENDING_PAYMENT', 'AWAITING_COD_OTP', 'AWAITING_DEPOSIT'], why));
    } else if (order.status === 'CONFIRMED' && order.paymentStatus === 'COD_PENDING') {
      // No money has changed hands yet; allowed until anything is packed
      await prisma.$transaction(async (tx) => {
        const started = await tx.shipment.count({ where: { orderId, status: { notIn: ['PROCESSING'] } } });
        if (started) throw new BadRequestError('Part of this order is already on its way and can no longer be cancelled');
        if (!(await this.cancelInTx(tx, orderId, ['CONFIRMED'], why))) throw new BadRequestError('This order can no longer be cancelled');
        // A paid delivery-fee deposit is non-refundable: only the (unpaid) goods are reversed
        await ledgerService.reverseOrder(tx, orderId, 'ADJUSTMENT', 'Cash-on-delivery order cancelled before dispatch',
          order.depositUsd.gt(0) ? ['SALE'] : undefined);
      });
    } else if (order.status === 'CONFIRMED') {
      throw new BadRequestError('This order is already paid. Contact support to cancel it and get a refund.');
    } else {
      throw new BadRequestError('This order can no longer be cancelled');
    }
    return this.getOrder(userId, orderId);
  }

  /** Background job: cancel orders whose payment or COD confirmation deadline has passed */
  async expireOverdue(): Promise<number> {
    const overdue = await prisma.marketOrder.findMany({
      where: { status: { in: ['PENDING_PAYMENT', 'AWAITING_COD_OTP', 'AWAITING_DEPOSIT'] }, expiresAt: { lt: new Date() } },
      select: { id: true, status: true },
      take: 100,
    });
    let expired = 0;
    for (const o of overdue) {
      // A payment may have just succeeded without its callback reaching us
      if (o.status !== 'AWAITING_COD_OTP') await paymentsService.pollPendingPayment(o.id);
      const reason = o.status === 'PENDING_PAYMENT' ? 'Not paid in time' : o.status === 'AWAITING_DEPOSIT' ? 'Delivery fee deposit not paid in time' : 'Not confirmed in time';
      const done = await prisma.$transaction((tx) => this.cancelInTx(tx, o.id, [o.status as 'PENDING_PAYMENT' | 'AWAITING_COD_OTP' | 'AWAITING_DEPOSIT'], reason));
      if (done) expired++;
    }
    return expired;
  }

  // ── Reads ──────────────────────────────────────────────

  async getOrder(userId: string, orderId: string, viewerRole?: string) {
    const existing = await prisma.marketOrder.findUnique({ where: { id: orderId }, select: { userId: true, status: true } });
    if (!existing || (existing.userId !== userId && viewerRole !== 'ADMIN')) throw new NotFoundError('Order');
    if (existing.status === 'PENDING_PAYMENT' || existing.status === 'AWAITING_DEPOSIT') await paymentsService.pollPendingPayment(orderId);
    const [order, payment] = await Promise.all([
      prisma.marketOrder.findUniqueOrThrow({ where: { id: orderId }, include: marketOrderInclude }),
      prisma.payment.findFirst({ where: { checkoutRef: orderId, purpose: 'MARKET_ORDER' }, orderBy: { createdAt: 'desc' } }),
    ]);
    return toMarketOrderDto(order, payment);
  }

  async listOrders(userId: string, page: number, limit: number) {
    const where = { userId };
    const [rows, total] = await Promise.all([
      prisma.marketOrder.findMany({ where, include: marketOrderInclude, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      prisma.marketOrder.count({ where }),
    ]);
    return { data: rows.map((o) => toMarketOrderDto(o, null)), total };
  }

}

interface PinNotice {
  orderId: string;
  phone: string;
  reference: string;
  pin: string;
  mode: 'DELIVERY' | 'PICKUP';
}

export const marketCheckoutService = new MarketCheckoutService();

registerPaymentPurpose('MARKET_ORDER', {
  onSucceeded: (paymentId, paidAmount) => marketCheckoutService.onPaymentSucceeded(paymentId, paidAmount),
  onFailed: (paymentId, code) => marketCheckoutService.onPaymentFailed(paymentId, code),
});

export type { Priced };
