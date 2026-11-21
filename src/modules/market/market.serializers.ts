import { Payment, Prisma } from '@prisma/client';
import { money, ratePayload, RateSnapshot, roundMoney, usdToZwg } from '../currency/currency.service';
import { TIER_LABELS } from './pricing';
import type { Priced } from './checkout.service';
import type { QuoteDto } from './market.schema';

const Decimal = Prisma.Decimal;

export function toQuoteDto(p: Priced, dto: QuoteDto) {
  const r = p.rate;
  const lineByOffer = new Map(p.lines.map((l) => [l.offer.id, l]));
  const amountDue = dto.paymentCurrency === 'USD' ? roundMoney(p.totalUsd) : r ? usdToZwg(p.totalUsd, r.rate) : null;

  return {
    lines: p.lines.map((l) => ({
      offerId: l.offer.id,
      productId: l.offer.productId,
      slug: l.offer.product.slug,
      title: l.offer.product.title,
      image: l.offer.product.images[0]?.thumbUrl ?? l.offer.product.images[0]?.url ?? null,
      sellerName: l.offer.seller.businessName,
      isFirstParty: l.offer.seller.isFirstParty,
      fulfilmentType: l.offer.fulfilmentType,
      quantity: l.quantity,
      requestedQuantity: l.requested,
      availableQty: l.offer.stockQty,
      unitPrice: money(l.offer.priceUsd, r),
      lineTotal: money(roundMoney(l.offer.priceUsd.times(l.quantity)), r),
    })),
    issues: p.issues,
    shipments: p.plan.shipments.map((s) => ({
      key: s.key,
      label: s.label,
      sourceType: s.sourceType,
      tier: s.tier,
      tierLabel: s.tier ? TIER_LABELS[s.tier] : null,
      fee: s.feeUsd ? money(s.feeUsd, r) : null,
      baseFee: s.baseFeeUsd ? money(s.baseFeeUsd, r) : null,
      feeWaived: s.feeWaived,
      etaMinDays: s.etaMinDays,
      etaMaxDays: s.etaMaxDays,
      /** Store runs: minutes to the door, the branch, distance and vehicle */
      etaMinutes: s.etaMinutes,
      opensAt: s.opensAt,
      storeBranchId: s.storeBranchId,
      distanceKm: s.distanceKm,
      vehicleClass: s.vehicleClass,
      undeliverable: s.undeliverable,
      weightKg: s.weightKg.toNumber(),
      items: s.lines.map((l) => ({ offerId: l.offerId, title: lineByOffer.get(l.offerId)!.offer.product.title, quantity: l.quantity })),
    })),
    destination: p.dest ? { ...p.dest.city, snapshot: p.dest.snapshot } : null,
    totals: {
      itemsSubtotal: money(p.plan.itemsSubtotalUsd, r),
      delivery: money(p.plan.deliveryFeeUsd, r),
      sellerShipping: money(p.plan.sellerShippingUsd, r),
      codFee: money(p.codFeeUsd, r),
      total: money(p.totalUsd, r),
      /** Cash on delivery: paid upfront now (non-refundable delivery + COD fee) and in cash at the door */
      codDeposit: p.codDeposit ? money(p.codDeposit.depositUsd, r) : null,
      cashOnDelivery: p.codDeposit ? money(p.codDeposit.cashDueUsd, r) : null,
      /** False until a delivery address or pickup point is chosen */
      deliveryPriced: !!p.dest,
    },
    amountDue: amountDue ? { amount: amountDue.toNumber(), currency: dto.paymentCurrency } : null,
    freeDelivery: {
      threshold: money(p.plan.freeDelivery.thresholdUsd, r),
      qualifies: p.plan.freeDelivery.qualifies,
      remaining: money(p.plan.freeDelivery.remainingUsd, r),
    },
    express: p.plan.express,
    cod: p.cod,
    paymentMethods: p.methods,
    isGift: p.isGift,
    exchangeRate: ratePayload(r),
  };
}

export const marketOrderInclude = {
  items: { orderBy: { createdAt: 'asc' }, include: { seller: { select: { businessName: true, isFirstParty: true } } } },
  shipments: {
    orderBy: { sequence: 'asc' },
    include: {
      hub: { select: { name: true, city: { select: { name: true } } } },
      seller: { select: { businessName: true } },
      dispatchCity: { select: { name: true } },
      storeBranch: { select: { name: true, landmark: true, suburb: { select: { name: true } }, city: { select: { name: true } } } },
      deliveryJob: { select: { status: true, reference: true } },
    },
  },
  pickupPoint: { select: { id: true, code: true, name: true, address: true, operatingHours: true } },
  destinationCity: { select: { id: true, name: true, slug: true } },
} satisfies Prisma.MarketOrderInclude;

type OrderWithRelations = Prisma.MarketOrderGetPayload<{ include: typeof marketOrderInclude }>;

const DAY_MS = 24 * 60 * 60 * 1000;

/** "+263771234567" → "+263 77 *** 4567" */
function maskPhone(phone: string) {
  return phone.length > 8 ? `${phone.slice(0, 4)} ${phone.slice(4, 6)} *** ${phone.slice(-4)}` : phone;
}

export function toMarketOrderDto(o: OrderWithRelations, payment: Payment | null) {
  // Every ZiG figure on an order uses the rate locked when it was placed
  const locked: RateSnapshot | null = o.lockedExchangeRate.gt(0)
    ? { id: o.exchangeRateId ?? 'locked', rate: o.lockedExchangeRate, effectiveFrom: o.createdAt }
    : null;
  const m = (usd: Prisma.Decimal) => money(usd, locked);
  const etaBase = o.confirmedAt ?? o.createdAt;
  const meta = (payment?.metadata ?? {}) as { instructions?: string | null; redirectUrl?: string | null };

  return {
    id: o.id,
    reference: o.reference,
    status: o.status,
    paymentStatus: o.paymentStatus,
    paymentMethod: o.paymentMethod,
    paymentCurrency: o.paymentCurrency,
    lockedExchangeRate: o.lockedExchangeRate.toNumber(),
    deliveryMode: o.deliveryMode,
    deliverySpeed: o.deliverySpeed,
    deliveryAddress: o.deliveryAddress,
    destinationCity: o.destinationCity,
    pickupPoint: o.pickupPoint,
    recipient: { name: o.recipientName, phone: maskPhone(o.recipientPhone), isGift: o.isGift },
    totals: {
      itemsSubtotal: m(o.itemsSubtotalUsd),
      delivery: m(o.deliveryFeeUsd),
      sellerShipping: m(o.sellerShippingUsd),
      codFee: m(o.codFeeUsd),
      discount: m(o.discountUsd),
      total: m(o.totalUsd),
      /** Cash on delivery: the upfront deposit and what is paid in cash at the door */
      codDeposit: o.depositUsd.gt(0) ? m(o.depositUsd) : null,
      cashOnDelivery: o.paymentMethod === 'CASH' ? m(o.cashDueUsd) : null,
    },
    depositPaidAt: o.depositPaidAt,
    amountDue: { amount: o.amountDue.toNumber(), currency: o.paymentCurrency },
    freeDeliveryApplied: o.freeDeliveryApplied,
    itemCount: o.items.reduce((n, i) => n + i.quantity, 0),
    shipments: o.shipments.map((s) => ({
      id: s.id,
      reference: s.reference,
      status: s.status,
      tier: s.tier,
      tierLabel: TIER_LABELS[s.tier],
      source: s.sourceType === 'PLATFORM_FULFILLED'
        ? `Kuwana · ${s.hub?.city.name ?? ''} warehouse`
        : s.storeBranch
          ? `${s.seller?.businessName ?? 'Store'} · ${s.storeBranch.suburb?.name ?? s.storeBranch.name}`
          : `${s.seller?.businessName ?? 'Seller'}${s.dispatchCity ? ` · ${s.dispatchCity.name}` : ''}`,
      distanceKm: s.distanceKm?.toNumber() ?? null,
      vehicleClass: s.vehicleClass,
      etaMinutes: s.etaMinutes,
      /** Store runs: expected at the door (from confirmation) */
      estimatedAt: s.etaMinutes !== null && o.confirmedAt ? new Date(o.confirmedAt.getTime() + s.etaMinutes * 60_000) : null,
      deliveryJob: s.deliveryJob,
      sourceType: s.sourceType,
      fee: m(s.feeUsd),
      etaMinDays: s.etaMinDays,
      etaMaxDays: s.etaMaxDays,
      estimatedFrom: new Date(etaBase.getTime() + s.etaMinDays * DAY_MS),
      estimatedTo: new Date(etaBase.getTime() + s.etaMaxDays * DAY_MS),
      dispatchBy: s.dispatchBy,
      items: o.items.filter((i) => i.shipmentId === s.id).map((i) => ({
        id: i.id,
        productId: i.productId,
        title: i.title,
        image: i.imageUrl,
        quantity: i.quantity,
        unitPrice: m(i.unitPriceUsd),
        lineTotal: m(i.lineTotalUsd),
        sellerName: i.seller.businessName,
      })),
    })),
    payment: payment
      ? {
          id: payment.id,
          status: payment.status,
          method: payment.method,
          amount: new Decimal(payment.amount).toNumber(),
          currency: payment.currency,
          instructions: payment.status === 'PROCESSING' ? meta.instructions ?? null : null,
          redirectUrl: payment.status === 'PROCESSING' ? meta.redirectUrl ?? null : null,
        }
      : null,
    codOtp: o.status === 'AWAITING_COD_OTP'
      ? { sentAt: o.codOtpSentAt, resendAvailableAt: o.codOtpSentAt ? new Date(o.codOtpSentAt.getTime() + 60_000) : null }
      : null,
    notes: o.notes,
    expiresAt: o.expiresAt,
    confirmedAt: o.confirmedAt,
    cancelledAt: o.cancelledAt,
    cancelReason: o.cancelReason,
    createdAt: o.createdAt,
  };
}

export type MarketOrderDto = ReturnType<typeof toMarketOrderDto>;
