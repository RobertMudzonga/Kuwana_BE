import { Prisma, ShipmentStatus, StoreOrderEventType } from '@prisma/client';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { sendSms } from '../../lib/sms';
import { sendPushToUsers } from '../../lib/push';
import { derivedPin, hashSecret } from '../../lib/secrets';
import { haversineDistanceKm } from '../../lib/geo';
import { isOpenAt, nextOpening } from '../../lib/opening-hours';
import { BadRequestError, NotFoundError } from '../../middleware/error.middleware';
import { roundMoney } from '../currency/currency.service';
import { buyBoxService, getDeliveryPricing } from '../catalog/buybox.service';
import { moveWallet } from '../drivers/driver-wallet';
import { quoteRun, storeEtaMinutes } from '../delivery/fees';
import { getMarketSettings } from '../market/market.settings';
import { ledgerService } from '../market/ledger.service';
import { settleOrderIfDone } from '../market/handover';
import { StoreContext } from './store.context';

type Tx = Prisma.TransactionClient;
const Decimal = Prisma.Decimal;

/** SLA needs a few outcomes before it moves away from the starting score */
const SLA_MIN_SAMPLE = 5;
const SLA_WINDOW = 50;

export type StoreStage = 'NEW' | 'PREPARING' | 'READY' | 'OUT_FOR_DELIVERY' | 'RETURNING' | 'DELIVERED' | 'CANCELLED';

const TABS: Record<string, Prisma.ShipmentWhereInput> = {
  new: { status: 'PROCESSING', acceptedAt: null },
  preparing: { status: 'PROCESSING', acceptedAt: { not: null } },
  // Packed and waiting for / with a driver at the counter, or coming back after a failed delivery
  ready: { OR: [{ status: 'PACKED' }, { deliveryJob: { status: 'RETURNING' } }] },
  history: { status: { in: ['DISPATCHED', 'OUT_FOR_DELIVERY', 'READY_FOR_COLLECTION', 'DELIVERED', 'COLLECTED', 'CANCELLED', 'RETURNED'] } },
};
export type StoreTab = keyof typeof TABS;

const include = {
  order: { select: { id: true, reference: true, status: true, deliveryMode: true, deliveryAddress: true, recipientName: true, notes: true, confirmedAt: true } },
  items: { select: { id: true, title: true, sku: true, quantity: true, unitPriceUsd: true, lineTotalUsd: true, sellerNetUsd: true, offer: { select: { sellerSku: true } } } },
  storeBranch: { select: { id: true, code: true, name: true } },
  deliveryJob: {
    select: {
      id: true, reference: true, status: true, claimedAt: true, pickedUpAt: true, failReason: true,
      driver: { select: { vehicleClass: true, vehicleReg: true, user: { select: { profile: { select: { fullName: true } } } } } },
    },
  },
} satisfies Prisma.ShipmentInclude;

type StoreShipment = Prisma.ShipmentGetPayload<{ include: typeof include }>;

function stageOf(status: ShipmentStatus, acceptedAt: Date | null): StoreStage {
  if (status === 'PROCESSING') return acceptedAt ? 'PREPARING' : 'NEW';
  if (status === 'PACKED') return 'READY';
  if (['DISPATCHED', 'OUT_FOR_DELIVERY', 'READY_FOR_COLLECTION'].includes(status)) return 'OUT_FOR_DELIVERY';
  if (status === 'DELIVERED' || status === 'COLLECTED') return 'DELIVERED';
  return 'CANCELLED';
}

/** The 4-digit code the store reads to the driver at handover */
export function pickupPinFor(jobId: string) {
  return derivedPin(`pickup:${jobId}`);
}

function toDto(s: StoreShipment) {
  const stage = stageOf(s.status, s.acceptedAt);
  const addr = s.order.deliveryAddress as Record<string, unknown>;
  const job = s.deliveryJob;
  // The PIN is shown while the parcel waits for (or is with) the driver at the counter
  const showPin = stage === 'READY' && job && ['OPEN', 'CLAIMED'].includes(job.status);
  const returning = job?.status === 'RETURNING';
  return {
    id: s.id,
    reference: s.reference,
    stage: returning ? ('RETURNING' as const) : stage,
    status: s.status,
    branch: s.storeBranch,
    acceptBy: s.acceptBy,
    acceptedAt: s.acceptedAt,
    /** Pack by (feeds the store's SLA score) */
    readyBy: s.dispatchBy,
    packedAt: s.packedAt,
    overdue: (stage === 'NEW' && !!s.acceptBy && s.acceptBy < new Date()) || (stage === 'PREPARING' && !!s.dispatchBy && s.dispatchBy < new Date()),
    reassigned: s.reassignCount > 0,
    order: {
      id: s.order.id,
      reference: s.order.reference,
      deliveryMode: s.order.deliveryMode,
      // Stores pack; drivers deliver. They only need a first name and the area.
      recipientFirstName: s.order.recipientName.split(' ')[0],
      area: [addr.suburb, addr.city].filter(Boolean).join(', '),
      pickupPointName: s.order.deliveryMode === 'PICKUP' ? (addr.name as string) : null,
      notes: s.order.notes,
      confirmedAt: s.order.confirmedAt,
    },
    distanceKm: s.distanceKm?.toNumber() ?? null,
    vehicleClass: s.vehicleClass,
    items: s.items.map((i) => ({
      id: i.id, title: i.title, sku: i.sku, sellerSku: i.offer.sellerSku, quantity: i.quantity,
      unitPriceUsd: i.unitPriceUsd.toNumber(), lineTotalUsd: i.lineTotalUsd.toNumber(), sellerNetUsd: i.sellerNetUsd.toNumber(),
    })),
    earningsUsd: s.items.reduce((sum, i) => sum.plus(i.sellerNetUsd), new Decimal(0)).toNumber(),
    deliveryJob: job
      ? {
          reference: job.reference,
          status: job.status,
          pickupPin: showPin ? pickupPinFor(job.id) : null,
          driver: job.driver
            ? { name: job.driver.user.profile?.fullName ?? 'Driver', vehicleClass: job.driver.vehicleClass, vehicleReg: job.driver.vehicleReg }
            : null,
          claimedAt: job.claimedAt,
          pickedUpAt: job.pickedUpAt,
          failReason: job.failReason,
        }
      : null,
  };
}

export type StoreOrderDto = ReturnType<typeof toDto>;

/** Users to notify about a branch's orders: the owner and that branch's staff */
async function branchAudience(branchId: string) {
  const b = await prisma.storeBranch.findUniqueOrThrow({
    where: { id: branchId },
    select: { name: true, phone: true, seller: { select: { userId: true, phone: true } }, staff: { where: { status: 'ACTIVE' }, select: { id: true } } },
  });
  return { name: b.name, phone: b.phone ?? b.seller.phone, userIds: [b.seller.userId, ...b.staff.map((u) => u.id)] };
}

async function safeSms(to: string | null | undefined, body: string) {
  if (!to) return;
  try {
    await sendSms(to, body);
  } catch (err) {
    logger.error('SMS failed', { to, err: (err as Error).message });
  }
}

/** When a store must accept by: SLA minutes from now, or from opening time if it is closed */
export function acceptDeadline(operatingHours: unknown, slaMinutes: number, now = new Date()) {
  const start = isOpenAt(operatingHours, now) ? now : nextOpening(operatingHours, now) ?? now;
  return new Date(start.getTime() + slaMinutes * 60_000);
}

interface Replacement {
  branch: { id: string; sellerId: string; cityId: string; name: string; operatingHours: unknown };
  offers: Map<string, { id: string; prepTimeMins: number }>;
  distanceKm: number;
  driverFeeUsd: Prisma.Decimal;
  etaMinutes: number;
  openNow: boolean;
}

export const storeOrdersService = {
  async list(ctx: StoreContext, tab: StoreTab, branchId?: string) {
    const branchIds = branchId ? ctx.branchIds.filter((b) => b === branchId) : ctx.branchIds;
    const rows = await prisma.shipment.findMany({
      where: {
        storeBranchId: { in: branchIds },
        order: { status: { in: ['CONFIRMED', 'COMPLETED', 'CANCELLED'] }, confirmedAt: { not: null } },
        ...TABS[tab],
      },
      include,
      orderBy: tab === 'history' ? [{ updatedAt: 'desc' }] : tab === 'new' ? [{ acceptBy: 'asc' }] : [{ dispatchBy: 'asc' }],
      take: tab === 'history' ? 100 : 200,
    });
    return rows.map(toDto);
  },

  async counts(ctx: StoreContext) {
    const base = { storeBranchId: { in: ctx.branchIds }, order: { status: 'CONFIRMED' as const } };
    const [fresh, preparing, ready] = await Promise.all([
      prisma.shipment.count({ where: { ...base, ...TABS.new } }),
      prisma.shipment.count({ where: { ...base, ...TABS.preparing } }),
      prisma.shipment.count({ where: { ...base, ...TABS.ready } }),
    ]);
    return { new: fresh, preparing, ready };
  },

  async owned(ctx: StoreContext, id: string) {
    const s = await prisma.shipment.findUnique({ where: { id }, include });
    if (!s || !s.storeBranchId || !ctx.branchIds.includes(s.storeBranchId) || !s.order.confirmedAt) throw new NotFoundError('Order');
    return s;
  },

  async get(ctx: StoreContext, id: string) {
    return toDto(await this.owned(ctx, id));
  },

  async accept(ctx: StoreContext, id: string) {
    const s = await this.owned(ctx, id);
    const now = new Date();
    const { count } = await prisma.shipment.updateMany({
      where: { id, status: 'PROCESSING', acceptedAt: null, order: { status: 'CONFIRMED' } },
      data: { acceptedAt: now, acceptedById: ctx.userId },
    });
    if (!count) throw new BadRequestError('This order has already been accepted, moved or cancelled');
    await prisma.storeOrderEvent.create({
      data: { shipmentId: id, sellerId: s.sellerId!, branchId: s.storeBranchId!, type: 'ACCEPTED', onTime: !s.acceptBy || now <= s.acceptBy, actorId: ctx.userId },
    });
    return this.get(ctx, id);
  },

  /**
   * Packed: the parcel joins the driver queue and the store gets the pickup PIN to give the driver.
   * Packing by the deadline counts toward the store's SLA score.
   */
  async ready(ctx: StoreContext, id: string) {
    const s = await this.owned(ctx, id);
    if (!s.deliveryJob) throw new BadRequestError('This order has no delivery job');
    const now = new Date();
    const onTime = !s.dispatchBy || now <= s.dispatchBy;
    await prisma.$transaction(async (tx) => {
      const { count } = await tx.shipment.updateMany({
        where: { id, status: 'PROCESSING', order: { status: 'CONFIRMED' } },
        data: { status: 'PACKED', packedAt: now, dispatchedOnTime: onTime, acceptedAt: s.acceptedAt ?? now, acceptedById: s.acceptedById ?? ctx.userId },
      });
      if (!count) throw new BadRequestError('Only orders being prepared can be marked ready');
      await tx.deliveryJob.update({
        where: { id: s.deliveryJob!.id },
        data: { status: 'OPEN', broadcastAt: now, pickupPinHash: hashSecret(`pickup:${s.deliveryJob!.id}`, pickupPinFor(s.deliveryJob!.id)) },
      });
      await tx.storeOrderEvent.create({ data: { shipmentId: id, sellerId: s.sellerId!, branchId: s.storeBranchId!, type: 'READY', onTime, actorId: ctx.userId } });
    });
    await this.recomputeSla(s.sellerId!);
    const { enqueue } = await import('../../lib/jobs');
    const { JOBS } = await import('../../jobs');
    await enqueue(JOBS.deliveryBroadcast, { jobId: s.deliveryJob.id, round: 0 }, { jobId: `broadcast-${s.deliveryJob.id}-0-${now.getTime()}` })
      .catch((err) => logger.error('Could not broadcast job', { jobId: s.deliveryJob!.id, err: (err as Error).message }));
    return this.get(ctx, id);
  },

  /** A driver brought back a parcel they couldn't deliver */
  async receivedBack(ctx: StoreContext, id: string) {
    await this.owned(ctx, id);
    const { driverJobsService } = await import('../drivers/driver-jobs.service');
    const result = await driverJobsService.receivedBackAtStore(id, ctx.branchIds);
    return { ...(await this.get(ctx, id)), refundUsd: result.refundUsd };
  },

  /** The store can't fill it: try another store, otherwise refund the buyer */
  async outOfStock(ctx: StoreContext, id: string, note?: string) {
    const s = await this.owned(ctx, id);
    if (s.status !== 'PROCESSING') throw new BadRequestError('Only orders not yet packed can be declined');
    const result = await this.handleStoreFailure(id, 'OUT_OF_STOCK', ctx.userId, note);
    return result;
  },

  /** Background: a store that didn't accept in time loses the order */
  async timeoutIfUnaccepted(shipmentId: string) {
    const s = await prisma.shipment.findUnique({ where: { id: shipmentId }, select: { status: true, acceptedAt: true, acceptBy: true, storeBranchId: true, order: { select: { status: true } } } });
    if (!s?.storeBranchId || s.status !== 'PROCESSING' || s.acceptedAt || !s.acceptBy || s.acceptBy > new Date() || s.order.status !== 'CONFIRMED') return null;
    return this.handleStoreFailure(shipmentId, 'TIMED_OUT');
  },

  /** Background sweep in case a timer was lost (restart without Redis) */
  async sweepOverdue(): Promise<number> {
    const overdue = await prisma.shipment.findMany({
      where: { storeBranchId: { not: null }, status: 'PROCESSING', acceptedAt: null, acceptBy: { lt: new Date() }, order: { status: 'CONFIRMED' } },
      select: { id: true },
      take: 50,
    });
    let n = 0;
    for (const o of overdue) {
      try {
        if (await this.timeoutIfUnaccepted(o.id)) n++;
      } catch (err) {
        logger.error('Store SLA timeout failed', { shipmentId: o.id, err: (err as Error).message });
      }
    }
    return n;
  },

  /**
   * A store failed a parcel (timeout or out of stock). Move it to the best other branch that has every
   * item at the same or a lower price and can deliver to the buyer; if none can, cancel the parcel and
   * refund the buyer's wallet. Either way the failing store's SLA score takes the hit.
   */
  async handleStoreFailure(shipmentId: string, type: 'TIMED_OUT' | 'OUT_OF_STOCK', actorId?: string, note?: string) {
    const outcome = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM shipments WHERE id = ${shipmentId} FOR UPDATE`;
      const sh = await tx.shipment.findUniqueOrThrow({
        where: { id: shipmentId },
        include: { items: { include: { offer: { select: { productId: true } } } }, order: true, deliveryJob: true },
      });
      if (sh.status !== 'PROCESSING' || !sh.storeBranchId || !sh.sellerId) throw new BadRequestError('This order has already been packed, moved or cancelled');
      const failedBranchId = sh.storeBranchId;
      const failedSellerId = sh.sellerId;

      await tx.storeOrderEvent.create({ data: { shipmentId, sellerId: failedSellerId, branchId: failedBranchId, type, note, actorId } });

      // The failing store's reserved stock: it says it has none, or it simply didn't respond
      for (const item of sh.items) {
        await tx.offer.update({
          where: { id: item.offerId },
          data: type === 'OUT_OF_STOCK' ? { stockQty: 0 } : { stockQty: { increment: item.quantity } },
        });
      }

      const failed = await tx.storeOrderEvent.findMany({ where: { shipmentId, type: { in: ['TIMED_OUT', 'OUT_OF_STOCK'] } }, select: { branchId: true } });
      const replacement = await findReplacement(tx, sh, [...new Set(failed.map((f) => f.branchId))]);
      const productIds = [...new Set(sh.items.map((i) => i.productId))].sort();

      if (replacement) {
        await moveShipment(tx, sh, replacement);
        for (const pid of productIds) await buyBoxService.recomputeProduct(pid, tx);
        return { outcome: 'REASSIGNED' as const, failedSellerId, newBranchId: replacement.branch.id, orderId: sh.orderId, reference: sh.reference, buyerId: sh.order.userId, refundUsd: null };
      }
      const refundUsd = await cancelShipmentAndRefund(tx, sh, type === 'TIMED_OUT' ? 'Store did not accept in time' : 'Out of stock at the store');
      for (const pid of productIds) await buyBoxService.recomputeProduct(pid, tx);
      return { outcome: 'REFUNDED' as const, failedSellerId, newBranchId: null, orderId: sh.orderId, reference: sh.reference, buyerId: sh.order.userId, refundUsd };
    });

    await this.recomputeSla(outcome.failedSellerId);
    const buyer = await prisma.user.findUnique({ where: { id: outcome.buyerId }, select: { phone: true } });
    if (outcome.outcome === 'REASSIGNED') {
      await this.notifyNewOrder(shipmentId);
      await safeSms(buyer?.phone, `Kuwana parcel ${outcome.reference}: the first store couldn't fill it, so another store nearby is preparing it now. No change to your price.`);
    } else {
      const money = outcome.refundUsd && outcome.refundUsd.gt(0) ? ` $${outcome.refundUsd.toFixed(2)} has been added to your Kuwana wallet.` : '';
      await safeSms(buyer?.phone, `Sorry, no store could fill Kuwana parcel ${outcome.reference}, so it has been cancelled.${money}`);
    }
    return { outcome: outcome.outcome, refundUsd: outcome.refundUsd?.toNumber() ?? null };
  },

  /**
   * Admin override: move a parcel that hasn't left the store to another branch (a chosen one, or the best
   * available), without an SLA penalty for the old store. A driver who claimed it is released first.
   */
  async adminReassign(shipmentId: string, adminId: string, input: { branchId?: string; note?: string }) {
    const outcome = await prisma.$transaction(async (tx) => {
      await lockShipment(tx, shipmentId);
      const sh = await tx.shipment.findUniqueOrThrow({
        where: { id: shipmentId },
        include: { items: { include: { offer: { select: { productId: true } } } }, order: true, deliveryJob: true },
      });
      if (!sh.storeBranchId || !sh.sellerId) throw new BadRequestError('Only store parcels can be reassigned');
      if (!['PROCESSING', 'PACKED'].includes(sh.status) || sh.order.status !== 'CONFIRMED') throw new BadRequestError('This parcel has already left the store or was cancelled');
      const job = sh.deliveryJob;
      if (job && !['AWAITING_STORE', 'OPEN', 'CLAIMED'].includes(job.status)) throw new BadRequestError('The driver already has this parcel');
      if (input.branchId === sh.storeBranchId) throw new BadRequestError('The parcel is already at that branch');

      if (job?.status === 'CLAIMED' && job.driverId) await releaseDriver(tx, job, 'Store changed by Kuwana');
      const replacement = await findReplacement(tx, sh, [sh.storeBranchId], input.branchId);
      if (!replacement) {
        throw new BadRequestError(input.branchId
          ? 'That branch can’t take it: it needs every item in stock at or below the price paid, and must be within delivery range'
          : 'No other branch has every item in stock at or below the price paid and within range');
      }
      await tx.storeOrderEvent.create({ data: { shipmentId, sellerId: sh.sellerId, branchId: sh.storeBranchId, type: 'MOVED_BY_ADMIN', note: input.note, actorId: adminId } });
      for (const item of sh.items) await tx.offer.update({ where: { id: item.offerId }, data: { stockQty: { increment: item.quantity } } });
      await moveShipment(tx, sh, replacement);
      if (sh.status === 'PACKED') await tx.shipment.update({ where: { id: sh.id }, data: { status: 'PROCESSING' } });
      if (job) await tx.deliveryJob.update({ where: { id: job.id }, data: { pickupPinHash: null } });
      for (const pid of [...new Set(sh.items.map((i) => i.productId))].sort()) await buyBoxService.recomputeProduct(pid, tx);
      return { reference: sh.reference, buyerId: sh.order.userId, branchId: replacement.branch.id, branchName: replacement.branch.name };
    });
    await this.notifyNewOrder(shipmentId);
    const buyer = await prisma.user.findUnique({ where: { id: outcome.buyerId }, select: { phone: true } });
    await safeSms(buyer?.phone, `Kuwana parcel ${outcome.reference} is now being prepared by another store nearby. No change to your price.`);
    return { outcome: 'REASSIGNED' as const, branch: { id: outcome.branchId, name: outcome.branchName } };
  },

  /** Admin override: cancel a parcel that is still at the store and refund the buyer's wallet */
  async adminCancel(shipmentId: string, adminId: string, reason: string) {
    const outcome = await prisma.$transaction(async (tx) => {
      await lockShipment(tx, shipmentId);
      const sh = await tx.shipment.findUniqueOrThrow({
        where: { id: shipmentId },
        include: { items: { include: { offer: { select: { productId: true } } } }, order: true, deliveryJob: true },
      });
      if (!sh.storeBranchId) throw new BadRequestError('Only store parcels can be cancelled here');
      if (!['PROCESSING', 'PACKED'].includes(sh.status)) throw new BadRequestError('Only parcels still at the store can be cancelled; failed deliveries come back through the store');
      const job = sh.deliveryJob;
      if (job && !['AWAITING_STORE', 'OPEN', 'CLAIMED'].includes(job.status)) throw new BadRequestError('The driver already has this parcel');
      if (job?.status === 'CLAIMED' && job.driverId) await releaseDriver(tx, job, 'Parcel cancelled by Kuwana');
      for (const item of sh.items) await tx.offer.update({ where: { id: item.offerId }, data: { stockQty: { increment: item.quantity } } });
      const refund = await cancelShipmentAndRefund(tx, sh, `Cancelled by Kuwana: ${reason}`);
      for (const pid of [...new Set(sh.items.map((i) => i.productId))].sort()) await buyBoxService.recomputeProduct(pid, tx);
      return { reference: sh.reference, buyerId: sh.order.userId, refund };
    });
    const buyer = await prisma.user.findUnique({ where: { id: outcome.buyerId }, select: { phone: true } });
    const money = outcome.refund.gt(0) ? ` $${outcome.refund.toFixed(2)} has been added to your Kuwana wallet.` : '';
    await safeSms(buyer?.phone, `Kuwana parcel ${outcome.reference} has been cancelled: ${reason}.${money}`);
    logger.info('Parcel cancelled by admin', { shipmentId, adminId });
    return { outcome: 'CANCELLED' as const, refundUsd: outcome.refund.toNumber() };
  },

  /** Tell a branch about a new (or reassigned) parcel and start its accept timer */
  async notifyNewOrder(shipmentId: string) {
    const sh = await prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId }, select: { reference: true, storeBranchId: true, acceptBy: true, reassignCount: true, orderId: true } });
    if (!sh.storeBranchId) return;
    const who = await branchAudience(sh.storeBranchId);
    const by = sh.acceptBy ? sh.acceptBy.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Harare' }) : null;
    const body = `NEW ORDER for ${who.name}: parcel ${sh.reference}.${by ? ` Accept by ${by}` : ''}; a Kuwana driver will collect. Open the Kuwana store portal.`;
    await safeSms(who.phone, body);
    await sendPushToUsers(who.userIds, { title: `New order · ${who.name}`, body: `Parcel ${sh.reference}${by ? ` · accept by ${by}` : ''}`, data: { type: 'NEW_ORDER', orderId: sh.orderId } });
    if (sh.acceptBy) {
      // Lazy import: the jobs registry imports this service
      const { enqueue } = await import('../../lib/jobs');
      const { JOBS } = await import('../../jobs');
      await enqueue(JOBS.storeAcceptTimeout, { shipmentId }, {
        delayMs: Math.max(0, sh.acceptBy.getTime() - Date.now()) + 1000,
        jobId: `accept-${shipmentId}-${sh.reassignCount}`,
      }).catch((err) => logger.error('Could not schedule store SLA timer', { shipmentId, err: (err as Error).message }));
    }
  },

  /**
   * Store SLA score: % of recent outcomes that were packed on time. Timeouts, out-of-stock and late
   * packing all count against it. Refreshes the store's Buy Boxes when it changes.
   */
  async recomputeSla(sellerId: string) {
    const recent = await prisma.storeOrderEvent.findMany({
      where: { sellerId, type: { in: ['READY', 'TIMED_OUT', 'OUT_OF_STOCK'] } },
      orderBy: { createdAt: 'desc' },
      take: SLA_WINDOW,
      select: { type: true, onTime: true },
    });
    if (recent.length < SLA_MIN_SAMPLE) return;
    const good = recent.filter((r) => r.type === 'READY' && r.onTime).length;
    const score = new Decimal((good * 100) / recent.length).toDecimalPlaces(2);
    const seller = await prisma.sellerProfile.findUniqueOrThrow({ where: { id: sellerId }, select: { slaScore: true } });
    if (seller.slaScore.equals(score)) return;
    await prisma.sellerProfile.update({ where: { id: sellerId }, data: { slaScore: score } });
    logger.info('Store SLA score updated', { sellerId, from: seller.slaScore.toNumber(), to: score.toNumber() });
    await buyBoxService.recomputeForSeller(sellerId);
  },

  /** Recent outcomes for the store's performance card */
  async performance(ctx: StoreContext) {
    const since = new Date(Date.now() - 30 * 86_400_000);
    const rows = await prisma.storeOrderEvent.groupBy({
      by: ['type'],
      where: { sellerId: ctx.sellerId, createdAt: { gte: since }, branchId: { in: ctx.branchIds } },
      _count: true,
    });
    const late = await prisma.storeOrderEvent.count({ where: { sellerId: ctx.sellerId, createdAt: { gte: since }, branchId: { in: ctx.branchIds }, type: 'READY', onTime: false } });
    const by = Object.fromEntries(rows.map((r) => [r.type, r._count])) as Partial<Record<StoreOrderEventType, number>>;
    const seller = await prisma.sellerProfile.findUniqueOrThrow({ where: { id: ctx.sellerId }, select: { slaScore: true } });
    return {
      slaScore: seller.slaScore.toNumber(),
      last30Days: { accepted: by.ACCEPTED ?? 0, ready: by.READY ?? 0, readyLate: late, timedOut: by.TIMED_OUT ?? 0, outOfStock: by.OUT_OF_STOCK ?? 0, reassignedIn: by.REASSIGNED_IN ?? 0 },
    };
  },
};

type FailingShipment = Prisma.ShipmentGetPayload<{ include: { items: { include: { offer: { select: { productId: true } } } }; order: true; deliveryJob: true } }>;

async function findReplacement(tx: Tx, sh: FailingShipment, excludeBranchIds: string[], onlyBranchId?: string): Promise<Replacement | null> {
  const snap = sh.order.deliveryAddress as Record<string, unknown>;
  if (typeof snap.lat !== 'number' || typeof snap.lng !== 'number') return null;
  const drop = { lat: snap.lat, lng: snap.lng };
  const [settings, { bands, zones }] = await Promise.all([getMarketSettings(), getDeliveryPricing()]);
  const destSuburbId = typeof snap.suburbId === 'string' ? snap.suburbId : null;
  const need = new Map<string, { quantity: number; maxPrice: Prisma.Decimal }>();
  for (const i of sh.items) need.set(i.productId, { quantity: i.quantity, maxPrice: i.unitPriceUsd });

  const offers = await tx.offer.findMany({
    where: {
      productId: { in: [...need.keys()] },
      isActive: true,
      fulfilmentType: 'SELLER_FULFILLED',
      storeBranchId: onlyBranchId ? { equals: onlyBranchId, notIn: excludeBranchIds } : { notIn: excludeBranchIds },
      seller: { kycStatus: 'APPROVED' },
      storeBranch: { isActive: true, isPaused: false },
    },
    include: { storeBranch: { select: { id: true, sellerId: true, cityId: true, suburbId: true, name: true, lat: true, lng: true, operatingHours: true } } },
  });

  const byBranch = new Map<string, typeof offers>();
  for (const o of offers) {
    const n = need.get(o.productId)!;
    if (o.stockQty < n.quantity || o.priceUsd.gt(n.maxPrice) || !o.storeBranch) continue;
    byBranch.set(o.storeBranch.id, [...(byBranch.get(o.storeBranch.id) ?? []), o]);
  }

  const now = new Date();
  const keep = sh.order.deliveryMode === 'PICKUP' ? new Decimal(100).minus(settings.pickupPointDiscountPct).dividedBy(100) : new Decimal(1);
  const candidates: (Replacement & { totalPrice: Prisma.Decimal })[] = [];
  for (const list of byBranch.values()) {
    const chosen = new Map<string, (typeof offers)[number]>();
    for (const o of list) {
      const prev = chosen.get(o.productId);
      if (!prev || o.priceUsd.lt(prev.priceUsd)) chosen.set(o.productId, o);
    }
    if (chosen.size !== need.size) continue; // must fill the whole parcel
    const b = list[0].storeBranch!;
    const distanceKm = Math.round(haversineDistanceKm({ lat: b.lat, lng: b.lng }, drop) * 100) / 100;
    const quote = quoteRun(bands, sh.vehicleClass ?? 'BIKE', distanceKm, settings.maxDeliveryRadiusKm.toNumber(), {
      table: zones,
      ends: { originSuburbId: b.suburbId, destinationSuburbId: destSuburbId },
    });
    if (!quote) continue;
    const openNow = isOpenAt(b.operatingHours, now);
    const prep = Math.max(...[...chosen.values()].map((o) => o.prepTimeMins));
    const opensAt = openNow ? null : nextOpening(b.operatingHours, now);
    const wait = opensAt ? Math.round((opensAt.getTime() - now.getTime()) / 60_000) : 0;
    candidates.push({
      branch: { id: b.id, sellerId: b.sellerId, cityId: b.cityId, name: b.name, operatingHours: b.operatingHours },
      offers: new Map([...chosen.entries()].map(([pid, o]) => [pid, { id: o.id, prepTimeMins: o.prepTimeMins }])),
      distanceKm,
      driverFeeUsd: roundMoney(quote.driverFeeUsd.times(keep)),
      etaMinutes: wait + storeEtaMinutes(prep, distanceKm),
      openNow,
      totalPrice: [...chosen.values()].reduce((sum, o) => sum.plus(o.priceUsd.times(need.get(o.productId)!.quantity)), new Decimal(0)),
    });
  }
  candidates.sort((a, b) => Number(b.openNow) - Number(a.openNow) || a.totalPrice.comparedTo(b.totalPrice) || a.distanceKm - b.distanceKm);
  return candidates[0] ?? null;
}

/** Row lock so concurrent overrides and store actions on one parcel run one at a time */
async function lockShipment(tx: Tx, shipmentId: string) {
  await tx.$queryRaw(Prisma.sql`SELECT id FROM shipments WHERE id = ${shipmentId} FOR UPDATE`);
}

/** Take a claimed (not yet collected) job off its driver: unlock the collateral and tell them */
async function releaseDriver(
  tx: Tx,
  job: { id: string; reference: string; driverId: string | null; shipmentId: string; collateralRequiredUsd: Prisma.Decimal },
  why: string,
) {
  if (!job.driverId) return;
  await moveWallet(tx, job.driverId, 'COLLATERAL_RELEASE', { available: job.collateralRequiredUsd, locked: job.collateralRequiredUsd.negated() }, { jobId: job.id, memo: `${why}: ${job.reference}` });
  await tx.deliveryJob.update({ where: { id: job.id }, data: { status: 'AWAITING_STORE', driverId: null, claimedAt: null } });
  await tx.shipment.update({ where: { id: job.shipmentId }, data: { driverId: null } });
  const driver = await tx.driverProfile.findUnique({ where: { id: job.driverId }, select: { user: { select: { phone: true } } } });
  const phone = driver?.user.phone;
  if (phone) setImmediate(() => { void safeSms(phone, `Kuwana: job ${job.reference} was taken off you (${why}). Your float is unlocked; don't go to the store.`); });
}

/** Move a parcel (stock, order lines, money, delivery job) to the replacement branch */
async function moveShipment(tx: Tx, sh: FailingShipment, r: Replacement) {
  const settings = await getMarketSettings();
  const oldSellerId = sh.sellerId!;
  for (const item of sh.items) {
    const offer = r.offers.get(item.productId)!;
    const { count } = await tx.offer.updateMany({ where: { id: offer.id, stockQty: { gte: item.quantity } }, data: { stockQty: { decrement: item.quantity } } });
    if (!count) throw new BadRequestError('Stock changed while reassigning; try again');
    await tx.marketOrderItem.update({ where: { id: item.id }, data: { offerId: offer.id, sellerId: r.branch.sellerId } });

    // Earnings move with the line: net out the old store, book the sale to the new one at what the buyer paid
    const entries = await tx.ledgerEntry.findMany({ where: { orderItemId: item.id, sellerId: oldSellerId } });
    if (entries.length) {
      const sum = (k: 'grossUsd' | 'grossTx' | 'commissionUsd' | 'fulfilmentFeeUsd' | 'platformRevenueUsd' | 'sellerNetUsd') =>
        entries.reduce((acc, e) => acc.plus(e[k]), new Decimal(0));
      const base = entries[0];
      await tx.ledgerEntry.create({
        data: {
          type: 'ADJUSTMENT', orderId: base.orderId, orderItemId: item.id, shipmentId: sh.id, sellerId: oldSellerId, userId: base.userId,
          currency: base.currency, exchangeRateAtTx: base.exchangeRateAtTx, codStatus: base.codStatus,
          grossUsd: sum('grossUsd').negated(), grossTx: sum('grossTx').negated(), commissionUsd: sum('commissionUsd').negated(),
          fulfilmentFeeUsd: sum('fulfilmentFeeUsd').negated(), platformRevenueUsd: sum('platformRevenueUsd').negated(), sellerNetUsd: sum('sellerNetUsd').negated(),
          memo: `Reassigned ${sh.reference} to another store`,
        },
      });
      await tx.ledgerEntry.create({
        data: {
          type: 'SALE', orderId: base.orderId, orderItemId: item.id, shipmentId: sh.id, sellerId: r.branch.sellerId, userId: base.userId,
          currency: base.currency, exchangeRateAtTx: base.exchangeRateAtTx, codStatus: base.codStatus,
          grossUsd: item.lineTotalUsd, grossTx: base.currency === 'USD' ? item.lineTotalUsd : sum('grossTx'),
          commissionUsd: item.commissionUsd, fulfilmentFeeUsd: item.fulfilmentFeeUsd,
          platformRevenueUsd: item.commissionUsd.plus(item.fulfilmentFeeUsd), sellerNetUsd: item.sellerNetUsd,
          memo: `${item.quantity} × ${item.title} (reassigned)`,
        },
      });
    }
  }

  // The buyer's delivery fee is fixed; a different driver fee changes Kuwana's margin
  const oldDriverFee = sh.driverFeeUsd ?? new Decimal(0);
  const delta = oldDriverFee.minus(r.driverFeeUsd);
  if (!delta.isZero()) {
    await tx.ledgerEntry.create({
      data: {
        type: 'ADJUSTMENT', orderId: sh.orderId, shipmentId: sh.id, userId: sh.order.userId, currency: sh.order.paymentCurrency,
        exchangeRateAtTx: sh.order.lockedExchangeRate, grossUsd: 0, grossTx: 0, platformRevenueUsd: delta,
        memo: `Driver fee ${oldDriverFee.toFixed(2)} → ${r.driverFeeUsd.toFixed(2)} after reassigning ${sh.reference}`,
      },
    });
  }

  const now = new Date();
  const travel = Math.round(r.distanceKm * 3) + 15;
  await tx.shipment.update({
    where: { id: sh.id },
    data: {
      storeBranchId: r.branch.id,
      sellerId: r.branch.sellerId,
      dispatchCityId: r.branch.cityId,
      distanceKm: r.distanceKm,
      driverFeeUsd: r.driverFeeUsd,
      etaMinutes: r.etaMinutes,
      acceptBy: acceptDeadline(r.branch.operatingHours, settings.storeAcceptSlaMinutes, now),
      acceptedAt: null,
      acceptedById: null,
      dispatchBy: new Date(now.getTime() + Math.max(0, r.etaMinutes - travel) * 60_000),
      reassignCount: { increment: 1 },
    },
  });
  if (sh.deliveryJob) {
    await tx.deliveryJob.update({
      where: { id: sh.deliveryJob.id },
      data: { pickupBranchId: r.branch.id, driverFeeUsd: r.driverFeeUsd, distanceKm: r.distanceKm, status: 'AWAITING_STORE' },
    });
  }
  await tx.storeOrderEvent.create({ data: { shipmentId: sh.id, sellerId: r.branch.sellerId, branchId: r.branch.id, type: 'REASSIGNED_IN' } });
}

/**
 * No store can fill the parcel: cancel it, net out every money entry on it, and refund what the buyer
 * paid for it to their wallet (items + delivery if prepaid; the delivery deposit if cash on delivery).
 * The COD fee is refunded too once nothing is left to deliver.
 */
async function cancelShipmentAndRefund(tx: Tx, sh: FailingShipment, reason: string): Promise<Prisma.Decimal> {
  await tx.shipment.update({ where: { id: sh.id }, data: { status: 'CANCELLED' } });
  if (sh.deliveryJob) {
    await tx.deliveryJob.update({ where: { id: sh.deliveryJob.id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: reason } });
  }
  const entries = await tx.ledgerEntry.findMany({ where: { shipmentId: sh.id, type: { in: ['SALE', 'SHIPPING_FEE', 'ADJUSTMENT'] } } });
  if (entries.length) {
    await tx.ledgerEntry.createMany({
      data: entries.map((e) => ({
        type: 'ADJUSTMENT' as const, orderId: e.orderId, orderItemId: e.orderItemId, shipmentId: e.shipmentId, sellerId: e.sellerId, userId: e.userId,
        currency: e.currency, exchangeRateAtTx: e.exchangeRateAtTx, grossUsd: e.grossUsd.negated(), grossTx: e.grossTx.negated(),
        commissionUsd: e.commissionUsd.negated(), fulfilmentFeeUsd: e.fulfilmentFeeUsd.negated(), platformRevenueUsd: e.platformRevenueUsd.negated(),
        sellerNetUsd: e.sellerNetUsd.negated(), codStatus: e.codStatus, memo: `${reason}: ${sh.reference} cancelled (reverses ${e.type.toLowerCase()})`,
      })),
    });
  }

  const order = sh.order;
  const remaining = await tx.shipment.count({ where: { orderId: order.id, status: { notIn: ['CANCELLED', 'RETURNED'] } } });
  const itemsUsd = sh.items.reduce((sum, i) => sum.plus(i.lineTotalUsd), new Decimal(0));
  let refund = new Decimal(0);
  if (order.paymentMethod !== 'CASH' && order.paymentStatus === 'PAID') refund = itemsUsd.plus(sh.feeUsd);
  else if (order.paymentMethod === 'CASH' && order.depositUsd.gt(0) && order.depositPaidAt) refund = sh.feeUsd;

  if (remaining === 0 && order.codFeeUsd.gt(0)) {
    const fees = await tx.ledgerEntry.findMany({ where: { orderId: order.id, type: 'COD_FEE' } });
    if (fees.length) {
      await tx.ledgerEntry.createMany({
        data: fees.map((e) => ({
          type: 'ADJUSTMENT' as const, orderId: e.orderId, userId: e.userId, currency: e.currency, exchangeRateAtTx: e.exchangeRateAtTx,
          grossUsd: e.grossUsd.negated(), grossTx: e.grossTx.negated(), platformRevenueUsd: e.platformRevenueUsd.negated(),
          codStatus: e.codStatus, memo: `COD fee returned: ${reason}`,
        })),
      });
    }
    if (order.paymentMethod === 'CASH' && order.depositPaidAt) refund = refund.plus(order.codFeeUsd);
  }

  if (refund.gt(0)) {
    await tx.wallet.upsert({ where: { userId: order.userId }, update: { balanceUsd: { increment: refund } }, create: { userId: order.userId, balanceUsd: refund } });
    await ledgerService.recordWallet(tx, { userId: order.userId, deltaUsd: refund, type: 'WALLET_CREDIT', orderId: order.id, rate: order.lockedExchangeRate, memo: `Refund: ${reason} (${sh.reference})` });
  }
  await settleOrderIfDone(tx, order.id);
  return refund;
}
