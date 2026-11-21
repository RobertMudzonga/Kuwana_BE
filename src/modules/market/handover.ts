import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { verifySecret } from '../../lib/secrets';
import { BadRequestError } from '../../middleware/error.middleware';
import { roundMoney, usdToZwg } from '../currency/currency.service';

type Tx = Prisma.TransactionClient;
const Decimal = Prisma.Decimal;
export const PIN_MAX_ATTEMPTS = 5;

/**
 * Check the recipient's collection PIN for an order. Wrong entries are counted;
 * after PIN_MAX_ATTEMPTS the order needs support to release the parcel.
 */
export async function assertCollectionPin(orderId: string, pin: string) {
  const order = await prisma.marketOrder.findUniqueOrThrow({ where: { id: orderId }, select: { reference: true, collectionPinHash: true, pinAttempts: true } });
  if (order.pinAttempts >= PIN_MAX_ATTEMPTS) throw new BadRequestError('Too many wrong PINs. Contact Kuwana support to release this parcel.');
  if (!verifySecret(`pin:${order.reference}`, pin, order.collectionPinHash)) {
    await prisma.marketOrder.update({ where: { id: orderId }, data: { pinAttempts: { increment: 1 } } });
    throw new BadRequestError('That PIN is incorrect. Ask the recipient for the PIN from their SMS.');
  }
}

/**
 * Settle the order once no parcel is still moving:
 * any delivered → COMPLETED (and a cash order becomes PAID once every parcel's cash is in);
 * none delivered (all cancelled or returned) → CANCELLED.
 */
export async function settleOrderIfDone(tx: Tx, orderId: string) {
  const shipments = await tx.shipment.findMany({ where: { orderId }, select: { status: true } });
  const finished = shipments.every((s) => ['DELIVERED', 'COLLECTED', 'CANCELLED', 'RETURNED'].includes(s.status));
  if (!finished) return;
  const delivered = shipments.some((s) => s.status === 'DELIVERED' || s.status === 'COLLECTED');
  const order = await tx.marketOrder.findUniqueOrThrow({ where: { id: orderId }, select: { status: true, paymentStatus: true } });
  if (order.status !== 'CONFIRMED') return;
  if (delivered) {
    await tx.marketOrder.update({
      where: { id: orderId },
      data: { status: 'COMPLETED', ...(order.paymentStatus === 'COD_PENDING' ? { paymentStatus: 'PAID' } : {}) },
    });
  } else {
    await tx.marketOrder.update({ where: { id: orderId }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: 'Could not be delivered' } });
  }
}

/**
 * What the driver or agent should collect for each parcel of a cash order, in the order's currency.
 * Each parcel carries its items and delivery fee; the COD fee rides on the first parcel.
 * Amounts are rounded cumulatively so the parcels always add up exactly to what the buyer owes.
 */
export async function codAmountsByShipment(db: Tx | typeof prisma, orderId: string): Promise<Map<string, Prisma.Decimal>> {
  const order = await db.marketOrder.findUniqueOrThrow({
    where: { id: orderId },
    include: { shipments: { orderBy: { sequence: 'asc' }, include: { items: { select: { lineTotalUsd: true } } } } },
  });
  const inCurrency = (usd: Prisma.Decimal) => (order.paymentCurrency === 'USD' ? roundMoney(usd) : usdToZwg(usd, order.lockedExchangeRate));
  const result = new Map<string, Prisma.Decimal>();
  let cumulativeUsd = new Decimal(0);
  let previous = new Decimal(0);
  order.shipments.forEach((s, i) => {
    const goods = s.items.reduce((sum, it) => sum.plus(it.lineTotalUsd), new Decimal(0));
    // With a deposit, delivery and COD fees were paid upfront: only the goods are collected
    const usd = order.depositUsd.gt(0) ? goods : goods.plus(s.feeUsd).plus(i === 0 ? order.codFeeUsd : 0);
    cumulativeUsd = cumulativeUsd.plus(usd);
    const upTo = inCurrency(cumulativeUsd);
    result.set(s.id, upTo.minus(previous));
    previous = upTo;
  });
  return result;
}
