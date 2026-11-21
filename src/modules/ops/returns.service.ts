import crypto from 'crypto';
import { Prisma, ReturnReason, ReturnStatus } from '@prisma/client';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { sendSms } from '../../lib/sms';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../middleware/error.middleware';
import { roundMoney, usdToZwg } from '../currency/currency.service';
import { buyBoxService } from '../catalog/buybox.service';
import { ledgerService } from '../market/ledger.service';
import { getMarketSettings } from '../market/market.settings';
import { paymentsService } from '../payments/payments.service';
import { StaffContext } from './staff';

const Decimal = Prisma.Decimal;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const reference = () => 'RT-' + Array.from(crypto.randomBytes(6), (b) => ALPHABET[b % ALPHABET.length]).join('');
const DAY_MS = 24 * 60 * 60 * 1000;
/** Reasons that count against the seller unless inspection says otherwise */
const SELLER_FAULT_REASONS: ReturnReason[] = ['DEFECTIVE', 'WRONG_ITEM', 'NOT_AS_DESCRIBED'];
const DISPUTE_WINDOW_DAYS = 90;
/** The only reasons accepted for items in non-returnable categories */
const DELIVERY_FAULT_REASONS: ReturnReason[] = ['WRONG_ITEM', 'DAMAGED_IN_TRANSIT'];
const DISPUTE_MIN_SAMPLE = 10;

const include = {
  items: { include: { orderItem: { select: { id: true, title: true, imageUrl: true, unitPriceUsd: true, quantity: true, fulfilmentType: true, sellerId: true, offerId: true, productId: true } } } },
  order: { select: { id: true, reference: true, paymentMethod: true, paymentCurrency: true, lockedExchangeRate: true, userId: true } },
  pickupPoint: { select: { id: true, name: true, address: true } },
  user: { select: { phone: true, email: true, profile: { select: { fullName: true } } } },
} satisfies Prisma.ReturnRequestInclude;
type ReturnFull = Prisma.ReturnRequestGetPayload<{ include: typeof include }>;

function toDto(r: ReturnFull) {
  return {
    id: r.id,
    reference: r.reference,
    status: r.status,
    reason: r.reason,
    details: r.details,
    method: r.method,
    pickupPoint: r.pickupPoint,
    refundDestination: r.refundDestination,
    refundUsd: r.refundUsd?.toNumber() ?? null,
    refundManual: r.refundManual,
    inspectionNote: r.inspectionNote,
    order: { id: r.order.id, reference: r.order.reference },
    buyer: { name: r.user.profile?.fullName || r.user.email, phone: r.user.phone },
    items: r.items.map((i) => ({
      id: i.id, orderItemId: i.orderItemId, title: i.orderItem.title, image: i.orderItem.imageUrl, quantity: i.quantity,
      unitPriceUsd: i.orderItem.unitPriceUsd.toNumber(), fulfilmentType: i.orderItem.fulfilmentType, resellable: i.resellable,
    })),
    createdAt: r.createdAt,
    droppedOffAt: r.droppedOffAt,
    receivedAt: r.receivedAt,
    resolvedAt: r.resolvedAt,
  };
}

const OPEN: ReturnStatus[] = ['APPROVED', 'DROPPED_OFF', 'RECEIVED', 'REFUNDED'];

async function notify(phone: string | null | undefined, body: string) {
  if (!phone) return;
  await sendSms(phone, body).catch((err) => logger.error('Return SMS failed', { err: (err as Error).message }));
}

/**
 * Book a return refund. STORE: reverse the store's earnings for the items (scaled by `factor` for a
 * partial refund; commission goes back to the store). PLATFORM: Kuwana pays as goodwill and the store keeps
 * its earnings. With toWallet the buyer's wallet is credited with refundUsd.
 */
export async function bookReturnRefund(
  tx: Prisma.TransactionClient,
  r: ReturnFull,
  o: { payer: 'STORE' | 'PLATFORM'; factor: Prisma.Decimal; toWallet: boolean; refundUsd: Prisma.Decimal },
) {
  const rate = r.order.lockedExchangeRate;
  const cur = r.order.paymentCurrency;
  const tx$ = (usd: Prisma.Decimal) => (cur === 'USD' ? usd : usdToZwg(usd, rate));
  if (o.payer === 'STORE') {
    for (const ri of r.items) {
      const oi = await tx.marketOrderItem.findUniqueOrThrow({ where: { id: ri.orderItemId } });
      const share = new Decimal(ri.quantity).dividedBy(oi.quantity);
      const gross = roundMoney(oi.unitPriceUsd.times(ri.quantity).times(o.factor));
      const commission = roundMoney(oi.commissionUsd.times(share).times(o.factor));
      await tx.ledgerEntry.create({
        data: {
          type: 'REFUND', orderId: r.orderId, orderItemId: oi.id, shipmentId: oi.shipmentId, sellerId: oi.sellerId, userId: r.order.userId,
          currency: cur, exchangeRateAtTx: rate, grossUsd: gross.negated(), grossTx: tx$(gross).negated(),
          commissionUsd: commission.negated(), platformRevenueUsd: commission.negated(), sellerNetUsd: gross.minus(commission).negated(),
          memo: `Return ${r.reference}: ${ri.quantity} × ${oi.title}${o.factor.lt(1) ? ' (partial)' : ''}`,
        },
      });
    }
  } else {
    await tx.ledgerEntry.create({
      data: {
        type: 'ADJUSTMENT', orderId: r.orderId, userId: r.order.userId, currency: cur, exchangeRateAtTx: rate,
        grossUsd: 0, grossTx: 0, platformRevenueUsd: o.refundUsd.negated(), memo: `Goodwill refund for return ${r.reference} (paid by Kuwana)`,
      },
    });
  }
  if (o.toWallet && o.refundUsd.gt(0)) {
    await tx.wallet.upsert({ where: { userId: r.order.userId }, update: { balanceUsd: { increment: o.refundUsd } }, create: { userId: r.order.userId, balanceUsd: o.refundUsd } });
    await ledgerService.recordWallet(tx, { userId: r.order.userId, deltaUsd: o.refundUsd, type: 'WALLET_CREDIT', orderId: r.orderId, rate, memo: `Refund for return ${r.reference}` });
  }
}

export const returnIncludeForAdmin = include;
export const returnToDto = toDto;

export const returnsService = {
  /** What the buyer can still return on an order, and the returns already made */
  async forOrder(userId: string, orderId: string) {
    const order = await prisma.marketOrder.findUnique({
      where: { id: orderId },
      include: { items: { include: { shipment: { select: { status: true, deliveredAt: true } }, returnItems: { include: { returnRequest: { select: { status: true } } } } } } },
    });
    if (!order || order.userId !== userId) throw new NotFoundError('Order');
    const { returnWindowDays } = await getMarketSettings();
    const items = order.items.map((i) => {
      const returned = i.returnItems.filter((ri) => OPEN.includes(ri.returnRequest.status)).reduce((n, ri) => n + ri.quantity, 0);
      const delivered = ['DELIVERED', 'COLLECTED'].includes(i.shipment.status) && i.shipment.deliveredAt;
      const deadline = delivered ? new Date(i.shipment.deliveredAt!.getTime() + returnWindowDays * DAY_MS) : null;
      const open = !!deadline && deadline > new Date();
      return {
        orderItemId: i.id, title: i.title, image: i.imageUrl, quantity: i.quantity, unitPriceUsd: i.unitPriceUsd.toNumber(),
        returnableQuantity: open ? Math.max(0, i.quantity - returned) : 0, returnBy: deadline,
        reason: !delivered ? 'Not delivered yet' : !open ? 'Return window has closed' : returned >= i.quantity ? 'Already returned' : null,
      };
    });
    const returns = await prisma.returnRequest.findMany({ where: { orderId }, include, orderBy: { createdAt: 'desc' } });
    return { returnWindowDays, cashOrder: order.paymentMethod === 'CASH', items, returns: returns.map(toDto) };
  },

  async create(userId: string, input: {
    orderId: string; items: { orderItemId: string; quantity: number }[]; reason: ReturnReason; details?: string;
    method: 'DROP_OFF' | 'COURIER_COLLECTION'; pickupPointId?: string; refundDestination: 'WALLET' | 'ORIGINAL';
  }) {
    const eligibility = await this.forOrder(userId, input.orderId);
    for (const want of input.items) {
      const item = eligibility.items.find((i) => i.orderItemId === want.orderItemId);
      if (!item) throw new BadRequestError('That item is not on this order');
      if (want.quantity > item.returnableQuantity) throw new BadRequestError(item.reason ?? `You can return up to ${item.returnableQuantity} of ${item.title}`);
    }
    if (eligibility.cashOrder && input.refundDestination === 'ORIGINAL') {
      throw new BadRequestError('Cash orders are refunded to your Kuwana wallet');
    }
    if (input.method === 'DROP_OFF') {
      const point = input.pickupPointId ? await prisma.pickupPoint.findUnique({ where: { id: input.pickupPointId }, select: { isActive: true } }) : null;
      if (!point?.isActive) throw new BadRequestError('Choose the pickup point where you will drop it off');
    }
    const orderItems = await prisma.marketOrderItem.findMany({
      where: { id: { in: input.items.map((i) => i.orderItemId) } },
      select: { id: true, shipmentId: true, title: true, product: { select: { category: { select: { isReturnable: true } } } } },
    });
    const finalSale = orderItems.find((oi) => !oi.product.category.isReturnable);
    if (finalSale && !DELIVERY_FAULT_REASONS.includes(input.reason)) {
      throw new BadRequestError(`${finalSale.title} can only be returned if you received the wrong item or it arrived damaged`);
    }
    const created = await prisma.returnRequest.create({
      data: {
        reference: reference(), orderId: input.orderId, userId, reason: input.reason, details: input.details,
        method: input.method, pickupPointId: input.method === 'DROP_OFF' ? input.pickupPointId : null,
        refundDestination: input.refundDestination,
        items: { create: input.items.map((i) => ({ orderItemId: i.orderItemId, quantity: i.quantity, shipmentId: orderItems.find((o) => o.id === i.orderItemId)!.shipmentId })) },
      },
      include,
    });
    await notify(created.user.phone, input.method === 'DROP_OFF'
      ? `Return ${created.reference} approved. Write the code on the parcel and drop it at ${created.pickupPoint?.name}.`
      : `Return ${created.reference} approved. Write the code on the parcel; our courier will contact you to collect it.`);
    return toDto(created);
  },

  async cancelByBuyer(userId: string, id: string) {
    const { count } = await prisma.returnRequest.updateMany({ where: { id, userId, status: 'APPROVED' }, data: { status: 'CANCELLED', resolvedAt: new Date() } });
    if (!count) throw new BadRequestError('This return can no longer be cancelled');
    return toDto(await prisma.returnRequest.findUniqueOrThrow({ where: { id }, include }));
  },

  async listMine(userId: string) {
    const rows = await prisma.returnRequest.findMany({ where: { userId }, include, orderBy: { createdAt: 'desc' }, take: 50 });
    return rows.map(toDto);
  },

  // ── Staff ──────────────────────────────────────────────

  async listForStaff(ctx: StaffContext, status?: ReturnStatus) {
    const where: Prisma.ReturnRequestWhereInput = ctx.role === 'PICKUP_AGENT'
      ? { pickupPointId: ctx.pickupPointId, status: status ?? 'APPROVED' }
      : { status: status ?? { in: ['APPROVED', 'DROPPED_OFF', 'RECEIVED'] } };
    const rows = await prisma.returnRequest.findMany({ where, include, orderBy: { createdAt: 'asc' }, take: 200 });
    return rows.map(toDto);
  },

  /** Agent took the parcel at the counter (or the courier collected it) */
  async markDroppedOff(ctx: StaffContext, id: string) {
    const r = await prisma.returnRequest.findUnique({ where: { id } });
    if (!r) throw new NotFoundError('Return');
    if (ctx.role === 'PICKUP_AGENT' && r.pickupPointId !== ctx.pickupPointId) throw new ForbiddenError('This return is for another pickup point');
    const { count } = await prisma.returnRequest.updateMany({ where: { id, status: 'APPROVED' }, data: { status: 'DROPPED_OFF', droppedOffAt: new Date(), handledById: ctx.id } });
    if (!count) throw new BadRequestError('This return is not waiting for drop-off');
    return toDto(await prisma.returnRequest.findUniqueOrThrow({ where: { id }, include }));
  },

  async markReceived(ctx: StaffContext, id: string) {
    const { count } = await prisma.returnRequest.updateMany({
      where: { id, status: { in: ['APPROVED', 'DROPPED_OFF'] } },
      data: { status: 'RECEIVED', receivedAt: new Date(), handledById: ctx.id },
    });
    if (!count) throw new BadRequestError('This return is not on its way to the hub');
    return toDto(await prisma.returnRequest.findUniqueOrThrow({ where: { id }, include }));
  },

  /**
   * Inspect at the hub. Approved: refund the items (wallet instantly, or the original payment), reverse the
   * seller's earnings for them (commission is returned to the seller; the fulfilment fee is kept), restock
   * resellable hub items and update the seller's dispute rate. Rejected: no refund.
   */
  async inspect(ctx: StaffContext, id: string, input: { approve: boolean; note: string; sellerAtFault?: boolean; resellableItemIds?: string[] }) {
    const r = await prisma.returnRequest.findUnique({ where: { id }, include });
    if (!r) throw new NotFoundError('Return');
    if (r.status !== 'RECEIVED') throw new BadRequestError('Mark the return as received before inspecting it');

    if (!input.approve) {
      await prisma.returnRequest.update({ where: { id }, data: { status: 'REJECTED', inspectionNote: input.note, resolvedAt: new Date(), handledById: ctx.id, sellerAtFault: false } });
      await notify(r.user.phone, `Return ${r.reference} did not pass inspection: ${input.note}. Contact Kuwana support if you disagree.`);
      return toDto(await prisma.returnRequest.findUniqueOrThrow({ where: { id }, include }));
    }

    const sellerAtFault = input.sellerAtFault ?? SELLER_FAULT_REASONS.includes(r.reason);
    const resellable = new Set(input.resellableItemIds ?? []);
    const refundUsd = roundMoney(r.items.reduce((sum, i) => sum.plus(i.orderItem.unitPriceUsd.times(i.quantity)), new Decimal(0)));
    const rate = r.order.lockedExchangeRate;
    const toOriginal = r.refundDestination === 'ORIGINAL' && r.order.paymentMethod !== 'CASH' && r.order.paymentMethod !== 'WALLET';

    await prisma.$transaction(async (tx) => {
      const { count } = await tx.returnRequest.updateMany({
        where: { id, status: 'RECEIVED' },
        data: { status: 'REFUNDED', refundUsd, inspectionNote: input.note, sellerAtFault, resolvedAt: new Date(), handledById: ctx.id },
      });
      if (!count) throw new BadRequestError('This return has already been resolved');

      await bookReturnRefund(tx, r, { payer: 'STORE', factor: new Decimal(1), toWallet: !toOriginal, refundUsd });
      for (const ri of r.items) {
        if (resellable.has(ri.id) && ri.orderItem.fulfilmentType === 'PLATFORM_FULFILLED') {
          await tx.returnItem.update({ where: { id: ri.id }, data: { resellable: true } });
          await tx.offer.update({ where: { id: ri.orderItem.offerId }, data: { stockQty: { increment: ri.quantity } } });
        }
      }
    });

    let manual = false;
    if (toOriginal) {
      const amountTx = r.order.paymentCurrency === 'USD' ? refundUsd : usdToZwg(refundUsd, rate);
      try {
        manual = (await paymentsService.refundMarketPayment(r.orderId, amountTx.toNumber(), `Return ${r.reference}`)).manual;
      } catch (err) {
        logger.error('Gateway refund failed; flagged for manual refund', { returnId: id, err: (err as Error).message });
        manual = true;
      }
      if (manual) await prisma.returnRequest.update({ where: { id }, data: { refundManual: true } });
    }

    for (const productId of [...new Set(r.items.filter((i) => resellable.has(i.id)).map((i) => i.orderItem.productId))]) {
      await buyBoxService.recomputeProduct(productId);
    }
    for (const sellerId of new Set(r.items.map((i) => i.orderItem.sellerId))) await this.recomputeDisputeRate(sellerId);

    const where = toOriginal ? (manual ? 'to your original payment method within 5 working days' : 'to your original payment method') : 'to your Kuwana wallet';
    await notify(r.user.phone, `Return ${r.reference} approved. $${refundUsd.toFixed(2)} has been refunded ${where}.`);
    return toDto(await prisma.returnRequest.findUniqueOrThrow({ where: { id }, include }));
  },

  /** Seller dispute rate = units returned for seller-fault reasons ÷ units delivered, over 90 days */
  async recomputeDisputeRate(sellerId: string) {
    const since = new Date(Date.now() - DISPUTE_WINDOW_DAYS * DAY_MS);
    const [delivered, disputed] = await Promise.all([
      prisma.marketOrderItem.aggregate({ where: { sellerId, shipment: { deliveredAt: { gte: since } } }, _sum: { quantity: true } }),
      prisma.returnItem.aggregate({ where: { orderItem: { sellerId }, returnRequest: { status: 'REFUNDED', sellerAtFault: true, resolvedAt: { gte: since } } }, _sum: { quantity: true } }),
    ]);
    const units = delivered._sum.quantity ?? 0;
    if (units < DISPUTE_MIN_SAMPLE) return;
    const rate = new Decimal(((disputed._sum.quantity ?? 0) * 100) / units).toDecimalPlaces(2);
    const seller = await prisma.sellerProfile.findUniqueOrThrow({ where: { id: sellerId }, select: { disputeRate: true } });
    if (seller.disputeRate.equals(rate)) return;
    await prisma.sellerProfile.update({ where: { id: sellerId }, data: { disputeRate: rate } });
    await buyBoxService.recomputeForSeller(sellerId);
  },
};
