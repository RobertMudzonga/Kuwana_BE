import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { sendSms } from '../../lib/sms';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../middleware/error.middleware';
import { roundMoney, zwgToUsd } from '../currency/currency.service';
import { buyBoxService } from '../catalog/buybox.service';
import { ledgerService } from '../market/ledger.service';
import { getMarketSettings } from '../market/market.settings';
import { assertCollectionPin, codAmountsByShipment, settleOrderIfDone } from '../market/handover';
import { opsShipmentInclude, toOpsShipmentDto } from './hub.service';
import { StaffContext } from './staff';

type Tx = Prisma.TransactionClient;
const Decimal = Prisma.Decimal;
const TRUST_UP = 5;
const TRUST_DOWN_REFUSED = 15;

export type FailReason = 'NOT_HOME' | 'REFUSED' | 'WRONG_ADDRESS' | 'OTHER';

async function load(id: string) {
  const s = await prisma.shipment.findUnique({ where: { id }, include: opsShipmentInclude });
  if (!s || !s.order.confirmedAt) throw new NotFoundError('Shipment');
  return s;
}

async function adjustTrust(tx: Tx, orderId: string, delta: number) {
  const { userId } = await tx.marketOrder.findUniqueOrThrow({ where: { id: orderId }, select: { userId: true } });
  // Clamp to 0–100 in SQL so concurrent updates can't escape the range
  await tx.$executeRaw`UPDATE users SET cod_trust_score = LEAST(100, GREATEST(0, cod_trust_score + ${delta}::int)) WHERE id = ${userId}`;
}

/** Who may hand over this parcel, and in what state it must be */
function assertCanHandOver(ctx: StaffContext, s: Awaited<ReturnType<typeof load>>) {
  if (ctx.role === 'DRIVER') {
    if (s.driverId !== ctx.id) throw new ForbiddenError('This parcel is assigned to another driver');
    if (s.status !== 'OUT_FOR_DELIVERY') throw new BadRequestError('This parcel is not out for delivery');
    return;
  }
  if (ctx.role === 'PICKUP_AGENT') {
    if (s.order.pickupPoint?.id !== ctx.pickupPointId) throw new ForbiddenError('This parcel is for another pickup point');
    if (s.status !== 'READY_FOR_COLLECTION') throw new BadRequestError('Mark the parcel as arrived before handing it over');
    return;
  }
  // Hub staff / admin: courier deliveries confirmed remotely, or covering for a driver or agent
  if (ctx.role === 'WAREHOUSE' && s.hubId !== ctx.hubId) throw new ForbiddenError('This parcel belongs to another hub');
  if (!['OUT_FOR_DELIVERY', 'DISPATCHED', 'READY_FOR_COLLECTION'].includes(s.status)) throw new BadRequestError('This parcel is not out for delivery');
}

export const handoverService = {
  /**
   * Complete a handover with the recipient's PIN. For cash orders the collector records what they took;
   * it is reconciled at the hub later. Successful cash deliveries raise the buyer's COD trust score.
   */
  async handOver(ctx: StaffContext, id: string, input: { pin: string; cashCollected?: number }) {
    const s = await load(id);
    assertCanHandOver(ctx, s);
    const cod = s.order.paymentMethod === 'CASH';
    if (cod && (input.cashCollected === undefined || input.cashCollected < 0)) throw new BadRequestError('Enter the cash you collected');
    await assertCollectionPin(s.order.id, input.pin);

    const pickup = s.order.deliveryMode === 'PICKUP';
    await prisma.$transaction(async (tx) => {
      const { count } = await tx.shipment.updateMany({
        where: { id, status: { in: ['OUT_FOR_DELIVERY', 'DISPATCHED', 'READY_FOR_COLLECTION'] } },
        data: { status: pickup ? 'COLLECTED' : 'DELIVERED', deliveredAt: new Date(), handedOverById: ctx.id },
      });
      if (!count) throw new BadRequestError('This parcel has already been handed over');

      if (cod) {
        const expected = (await codAmountsByShipment(tx, s.order.id)).get(id) ?? new Decimal(0);
        const collected = roundMoney(input.cashCollected!);
        const order = await tx.marketOrder.findUniqueOrThrow({ where: { id: s.order.id }, select: { paymentCurrency: true, lockedExchangeRate: true, userId: true } });
        await tx.codRemittance.create({
          data: {
            shipmentId: id, orderId: s.order.id, collectorId: ctx.id, currency: order.paymentCurrency,
            expectedAmount: expected, collectedAmount: collected,
            note: collected.equals(expected) ? null : `Collected ${collected.toFixed(2)} of ${expected.toFixed(2)}`,
          },
        });
        const collectedUsd = order.paymentCurrency === 'USD' ? collected : zwgToUsd(collected, order.lockedExchangeRate);
        await tx.ledgerEntry.create({
          data: {
            type: 'COD_COLLECTED', orderId: s.order.id, shipmentId: id, userId: order.userId,
            currency: order.paymentCurrency, exchangeRateAtTx: order.lockedExchangeRate,
            grossUsd: collectedUsd, grossTx: collected, codStatus: 'COLLECTED', memo: `Cash collected for ${s.reference}`,
          },
        });
        await adjustTrust(tx, s.order.id, TRUST_UP);
      }
      // The pickup point's per-parcel fee is a Kuwana delivery cost, owed to the agent
      if (pickup && s.order.pickupPoint) {
        const point = await tx.pickupPoint.findUnique({ where: { id: s.order.pickupPoint.id }, select: { code: true, agentFeeUsd: true } });
        if (point && point.agentFeeUsd.gt(0)) {
          const order = await tx.marketOrder.findUniqueOrThrow({ where: { id: s.order.id }, select: { paymentCurrency: true, lockedExchangeRate: true, userId: true } });
          await tx.ledgerEntry.create({
            data: {
              type: 'ADJUSTMENT', orderId: s.order.id, shipmentId: id, userId: order.userId, currency: order.paymentCurrency,
              exchangeRateAtTx: order.lockedExchangeRate, grossUsd: 0, grossTx: 0, platformRevenueUsd: point.agentFeeUsd.negated(),
              memo: `Pickup agent fee ${point.code} for ${s.reference}`,
            },
          });
        }
      }
      await settleOrderIfDone(tx, s.order.id);
    });
    return toOpsShipmentDto(await load(id));
  },

  /**
   * Record a failed home delivery. The parcel goes back to the hub queue for another attempt; after the
   * last allowed attempt, or if the buyer refused it, it is returned to stock and its money reversed.
   */
  async fail(ctx: StaffContext, id: string, input: { reason: FailReason; note?: string }) {
    const s = await load(id);
    if (ctx.role === 'DRIVER' && s.driverId !== ctx.id) throw new ForbiddenError('This parcel is assigned to another driver');
    if (ctx.role === 'WAREHOUSE' && s.hubId !== ctx.hubId) throw new ForbiddenError('This parcel belongs to another hub');
    if (ctx.role === 'PICKUP_AGENT') throw new ForbiddenError('Pickup agents cannot fail deliveries');
    if (s.sourceType !== 'PLATFORM_FULFILLED' || !['OUT_FOR_DELIVERY', 'DISPATCHED'].includes(s.status)) {
      throw new BadRequestError('Only parcels on the road can be marked as failed');
    }
    const { maxDeliveryAttempts } = await getMarketSettings();
    const attempts = s.deliveryAttempts + 1;
    const giveUp = input.reason === 'REFUSED' || attempts >= maxDeliveryAttempts;
    const note = `Attempt ${attempts}: ${input.reason.replace('_', ' ').toLowerCase()}${input.note ? ` — ${input.note}` : ''}`;
    const cod = s.order.paymentMethod === 'CASH';

    const refundUsd = await prisma.$transaction(async (tx) => {
      const { count } = await tx.shipment.updateMany({
        where: { id, status: { in: ['OUT_FOR_DELIVERY', 'DISPATCHED'] } },
        data: giveUp
          ? { status: 'RETURNED', deliveryAttempts: attempts, lastAttemptNote: note, driverId: null }
          : { status: 'PACKED', deliveryAttempts: attempts, lastAttemptNote: note, driverId: null, outForDeliveryAt: null },
      });
      if (!count) throw new BadRequestError('This parcel has already been updated');
      if (cod && input.reason === 'REFUSED') await adjustTrust(tx, s.order.id, -TRUST_DOWN_REFUSED);
      if (!giveUp) return null;
      return this.returnToStock(tx, id, cod);
    });

    if (refundUsd) {
      // The wallet belongs to the buyer, who may not be the recipient (gifts)
      const buyer = await prisma.marketOrder.findUniqueOrThrow({ where: { id: s.order.id }, select: { user: { select: { phone: true } } } });
      if (buyer.user.phone) {
        await sendSms(buyer.user.phone, `We couldn't deliver Kuwana parcel ${s.reference}. $${refundUsd.toFixed(2)} has been added to your Kuwana wallet.`)
          .catch((err) => logger.error('Return SMS failed', { err: (err as Error).message }));
      }
    }
    return toOpsShipmentDto(await load(id));
  },

  /** Undeliverable parcel: restock, reverse its money, and credit a prepaid buyer's wallet */
  async returnToStock(tx: Tx, shipmentId: string, cod: boolean): Promise<Prisma.Decimal | null> {
    const sh = await tx.shipment.findUniqueOrThrow({ where: { id: shipmentId }, include: { items: true, order: true } });
    for (const item of sh.items) {
      await tx.offer.update({ where: { id: item.offerId }, data: { stockQty: { increment: item.quantity } } });
    }
    // Reverse this parcel's recorded money with opposite entries
    const entries = await tx.ledgerEntry.findMany({ where: { shipmentId, type: { in: ['SALE', 'SHIPPING_FEE'] } } });
    if (entries.length) {
      await tx.ledgerEntry.createMany({
        data: entries.map((e) => ({
          type: 'ADJUSTMENT' as const, orderId: e.orderId, orderItemId: e.orderItemId, shipmentId: e.shipmentId, sellerId: e.sellerId, userId: e.userId,
          currency: e.currency, exchangeRateAtTx: e.exchangeRateAtTx, grossUsd: e.grossUsd.negated(), grossTx: e.grossTx.negated(),
          commissionUsd: e.commissionUsd.negated(), fulfilmentFeeUsd: e.fulfilmentFeeUsd.negated(), platformRevenueUsd: e.platformRevenueUsd.negated(),
          sellerNetUsd: e.sellerNetUsd.negated(), codStatus: e.codStatus, memo: `Undeliverable ${sh.reference} (reverses ${e.type.toLowerCase()})`,
        })),
      });
    }
    // The COD fee is collected with the first parcel; if that parcel never arrives, the fee was never paid
    if (cod && sh.sequence === 1) {
      const fees = await tx.ledgerEntry.findMany({ where: { orderId: sh.orderId, type: 'COD_FEE' } });
      if (fees.length) {
        await tx.ledgerEntry.createMany({
          data: fees.map((e) => ({
            type: 'ADJUSTMENT' as const, orderId: e.orderId, userId: e.userId, currency: e.currency, exchangeRateAtTx: e.exchangeRateAtTx,
            grossUsd: e.grossUsd.negated(), grossTx: e.grossTx.negated(), platformRevenueUsd: e.platformRevenueUsd.negated(),
            codStatus: e.codStatus, memo: `COD fee not collected: ${sh.reference} undeliverable`,
          })),
        });
      }
    }
    for (const productId of [...new Set(sh.items.map((i) => i.productId))].sort()) await buyBoxService.recomputeProduct(productId, tx);

    let refundUsd: Prisma.Decimal | null = null;
    if (!cod && sh.order.paymentStatus === 'PAID') {
      refundUsd = sh.items.reduce((sum, i) => sum.plus(i.lineTotalUsd), new Decimal(0)).plus(sh.feeUsd);
      await tx.wallet.upsert({ where: { userId: sh.order.userId }, update: { balanceUsd: { increment: refundUsd } }, create: { userId: sh.order.userId, balanceUsd: refundUsd } });
      await ledgerService.recordWallet(tx, { userId: sh.order.userId, deltaUsd: refundUsd, type: 'WALLET_CREDIT', orderId: sh.orderId, rate: sh.order.lockedExchangeRate, memo: `Refund for undelivered ${sh.reference}` });
    }
    await settleOrderIfDone(tx, sh.orderId);
    return refundUsd;
  },

  // ── Drivers ────────────────────────────────────────────

  async driverShipments(ctx: StaffContext) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const rows = await prisma.shipment.findMany({
      where: {
        OR: [
          { driverId: ctx.id, status: 'OUT_FOR_DELIVERY' },
          { handedOverById: ctx.id, deliveredAt: { gte: since } },
        ],
      },
      include: opsShipmentInclude,
      orderBy: { outForDeliveryAt: 'asc' },
    });
    return Promise.all(rows.map(toOpsShipmentDto));
  },

  // ── Pickup agents ──────────────────────────────────────

  async pickupShipments(ctx: StaffContext) {
    const since = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const rows = await prisma.shipment.findMany({
      where: {
        order: { pickupPointId: ctx.pickupPointId!, confirmedAt: { not: null } },
        OR: [{ status: { in: ['DISPATCHED', 'READY_FOR_COLLECTION'] } }, { status: 'COLLECTED', deliveredAt: { gte: since } }],
      },
      include: opsShipmentInclude,
      orderBy: { dispatchedAt: 'asc' },
    });
    return Promise.all(rows.map(toOpsShipmentDto));
  },

  /** Parcel reached the pickup point: tell the recipient to come with their PIN */
  async markArrived(ctx: StaffContext, id: string) {
    const s = await load(id);
    if (ctx.role === 'PICKUP_AGENT' && s.order.pickupPoint?.id !== ctx.pickupPointId) throw new ForbiddenError('This parcel is for another pickup point');
    if (s.order.deliveryMode !== 'PICKUP') throw new BadRequestError('This parcel is a home delivery');
    const { count } = await prisma.shipment.updateMany({ where: { id, status: 'DISPATCHED' }, data: { status: 'READY_FOR_COLLECTION', readyForCollectionAt: new Date() } });
    if (!count) throw new BadRequestError('This parcel is not on its way to the pickup point');
    const due = s.order.paymentMethod === 'CASH' ? (await codAmountsByShipment(prisma, s.order.id)).get(id) : null;
    const cash = due ? ` Bring ${s.order.paymentCurrency === 'USD' ? `$${due.toFixed(2)}` : `ZiG ${due.toFixed(2)}`} cash.` : '';
    await sendSms(s.order.recipientPhone, `Your Kuwana parcel ${s.reference} is ready to collect at ${s.order.pickupPoint?.name}.${cash} Bring your collection PIN.`)
      .catch((err) => logger.error('Arrival SMS failed', { err: (err as Error).message }));
    return toOpsShipmentDto(await load(id));
  },
};
