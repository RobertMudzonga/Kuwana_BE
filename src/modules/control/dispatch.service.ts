import { Prisma } from '@prisma/client';
import { z } from 'zod';
import prisma from '../../lib/prisma';

/**
 * Live dispatch board: store parcels that are late at any step, with what an admin can do about each.
 * Thresholds are deliberately simple and listed here so ops can reason about them.
 */

export const DISPATCH_THRESHOLDS = {
  /** An OPEN job nobody has claimed for this long */
  noDriverMinutes: 15,
  /** A claimed job not collected from the store for this long */
  pickupMinutes: 45,
  /** Slack on top of the trip estimate (3 min/km) before an in-transit parcel counts as late */
  deliverySlackMinutes: 30,
  /** A failed delivery not back at the store after this long */
  returnMinutes: 120,
};

export type DelayReason = 'STORE_NOT_ACCEPTED' | 'STORE_NOT_PACKED' | 'NO_DRIVER' | 'PICKUP_LATE' | 'DELIVERY_LATE' | 'RETURN_LATE';

export const reassignSchema = z.object({ branchId: z.string().uuid().optional(), note: z.string().trim().max(300).optional() });
export const cancelSchema = z.object({ reason: z.string().trim().min(3).max(300) });

const include = {
  order: { select: { id: true, reference: true, paymentMethod: true, payoutHoldAt: true, user: { select: { phone: true, profile: { select: { fullName: true } } } } } },
  storeBranch: { select: { id: true, name: true, code: true, phone: true, seller: { select: { id: true, businessName: true } } } },
  deliveryJob: { include: { driver: { select: { id: true, vehicleReg: true, user: { select: { phone: true, profile: { select: { fullName: true } } } } } } } },
  items: { select: { title: true, quantity: true } },
} satisfies Prisma.ShipmentInclude;
type Row = Prisma.ShipmentGetPayload<{ include: typeof include }>;

const minutesSince = (d: Date | null | undefined, now: Date) => (d ? Math.round((now.getTime() - d.getTime()) / 60_000) : 0);

/** Why a parcel is late right now, and by how many minutes; null when it's on time */
export function delayOf(s: Row, now = new Date()): { reason: DelayReason; minutesLate: number } | null {
  const j = s.deliveryJob;
  const t = DISPATCH_THRESHOLDS;
  if (s.status === 'PROCESSING' && !s.acceptedAt && s.acceptBy && s.acceptBy < now) return { reason: 'STORE_NOT_ACCEPTED', minutesLate: minutesSince(s.acceptBy, now) };
  if (j?.status === 'AWAITING_STORE' && s.acceptedAt && s.dispatchBy && s.dispatchBy < now) return { reason: 'STORE_NOT_PACKED', minutesLate: minutesSince(s.dispatchBy, now) };
  if (j?.status === 'OPEN') {
    const open = minutesSince(j.broadcastAt ?? j.updatedAt, now);
    if (open >= t.noDriverMinutes) return { reason: 'NO_DRIVER', minutesLate: open - t.noDriverMinutes };
  }
  if (j?.status === 'CLAIMED') {
    const waited = minutesSince(j.claimedAt, now);
    if (waited >= t.pickupMinutes) return { reason: 'PICKUP_LATE', minutesLate: waited - t.pickupMinutes };
  }
  if (j?.status === 'IN_TRANSIT' && j.pickedUpAt) {
    const allowed = Math.round(Number(j.distanceKm) * 3) + t.deliverySlackMinutes;
    const took = minutesSince(j.pickedUpAt, now);
    if (took >= allowed) return { reason: 'DELIVERY_LATE', minutesLate: took - allowed };
  }
  if (j?.status === 'RETURNING') {
    const took = minutesSince(j.failedAt, now);
    if (took >= t.returnMinutes) return { reason: 'RETURN_LATE', minutesLate: took - t.returnMinutes };
  }
  return null;
}

const ACTIONS: Record<DelayReason, ('REASSIGN' | 'CANCEL' | 'RELEASE_DRIVER' | 'CALL')[]> = {
  STORE_NOT_ACCEPTED: ['REASSIGN', 'CANCEL', 'CALL'],
  STORE_NOT_PACKED: ['REASSIGN', 'CANCEL', 'CALL'],
  NO_DRIVER: ['REASSIGN', 'CANCEL'],
  PICKUP_LATE: ['RELEASE_DRIVER', 'REASSIGN', 'CALL'],
  DELIVERY_LATE: ['CALL'],
  RETURN_LATE: ['CALL'],
};

function toDto(s: Row, delay: { reason: DelayReason; minutesLate: number }) {
  const j = s.deliveryJob;
  return {
    shipmentId: s.id,
    reference: s.reference,
    order: { id: s.order.id, reference: s.order.reference, paymentMethod: s.order.paymentMethod, payoutHeld: !!s.order.payoutHoldAt },
    buyer: { name: s.order.user.profile?.fullName ?? null, phone: s.order.user.phone },
    store: s.storeBranch ? { branchId: s.storeBranch.id, name: `${s.storeBranch.seller.businessName} · ${s.storeBranch.name}`, phone: s.storeBranch.phone, sellerId: s.storeBranch.seller.id } : null,
    driver: j?.driver ? { id: j.driver.id, name: j.driver.user.profile?.fullName ?? null, phone: j.driver.user.phone, vehicleReg: j.driver.vehicleReg } : null,
    job: j ? { id: j.id, reference: j.reference, status: j.status, distanceKm: Number(j.distanceKm), driverFeeUsd: j.driverFeeUsd.toNumber(), parcelValueUsd: j.parcelValueUsd.toNumber() } : null,
    shipmentStatus: s.status,
    items: s.items.map((i) => `${i.quantity} × ${i.title}`),
    reassignCount: s.reassignCount,
    reason: delay.reason,
    minutesLate: delay.minutesLate,
    actions: ACTIONS[delay.reason],
    createdAt: s.createdAt,
  };
}

export const dispatchService = {
  /** Every late store parcel, worst first, plus counts of what's moving now */
  async board(now = new Date()) {
    const live = await prisma.shipment.findMany({
      where: {
        storeBranchId: { not: null },
        order: { status: 'CONFIRMED' },
        OR: [
          { status: 'PROCESSING' },
          { deliveryJob: { status: { in: ['AWAITING_STORE', 'OPEN', 'CLAIMED', 'IN_TRANSIT', 'RETURNING'] } } },
        ],
      },
      include,
      orderBy: { createdAt: 'asc' },
      take: 1000,
    });
    const late = live
      .map((s) => ({ s, d: delayOf(s, now) }))
      .filter((x): x is { s: Row; d: NonNullable<ReturnType<typeof delayOf>> } => !!x.d)
      .sort((a, b) => b.d.minutesLate - a.d.minutesLate)
      .map((x) => toDto(x.s, x.d));
    const byStage = (st: string) => live.filter((s) => s.deliveryJob?.status === st).length;
    return {
      thresholds: DISPATCH_THRESHOLDS,
      live: {
        atStore: live.filter((s) => !s.deliveryJob || s.deliveryJob.status === 'AWAITING_STORE').length,
        waitingForDriver: byStage('OPEN'),
        goingToStore: byStage('CLAIMED'),
        onTheRoad: byStage('IN_TRANSIT'),
        returning: byStage('RETURNING'),
      },
      late,
    };
  },

  /** Branches that could take a parcel, for the reassign picker (same city, active, with every item) */
  async candidates(shipmentId: string) {
    const sh = await prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId }, include: { items: true, storeBranch: { select: { cityId: true } } } });
    if (!sh.storeBranch) return [];
    const productIds = [...new Set(sh.items.map((i) => i.productId))];
    const branches = await prisma.storeBranch.findMany({
      where: { cityId: sh.storeBranch.cityId, isActive: true, id: { not: sh.storeBranchId! }, seller: { kycStatus: 'APPROVED' } },
      include: { seller: { select: { businessName: true } }, offers: { where: { productId: { in: productIds }, isActive: true }, select: { productId: true, stockQty: true, priceUsd: true } } },
    });
    return branches
      .map((b) => {
        const fits = sh.items.every((i) => b.offers.some((o) => o.productId === i.productId && o.stockQty >= i.quantity && o.priceUsd.lte(i.unitPriceUsd)));
        return { id: b.id, name: `${b.seller.businessName} · ${b.name}`, isPaused: b.isPaused, canFill: fits };
      })
      .sort((a, b) => Number(b.canFill) - Number(a.canFill) || a.name.localeCompare(b.name));
  },
};
