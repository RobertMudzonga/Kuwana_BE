import { Prisma, VehicleClass } from '@prisma/client';
import { z } from 'zod';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { sendSms } from '../../lib/sms';
import { sendPushToUsers } from '../../lib/push';
import { verifySecret } from '../../lib/secrets';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../middleware/error.middleware';
import { roundMoney, zwgToUsd } from '../currency/currency.service';
import { buyBoxService } from '../catalog/buybox.service';
import { VEHICLE_ORDER } from '../delivery/fees';
import { getMarketSettings } from '../market/market.settings';
import { ledgerService } from '../market/ledger.service';
import { assertCollectionPin, codAmountsByShipment, settleOrderIfDone } from '../market/handover';
import { driversService, LOCATION_FRESH_MS } from './drivers.service';
import { moveWallet } from './driver-wallet';

type Tx = Prisma.TransactionClient;
const Decimal = Prisma.Decimal;

const PICKUP_PIN_MAX_ATTEMPTS = 5;
/** An unclaimed job is offered further afield every this many minutes */
const WIDEN_EVERY_MIN = 10;
const TRUST_UP = 5;
const TRUST_DOWN_REFUSED = 15;

export const pickupSchema = z.object({ pin: z.string().regex(/^\d{4}$/, 'Enter the 4-digit PIN from the store') });
export const deliverSchema = z.object({
  otp: z.string().regex(/^\d{6}$/, 'Enter the 6-digit PIN from the customer').optional(),
  /** Cash on delivery: what the driver actually received, in the order's currency */
  cashCollected: z.number().min(0).max(1_000_000).optional(),
});
export const failSchema = z.object({
  reason: z.enum(['NOT_HOME', 'REFUSED', 'WRONG_ADDRESS', 'OTHER']),
  note: z.string().trim().max(300).optional(),
});

/** Vehicles that may carry a parcel needing `required` */
function canCarry(driverVehicle: VehicleClass): VehicleClass[] {
  return VEHICLE_ORDER.slice(0, VEHICLE_ORDER.indexOf(driverVehicle) + 1);
}

/** The search radius grows with how long a job has waited, up to the delivery radius */
export function effectiveRadiusKm(baseKm: number, maxKm: number, minutesOpen: number) {
  return Math.min(maxKm, baseKm * (1 + Math.floor(Math.max(0, minutesOpen) / WIDEN_EVERY_MIN)));
}

const jobInclude = {
  pickupBranch: { select: { id: true, name: true, code: true, address: true, landmark: true, lat: true, lng: true, phone: true, seller: { select: { businessName: true } }, suburb: { select: { name: true } } } },
  pickupPoint: { select: { name: true, address: true, landmark: true, phone: true } },
  shipment: {
    select: {
      id: true, reference: true, status: true, orderId: true,
      order: { select: { reference: true, paymentMethod: true, paymentCurrency: true, lockedExchangeRate: true, deliveryMode: true, notes: true } },
      items: { select: { title: true, quantity: true } },
    },
  },
} satisfies Prisma.DeliveryJobInclude;
type JobRow = Prisma.DeliveryJobGetPayload<{ include: typeof jobInclude }>;

/**
 * What a driver sees. Before claiming: the store, the area and the money. After claiming: the full
 * drop-off address and recipient phone, which they need to deliver.
 */
function jobDto(j: JobRow, opts: { mine: boolean; kmToStore?: number | null; codDue?: Prisma.Decimal | null; canClaim?: boolean; floatShortUsd?: number }) {
  const addr = (j.dropoffAddress ?? {}) as Record<string, unknown>;
  const b = j.pickupBranch;
  return {
    id: j.id,
    reference: j.reference,
    status: j.status,
    vehicleRequired: j.vehicleRequired,
    earningsUsd: j.driverFeeUsd.toNumber(),
    collateralUsd: j.collateralRequiredUsd.toNumber(),
    tripKm: j.distanceKm.toNumber(),
    kmToStore: opts.kmToStore ?? null,
    canClaim: opts.canClaim ?? null,
    floatShortUsd: opts.floatShortUsd ?? null,
    store: { name: `${b.seller.businessName} · ${b.name}`, code: b.code, address: b.address, landmark: b.landmark, lat: b.lat, lng: b.lng, phone: opts.mine ? b.phone : null, suburb: b.suburb?.name ?? null },
    dropoff: {
      type: j.dropoffType,
      area: [addr.suburb, addr.city].filter(Boolean).join(', '),
      ...(opts.mine
        ? {
            name: j.dropoffType === 'PICKUP_POINT' ? j.pickupPoint?.name ?? null : null,
            address: j.dropoffType === 'PICKUP_POINT' ? j.pickupPoint?.address ?? null : [addr.line1, addr.line2].filter(Boolean).join(', '),
            landmark: (j.dropoffType === 'PICKUP_POINT' ? j.pickupPoint?.landmark : (addr.landmark as string | null)) ?? null,
            instructions: (addr.instructions as string | null) ?? null,
            lat: j.dropoffLat, lng: j.dropoffLng,
            recipientName: j.recipientName,
            recipientPhone: j.recipientPhone,
          }
        : {}),
    },
    parcel: { reference: j.shipment.reference, items: j.shipment.items.map((i) => `${i.quantity} × ${i.title}`), notes: opts.mine ? j.shipment.order.notes : null },
    cashOnDelivery: j.codAmountUsd.gt(0)
      ? { amountUsd: j.codAmountUsd.toNumber(), collect: opts.codDue ? { amount: opts.codDue.toNumber(), currency: j.shipment.order.paymentCurrency } : null }
      : null,
    claimedAt: j.claimedAt,
    pickedUpAt: j.pickedUpAt,
    deliveredAt: j.deliveredAt,
    failReason: j.failReason,
  };
}

async function safeSms(to: string | null | undefined, body: string) {
  if (!to) return;
  await sendSms(to, body).catch((err) => logger.error('SMS failed', { to, err: (err as Error).message }));
}

async function lockOwnedJob(tx: Tx, jobId: string, driverId: string) {
  await tx.$queryRaw`SELECT id FROM delivery_jobs WHERE id = ${jobId} FOR UPDATE`;
  const job = await tx.deliveryJob.findUnique({ where: { id: jobId } });
  if (!job) throw new NotFoundError('Job');
  if (job.driverId !== driverId) throw new ForbiddenError('This job belongs to another driver');
  return job;
}

export const driverJobsService = {
  /** Open jobs near the driver that their vehicle can carry, closest store first */
  async available(userId: string) {
    const d = await driversService.requireApproved(userId);
    if (!d.isOnline) throw new BadRequestError('Go online to see jobs');
    if (d.lat == null || d.lng == null || !d.locationUpdatedAt || Date.now() - d.locationUpdatedAt.getTime() > LOCATION_FRESH_MS) {
      throw new BadRequestError('Share your location to see nearby jobs');
    }
    const settings = await getMarketSettings();
    const base = settings.jobBroadcastRadiusKm.toNumber();
    const maxKm = settings.maxDeliveryRadiusKm.toNumber();
    const rows = await prisma.$queryRaw<{ id: string; km: number; minutes_open: number }[]>`
      SELECT j.id,
        ST_Distance(b.geom, ST_SetSRID(ST_MakePoint(${d.lng}, ${d.lat}), 4326)::geography) / 1000 AS km,
        EXTRACT(EPOCH FROM (now() - COALESCE(j.broadcast_at, j.updated_at))) / 60 AS minutes_open
      FROM delivery_jobs j
      JOIN store_branches b ON b.id = j.pickup_branch_id
      WHERE j.status = 'OPEN'
        AND j.vehicle_required::text = ANY(${canCarry(d.vehicleClass)}::text[])
        AND ST_DWithin(b.geom, ST_SetSRID(ST_MakePoint(${d.lng}, ${d.lat}), 4326)::geography, ${maxKm * 1000})
      ORDER BY km ASC
      LIMIT 50`;
    const visible = rows.filter((r) => r.km <= effectiveRadiusKm(base, maxKm, Number(r.minutes_open)));
    if (!visible.length) return [];
    const [jobs, wallet] = await Promise.all([
      prisma.deliveryJob.findMany({ where: { id: { in: visible.map((r) => r.id) } }, include: jobInclude }),
      prisma.driverWallet.findUnique({ where: { driverId: d.id } }),
    ]);
    const free = wallet?.availableFloatUsd ?? new Decimal(0);
    const byId = new Map(jobs.map((j) => [j.id, j]));
    const cap = d.maxParcelValueUsd;
    return visible.map((r) => byId.get(r.id)!).filter(Boolean).filter((j) => !cap || j.parcelValueUsd.lte(cap)).map((j) => {
      const short = j.collateralRequiredUsd.minus(free);
      return jobDto(j, {
        mine: false,
        kmToStore: Math.round(visible.find((r) => r.id === j.id)!.km * 10) / 10,
        canClaim: short.lte(0),
        floatShortUsd: short.gt(0) ? short.toNumber() : 0,
      });
    });
  },

  /** Jobs the driver holds now, and recent finished ones */
  async mine(userId: string) {
    const d = await driversService.requireApproved(userId);
    const [active, recent] = await Promise.all([
      prisma.deliveryJob.findMany({ where: { driverId: d.id, status: { in: ['CLAIMED', 'IN_TRANSIT', 'RETURNING'] } }, include: jobInclude, orderBy: { claimedAt: 'asc' } }),
      prisma.deliveryJob.findMany({ where: { driverId: d.id, status: { in: ['DELIVERED', 'RETURNED_TO_STORE'] } }, include: jobInclude, orderBy: { updatedAt: 'desc' }, take: 20 }),
    ]);
    const withCash = await Promise.all(active.map(async (j) => {
      const codDue = j.codAmountUsd.gt(0) ? (await codAmountsByShipment(prisma, j.shipment.orderId)).get(j.shipmentId) ?? null : null;
      return jobDto(j, { mine: true, codDue });
    }));
    return { active: withCash, recent: recent.map((j) => jobDto(j, { mine: true })) };
  },

  async get(userId: string, jobId: string) {
    const d = await driversService.requireApproved(userId);
    const j = await prisma.deliveryJob.findUnique({ where: { id: jobId }, include: jobInclude });
    if (!j) throw new NotFoundError('Job');
    const mine = j.driverId === d.id;
    if (!mine && j.status !== 'OPEN') throw new NotFoundError('Job');
    const codDue = mine && j.codAmountUsd.gt(0) ? (await codAmountsByShipment(prisma, j.shipment.orderId)).get(j.shipmentId) ?? null : null;
    return jobDto(j, { mine, codDue });
  },

  /**
   * Claim a job: the driver's free float must cover the parcel (goods or cash, whichever is larger),
   * and that amount is locked until the parcel is delivered or back at the store.
   */
  async claim(userId: string, jobId: string) {
    const d = await driversService.requireApproved(userId);
    if (!d.isOnline) throw new BadRequestError('Go online to take jobs');
    const settings = await getMarketSettings();
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM delivery_jobs WHERE id = ${jobId} FOR UPDATE`;
      const job = await tx.deliveryJob.findUnique({ where: { id: jobId } });
      if (!job) throw new NotFoundError('Job');
      if (job.status !== 'OPEN') throw new BadRequestError('Another driver took this job');
      if (!canCarry(d.vehicleClass).includes(job.vehicleRequired)) throw new BadRequestError(`This parcel needs a ${job.vehicleRequired.toLowerCase()}`);
      if (d.maxParcelValueUsd && job.parcelValueUsd.gt(d.maxParcelValueUsd)) {
        throw new BadRequestError(`Your account can carry parcels worth up to $${d.maxParcelValueUsd.toFixed(2)}`);
      }
      const active = await tx.deliveryJob.count({ where: { driverId: d.id, status: { in: ['CLAIMED', 'IN_TRANSIT', 'RETURNING'] } } });
      if (active >= settings.driverMaxActiveJobs) throw new BadRequestError(`You can hold up to ${settings.driverMaxActiveJobs} jobs at once; deliver one first`);
      await moveWallet(tx, d.id, 'COLLATERAL_LOCK', { available: job.collateralRequiredUsd.negated(), locked: job.collateralRequiredUsd }, {
        jobId, memo: `Collateral for ${job.reference}`,
        insufficient: `Top up your float: this parcel needs $${job.collateralRequiredUsd.toFixed(2)} free`,
      });
      await tx.deliveryJob.update({ where: { id: jobId }, data: { status: 'CLAIMED', driverId: d.id, claimedAt: new Date(), pinAttempts: 0 } });
      await tx.shipment.update({ where: { id: job.shipmentId }, data: { driverId: userId } });
    });
    return this.get(userId, jobId);
  },

  /** Hand a claimed job back before pickup; the collateral is released and the job reopens */
  async release(userId: string, jobId: string) {
    const d = await driversService.requireApproved(userId);
    await prisma.$transaction(async (tx) => {
      const job = await lockOwnedJob(tx, jobId, d.id);
      if (job.status !== 'CLAIMED') throw new BadRequestError('You can only hand back a job before picking it up');
      await moveWallet(tx, d.id, 'COLLATERAL_RELEASE', { available: job.collateralRequiredUsd, locked: job.collateralRequiredUsd.negated() }, { jobId, memo: `Handed back ${job.reference}` });
      await tx.deliveryJob.update({ where: { id: jobId }, data: { status: 'OPEN', driverId: null, claimedAt: null, broadcastAt: new Date() } });
      await tx.shipment.update({ where: { id: job.shipmentId }, data: { driverId: null } });
    });
    await this.broadcast(jobId, 0);
    return { id: jobId, status: 'OPEN' };
  },

  /** Admin: take a claimed job off a driver who isn't showing up; collateral unlocks and the job reopens */
  async adminRelease(jobId: string, note: string) {
    const out = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM delivery_jobs WHERE id = ${jobId} FOR UPDATE`);
      const job = await tx.deliveryJob.findUnique({ where: { id: jobId }, include: { driver: { select: { user: { select: { phone: true } } } } } });
      if (!job) throw new NotFoundError('Job');
      if (job.status !== 'CLAIMED' || !job.driverId) throw new BadRequestError('Only a job a driver has claimed but not collected can be taken off them');
      await moveWallet(tx, job.driverId, 'COLLATERAL_RELEASE', { available: job.collateralRequiredUsd, locked: job.collateralRequiredUsd.negated() }, { jobId, memo: `Taken off you by Kuwana: ${job.reference}` });
      await tx.deliveryJob.update({ where: { id: jobId }, data: { status: 'OPEN', driverId: null, claimedAt: null, broadcastAt: new Date() } });
      await tx.shipment.update({ where: { id: job.shipmentId }, data: { driverId: null } });
      return { phone: job.driver?.user.phone, reference: job.reference };
    });
    await safeSms(out.phone, `Kuwana: job ${out.reference} was given to another driver (${note}). Your float is unlocked.`);
    await this.broadcast(jobId, 0);
    return { id: jobId, status: 'OPEN' as const };
  },

  /** At the store counter: the store's 4-digit PIN proves the handover */
  async pickup(userId: string, jobId: string, pin: string) {
    const d = await driversService.requireApproved(userId);
    const job = await prisma.deliveryJob.findUnique({ where: { id: jobId } });
    if (!job || job.driverId !== d.id) throw new NotFoundError('Job');
    if (job.status !== 'CLAIMED') throw new BadRequestError('This job is not waiting for pickup');
    if (job.pinAttempts >= PICKUP_PIN_MAX_ATTEMPTS) throw new BadRequestError('Too many wrong PINs. Ask the store to call Kuwana support.');
    if (!verifySecret(`pickup:${jobId}`, pin, job.pickupPinHash)) {
      await prisma.deliveryJob.update({ where: { id: jobId }, data: { pinAttempts: { increment: 1 } } });
      throw new BadRequestError('That PIN is wrong. Ask the store staff for the PIN on their screen.');
    }
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      const { count } = await tx.deliveryJob.updateMany({ where: { id: jobId, status: 'CLAIMED', driverId: d.id }, data: { status: 'IN_TRANSIT', pickedUpAt: now } });
      if (!count) throw new BadRequestError('This job is not waiting for pickup');
      await tx.shipment.update({
        where: { id: job.shipmentId },
        data: job.dropoffType === 'PICKUP_POINT' ? { status: 'DISPATCHED', dispatchedAt: now } : { status: 'OUT_FOR_DELIVERY', dispatchedAt: now, outForDeliveryAt: now },
      });
    });
    const driver = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { profile: { select: { fullName: true } } } });
    const sh = await prisma.shipment.findUniqueOrThrow({ where: { id: job.shipmentId }, select: { reference: true } });
    const first = driver.profile?.fullName.split(' ')[0] ?? 'your driver';
    await safeSms(job.recipientPhone, job.dropoffType === 'PICKUP_POINT'
      ? `Kuwana parcel ${sh.reference} is on its way to the pickup point. We’ll text you when it arrives.`
      : `Kuwana parcel ${sh.reference} is on its way with ${first}${d.vehicleReg ? ` (${d.vehicleReg})` : ''}. Give your 6-digit PIN only once you have the parcel.`);
    return this.get(userId, jobId);
  },

  /**
   * Hand over at the door (customer's 6-digit PIN) or drop at the pickup point. Collateral comes back;
   * for cash on delivery the driver keeps the cash and the same amount is taken from their float;
   * the delivery fee is credited to their earnings.
   */
  async deliver(userId: string, jobId: string, input: z.infer<typeof deliverSchema>) {
    const d = await driversService.requireApproved(userId);
    const job = await prisma.deliveryJob.findUnique({ where: { id: jobId }, include: { shipment: { include: { order: true } } } });
    if (!job || job.driverId !== d.id) throw new NotFoundError('Job');
    if (job.status !== 'IN_TRANSIT') throw new BadRequestError('Pick the parcel up from the store first');
    const order = job.shipment.order;
    const toPoint = job.dropoffType === 'PICKUP_POINT';
    const cod = !toPoint && job.codAmountUsd.gt(0);
    if (!toPoint) {
      if (!input.otp) throw new BadRequestError('Enter the 6-digit PIN from the customer');
      if (cod && input.cashCollected === undefined) throw new BadRequestError('Enter the cash you collected');
      await assertCollectionPin(order.id, input.otp);
    }
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      const { count } = await tx.deliveryJob.updateMany({ where: { id: jobId, status: 'IN_TRANSIT', driverId: d.id }, data: { status: 'DELIVERED', deliveredAt: now } });
      if (!count) throw new BadRequestError('This parcel has already been delivered');
      await tx.shipment.update({
        where: { id: job.shipmentId },
        data: toPoint
          ? { status: 'READY_FOR_COLLECTION', readyForCollectionAt: now }
          : { status: 'DELIVERED', deliveredAt: now, handedOverById: userId },
      });
      await moveWallet(tx, d.id, 'COLLATERAL_RELEASE', { available: job.collateralRequiredUsd, locked: job.collateralRequiredUsd.negated() }, { jobId, memo: `Delivered ${job.reference}` });

      if (cod) {
        // The driver keeps the cash; Kuwana keeps the same amount of their float
        await moveWallet(tx, d.id, 'COD_OFFSET', { available: job.codAmountUsd.negated() }, { jobId, memo: `Cash collected for ${job.reference}`, insufficient: 'Float too low to settle this cash; contact support' });
        const expected = (await codAmountsByShipment(tx, order.id)).get(job.shipmentId) ?? new Decimal(0);
        const collected = roundMoney(input.cashCollected!);
        await tx.codRemittance.create({
          data: {
            shipmentId: job.shipmentId, orderId: order.id, collectorId: userId, currency: order.paymentCurrency,
            expectedAmount: expected, collectedAmount: collected,
            // Settled on the spot against the driver's float; a short count is the driver's loss
            status: collected.equals(expected) ? 'VERIFIED' : 'DISCREPANCY', verifiedAt: now,
            note: collected.equals(expected) ? 'Offset against driver float' : `Collected ${collected.toFixed(2)} of ${expected.toFixed(2)}; full amount offset against driver float`,
          },
        });
        const expectedUsd = order.paymentCurrency === 'USD' ? expected : zwgToUsd(expected, order.lockedExchangeRate);
        await tx.ledgerEntry.create({
          data: {
            type: 'COD_COLLECTED', orderId: order.id, shipmentId: job.shipmentId, userId: order.userId, currency: order.paymentCurrency,
            exchangeRateAtTx: order.lockedExchangeRate, grossUsd: expectedUsd, grossTx: expected, codStatus: 'COLLECTED',
            memo: `Cash collected by driver for ${job.shipment.reference} (settled from float)`,
          },
        });
        await tx.$executeRaw`UPDATE users SET cod_trust_score = LEAST(100, GREATEST(0, cod_trust_score + ${TRUST_UP}::int)) WHERE id = ${order.userId}`;
      }

      if (job.driverFeeUsd.gt(0)) await moveWallet(tx, d.id, 'DELIVERY_EARNING', { earnings: job.driverFeeUsd }, { jobId, memo: `Delivery fee ${job.reference}` });
      await tx.driverProfile.update({ where: { id: d.id }, data: { completedJobs: { increment: 1 } } });
      if (!toPoint) await settleOrderIfDone(tx, order.id);
    });

    if (toPoint) {
      const point = await prisma.pickupPoint.findUnique({ where: { id: job.pickupPointId ?? '' }, select: { name: true } });
      await safeSms(job.recipientPhone, `Kuwana parcel ${job.shipment.reference} is ready at ${point?.name ?? 'your pickup point'}. Bring your 6-digit PIN to collect it.`);
    } else {
      await safeSms(job.recipientPhone, `Kuwana parcel ${job.shipment.reference} has been delivered. Thank you!`);
    }
    return this.get(userId, jobId);
  },

  /** Couldn't hand over: the driver takes it back to the store, which confirms receipt */
  async fail(userId: string, jobId: string, input: z.infer<typeof failSchema>) {
    const d = await driversService.requireApproved(userId);
    await prisma.$transaction(async (tx) => {
      const job = await lockOwnedJob(tx, jobId, d.id);
      if (job.status !== 'IN_TRANSIT') throw new BadRequestError('Only a parcel on its way can be marked undeliverable');
      await tx.deliveryJob.update({ where: { id: jobId }, data: { status: 'RETURNING', failReason: input.reason, failNote: input.note, failedAt: new Date() } });
      const sh = await tx.shipment.findUniqueOrThrow({ where: { id: job.shipmentId }, select: { orderId: true, order: { select: { paymentMethod: true } } } });
      if (input.reason === 'REFUSED' && sh.order.paymentMethod === 'CASH') {
        const { userId: buyerId } = await tx.marketOrder.findUniqueOrThrow({ where: { id: sh.orderId }, select: { userId: true } });
        await tx.$executeRaw`UPDATE users SET cod_trust_score = LEAST(100, GREATEST(0, cod_trust_score - ${TRUST_DOWN_REFUSED}::int)) WHERE id = ${buyerId}`;
      }
    });
    return this.get(userId, jobId);
  },

  /**
   * The store has the parcel back. The driver's collateral is released and they are paid for the trip;
   * the stock goes back on sale; a prepaid buyer is refunded to their wallet. A COD delivery deposit is kept.
   */
  async receivedBackAtStore(shipmentId: string, branchIds: string[]) {
    const result = await prisma.$transaction(async (tx) => {
      const job = await tx.deliveryJob.findUnique({ where: { shipmentId }, include: { shipment: { include: { items: true, order: true } } } });
      if (!job || !branchIds.includes(job.pickupBranchId)) throw new NotFoundError('Order');
      if (job.status !== 'RETURNING' || !job.driverId) throw new BadRequestError('This parcel is not on its way back');
      await tx.$queryRaw`SELECT id FROM delivery_jobs WHERE id = ${job.id} FOR UPDATE`;
      const { count } = await tx.deliveryJob.updateMany({ where: { id: job.id, status: 'RETURNING' }, data: { status: 'RETURNED_TO_STORE', returnedAt: new Date() } });
      if (!count) throw new BadRequestError('Already received back');

      await moveWallet(tx, job.driverId, 'COLLATERAL_RELEASE', { available: job.collateralRequiredUsd, locked: job.collateralRequiredUsd.negated() }, { jobId: job.id, memo: `Returned ${job.reference} to the store` });
      if (job.driverFeeUsd.gt(0)) await moveWallet(tx, job.driverId, 'DELIVERY_EARNING', { earnings: job.driverFeeUsd }, { jobId: job.id, memo: `Return trip ${job.reference}` });

      const sh = job.shipment;
      const order = sh.order;
      await tx.shipment.update({ where: { id: sh.id }, data: { status: 'RETURNED' } });
      for (const item of sh.items) await tx.offer.update({ where: { id: item.offerId }, data: { stockQty: { increment: item.quantity } } });

      // Net out the goods; delivery is kept only if the buyer paid it as a (non-refundable) COD deposit
      const feeKept = order.paymentMethod === 'CASH' && order.depositUsd.gt(0);
      const entries = await tx.ledgerEntry.findMany({
        where: { shipmentId: sh.id, type: { in: feeKept ? ['SALE', 'ADJUSTMENT'] : ['SALE', 'ADJUSTMENT', 'SHIPPING_FEE'] }, ...(feeKept ? { orderItemId: { not: null } } : {}) },
      });
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
      // The driver was still paid for the trip
      if (!feeKept && job.driverFeeUsd.gt(0)) {
        await tx.ledgerEntry.create({
          data: {
            type: 'ADJUSTMENT', orderId: order.id, shipmentId: sh.id, userId: order.userId, currency: order.paymentCurrency, exchangeRateAtTx: order.lockedExchangeRate,
            grossUsd: 0, grossTx: 0, platformRevenueUsd: job.driverFeeUsd.negated(), memo: `Driver paid for failed delivery ${sh.reference}`,
          },
        });
      }

      let refund = new Decimal(0);
      if (order.paymentMethod !== 'CASH' && order.paymentStatus === 'PAID') {
        refund = sh.items.reduce((s, i) => s.plus(i.lineTotalUsd), new Decimal(0)).plus(sh.feeUsd);
        await tx.wallet.upsert({ where: { userId: order.userId }, update: { balanceUsd: { increment: refund } }, create: { userId: order.userId, balanceUsd: refund } });
        await ledgerService.recordWallet(tx, { userId: order.userId, deltaUsd: refund, type: 'WALLET_CREDIT', orderId: order.id, rate: order.lockedExchangeRate, memo: `Refund for undelivered ${sh.reference}` });
      }
      await settleOrderIfDone(tx, order.id);
      // Nothing was delivered on a cash order without a deposit: the COD fee was never collected either
      const settled = await tx.marketOrder.findUniqueOrThrow({ where: { id: order.id }, select: { status: true } });
      if (settled.status === 'CANCELLED' && order.paymentMethod === 'CASH' && !feeKept) {
        const fees = await tx.ledgerEntry.findMany({ where: { orderId: order.id, type: 'COD_FEE' } });
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
      for (const pid of [...new Set(sh.items.map((i) => i.productId))].sort()) await buyBoxService.recomputeProduct(pid, tx);
      return { buyerId: order.userId, reference: sh.reference, refund };
    });
    if (result.refund.gt(0)) {
      const buyer = await prisma.user.findUnique({ where: { id: result.buyerId }, select: { phone: true } });
      await safeSms(buyer?.phone, `We couldn't deliver Kuwana parcel ${result.reference}. $${result.refund.toFixed(2)} has been added to your Kuwana wallet.`);
    }
    return { refundUsd: result.refund.toNumber() };
  },

  /**
   * Tell nearby online drivers who can carry and afford a job about it. Each round widens the radius;
   * further rounds are scheduled until someone claims it.
   */
  async broadcast(jobId: string, round: number) {
    const job = await prisma.deliveryJob.findUnique({ where: { id: jobId }, include: { pickupBranch: { select: { lat: true, lng: true, name: true } } } });
    if (!job || job.status !== 'OPEN') return 0;
    const settings = await getMarketSettings();
    const radiusKm = effectiveRadiusKm(settings.jobBroadcastRadiusKm.toNumber(), settings.maxDeliveryRadiusKm.toNumber(), round * WIDEN_EVERY_MIN);
    const carriers = VEHICLE_ORDER.slice(VEHICLE_ORDER.indexOf(job.vehicleRequired));
    const freshSince = new Date(Date.now() - LOCATION_FRESH_MS);
    const drivers = await prisma.$queryRaw<{ user_id: string }[]>`
      SELECT d.user_id FROM driver_profiles d
      JOIN driver_wallets w ON w.driver_id = d.id
      WHERE d.is_online AND d.kyc_status = 'APPROVED' AND d.location_updated_at >= ${freshSince}
        AND d.vehicle_class::text = ANY(${carriers}::text[])
        AND w.available_float_usd >= ${job.collateralRequiredUsd.toString()}::numeric
        AND ST_DWithin(d.geom, ST_SetSRID(ST_MakePoint(${job.pickupBranch.lng}, ${job.pickupBranch.lat}), 4326)::geography, ${radiusKm * 1000})
      LIMIT 50`;
    if (drivers.length) {
      await sendPushToUsers(drivers.map((r) => r.user_id), {
        title: `New job · $${job.driverFeeUsd.toFixed(2)}`,
        body: `Collect at ${job.pickupBranch.name} · ${job.distanceKm.toFixed(1)} km trip`,
        data: { type: 'NEW_DELIVERY' },
      });
    }
    if (round < 3) {
      const { enqueue } = await import('../../lib/jobs');
      const { JOBS } = await import('../../jobs');
      await enqueue(JOBS.deliveryBroadcast, { jobId, round: round + 1 }, { delayMs: WIDEN_EVERY_MIN * 60_000, jobId: `broadcast-${jobId}-${round + 1}-${job.broadcastAt?.getTime() ?? 0}` })
        .catch((err) => logger.error('Could not schedule rebroadcast', { jobId, err: (err as Error).message }));
    }
    return drivers.length;
  },
};
