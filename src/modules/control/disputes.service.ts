import { Prisma, ReturnStatus } from '@prisma/client';
import { z } from 'zod';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { sendSms } from '../../lib/sms';
import { BadRequestError, NotFoundError } from '../../middleware/error.middleware';
import { roundMoney } from '../currency/currency.service';
import { buyBoxService } from '../catalog/buybox.service';
import { bookReturnRefund, returnIncludeForAdmin, returnsService, returnToDto } from '../ops/returns.service';

/**
 * Dispute board: admins settle returns in one step (refund from the store's escrow, Kuwana goodwill, or
 * reject) and freeze store payouts while something is being looked into.
 */

const Decimal = Prisma.Decimal;

export const resolveSchema = z
  .object({
    outcome: z.enum(['REFUND', 'REJECT']),
    /** REFUND only: who funds it */
    payer: z.enum(['STORE', 'PLATFORM']).optional(),
    /** REFUND only: defaults to the full item value; less = partial refund */
    amountUsd: z.number().positive().max(100_000).multipleOf(0.01).optional(),
    sellerAtFault: z.boolean().optional(),
    /** The item is back at the store in sellable condition: put it back in stock */
    restock: z.boolean().default(false),
    /** Lift the order's payout hold once settled */
    releaseHold: z.boolean().default(true),
    note: z.string().trim().min(3).max(500),
  })
  .refine((v) => v.outcome === 'REJECT' || !!v.payer, { message: 'Choose who pays the refund', path: ['payer'] });

export const holdSchema = z.object({ reason: z.string().trim().min(3).max(300).nullable() });

const OPEN_STATUSES: ReturnStatus[] = ['APPROVED', 'DROPPED_OFF', 'RECEIVED'];

async function notify(phone: string | null | undefined, body: string) {
  if (phone) await sendSms(phone, body).catch((err) => logger.error('Dispute SMS failed', { err: (err as Error).message }));
}

export const disputesService = {
  /** Open returns (default) or every return in a status, with the store and hold state */
  async list(status?: ReturnStatus | 'OPEN') {
    const rows = await prisma.returnRequest.findMany({
      where: { status: !status || status === 'OPEN' ? { in: OPEN_STATUSES } : status },
      include: { ...returnIncludeForAdmin, order: { select: { ...returnIncludeForAdmin.order.select, payoutHoldAt: true, payoutHoldReason: true } } },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    const sellerIds = [...new Set(rows.flatMap((r) => r.items.map((i) => i.orderItem.sellerId)).filter(Boolean))] as string[];
    const sellers = await prisma.sellerProfile.findMany({ where: { id: { in: sellerIds } }, select: { id: true, businessName: true, disputeRate: true, payoutHoldAt: true } });
    const byId = new Map(sellers.map((s) => [s.id, s]));
    return rows.map((r) => {
      const fullValue = r.items.reduce((sum, i) => sum + i.orderItem.unitPriceUsd.toNumber() * i.quantity, 0);
      const stores = [...new Set(r.items.map((i) => i.orderItem.sellerId))].map((id) => byId.get(id!)).filter(Boolean).map((s) => ({
        id: s!.id, name: s!.businessName, disputeRate: s!.disputeRate.toNumber(), payoutsHeld: !!s!.payoutHoldAt,
      }));
      return {
        ...returnToDto(r),
        fullValueUsd: Math.round(fullValue * 100) / 100,
        refundPaidBy: r.refundPaidBy,
        orderPayoutHold: r.order.payoutHoldAt ? { at: r.order.payoutHoldAt, reason: r.order.payoutHoldReason } : null,
        stores,
      };
    });
  },

  /** Settle a return in one step, whatever its physical state */
  async resolve(adminId: string, returnId: string, input: z.infer<typeof resolveSchema>) {
    const r = await prisma.returnRequest.findUnique({ where: { id: returnId }, include: returnIncludeForAdmin });
    if (!r) throw new NotFoundError('Return');
    if (![...OPEN_STATUSES, 'REJECTED'].includes(r.status)) throw new BadRequestError('This return is already settled');

    if (input.outcome === 'REJECT') {
      if (r.status === 'REJECTED') throw new BadRequestError('This return is already rejected');
      await prisma.returnRequest.update({ where: { id: returnId }, data: { status: 'REJECTED', inspectionNote: input.note, sellerAtFault: false, resolvedAt: new Date(), handledById: adminId } });
      if (input.releaseHold) await prisma.marketOrder.update({ where: { id: r.orderId }, data: { payoutHoldAt: null, payoutHoldReason: null } });
      await notify(r.user.phone, `Kuwana return ${r.reference} was declined: ${input.note}`);
      return (await this.list('REJECTED')).find((x) => x.id === returnId) ?? null;
    }

    const fullUsd = roundMoney(r.items.reduce((sum, i) => sum.plus(i.orderItem.unitPriceUsd.times(i.quantity)), new Decimal(0)));
    const refundUsd = input.amountUsd !== undefined ? roundMoney(input.amountUsd) : fullUsd;
    if (refundUsd.gt(fullUsd)) throw new BadRequestError(`The most you can refund for these items is $${fullUsd.toFixed(2)}`);
    const payer = input.payer!;
    const sellerAtFault = payer === 'STORE' ? input.sellerAtFault ?? ['DEFECTIVE', 'WRONG_ITEM', 'NOT_AS_DESCRIBED'].includes(r.reason) : false;

    await prisma.$transaction(async (tx) => {
      const { count } = await tx.returnRequest.updateMany({
        where: { id: returnId, status: r.status },
        data: { status: 'REFUNDED', refundUsd, refundPaidBy: payer, inspectionNote: input.note, sellerAtFault, resolvedAt: new Date(), handledById: adminId },
      });
      if (!count) throw new BadRequestError('This return changed while you were looking at it; reload');
      await bookReturnRefund(tx, r, { payer, factor: fullUsd.isZero() ? new Decimal(1) : refundUsd.dividedBy(fullUsd), toWallet: true, refundUsd });
      if (input.restock) {
        for (const ri of r.items) {
          await tx.returnItem.update({ where: { id: ri.id }, data: { resellable: true } });
          await tx.offer.update({ where: { id: ri.orderItem.offerId }, data: { stockQty: { increment: ri.quantity } } });
        }
      }
      if (input.releaseHold) await tx.marketOrder.update({ where: { id: r.orderId }, data: { payoutHoldAt: null, payoutHoldReason: null } });
    });

    if (input.restock) for (const pid of new Set(r.items.map((i) => i.orderItem.productId))) await buyBoxService.recomputeProduct(pid);
    if (payer === 'STORE') for (const sid of new Set(r.items.map((i) => i.orderItem.sellerId))) if (sid) await returnsService.recomputeDisputeRate(sid);
    await notify(r.user.phone, `Kuwana return ${r.reference}: $${refundUsd.toFixed(2)} has been refunded to your Kuwana wallet.`);
    return (await this.list('REFUNDED')).find((x) => x.id === returnId) ?? null;
  },

  /** Freeze (reason) or release (null) one order's store earnings */
  async holdOrder(orderId: string, reason: string | null) {
    const order = await prisma.marketOrder.findUnique({ where: { id: orderId }, select: { id: true } });
    if (!order) throw new NotFoundError('Order');
    const o = await prisma.marketOrder.update({
      where: { id: orderId },
      data: reason ? { payoutHoldAt: new Date(), payoutHoldReason: reason } : { payoutHoldAt: null, payoutHoldReason: null },
      select: { id: true, reference: true, payoutHoldAt: true, payoutHoldReason: true },
    });
    return { id: o.id, reference: o.reference, held: !!o.payoutHoldAt, reason: o.payoutHoldReason };
  },

  /** Freeze (reason) or release (null) all payouts for a store */
  async holdSeller(sellerId: string, reason: string | null) {
    const seller = await prisma.sellerProfile.findUnique({ where: { id: sellerId }, select: { id: true, phone: true, businessName: true } });
    if (!seller) throw new NotFoundError('Store');
    const s = await prisma.sellerProfile.update({
      where: { id: sellerId },
      data: reason ? { payoutHoldAt: new Date(), payoutHoldReason: reason } : { payoutHoldAt: null, payoutHoldReason: null },
      select: { id: true, businessName: true, payoutHoldAt: true, payoutHoldReason: true },
    });
    await notify(seller.phone, reason ? `Kuwana: payouts for ${seller.businessName} are on hold: ${reason}.` : `Kuwana: payouts for ${seller.businessName} are open again.`);
    return { id: s.id, name: s.businessName, held: !!s.payoutHoldAt, reason: s.payoutHoldReason };
  },
};
