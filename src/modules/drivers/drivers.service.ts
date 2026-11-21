import { Prisma } from '@prisma/client';
import { z } from 'zod';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { sendSms } from '../../lib/sms';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../middleware/error.middleware';
import { zwMobile } from '../auth/auth.schema';
import { paymentsService, registerPaymentPurpose } from '../payments/payments.service';
import { moveWallet, walletDto } from './driver-wallet';

const Decimal = Prisma.Decimal;
const usd = z.number().positive().max(10_000).multipleOf(0.01);

export const applySchema = z.object({
  nationalId: z.string().trim().regex(/^\d{2}-?\d{6,7}-?[A-Z]-?\d{2}$/i, 'Enter your national ID, e.g. 63-1234567-X-63'),
  licenseNumber: z.string().trim().min(4).max(30).optional(),
  licenseExpiry: z.coerce.date().optional(),
  vehicleClass: z.enum(['BIKE', 'CAR', 'BAKKIE']),
  vehicleReg: z.string().trim().min(3).max(15).optional(),
  vehicleDescription: z.string().trim().max(100).optional(),
  cityId: z.string().uuid(),
  idDocUrl: z.string().url().optional(),
  licenseDocUrl: z.string().url().optional(),
  selfieUrl: z.string().url().optional(),
})
  .refine((v) => v.vehicleClass === 'BIKE' || !!v.licenseNumber, { message: 'Cars and bakkies need a driver’s licence', path: ['licenseNumber'] })
  .refine((v) => !v.licenseExpiry || v.licenseExpiry > new Date(), { message: 'Your licence has expired', path: ['licenseExpiry'] });

export const statusSchema = z
  .object({
    isOnline: z.boolean().optional(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
  })
  .refine((v) => (v.lat === undefined) === (v.lng === undefined), { message: 'Send lat and lng together', path: ['lat'] });

export const depositSchema = z.object({
  amountUsd: usd.min(1),
  method: z.enum(['ECOCASH', 'INNBUCKS', 'ONEMONEY']),
  phone: zwMobile,
});

export const withdrawSchema = z.object({
  bucket: z.enum(['FLOAT', 'EARNINGS']),
  amountUsd: usd.min(1),
  method: z.enum(['ECOCASH', 'INNBUCKS']),
  phone: zwMobile,
});

export const decideSchema = z.object({
  note: z.string().trim().max(300).optional(),
  /** Highest parcel value this driver may carry; null removes the cap */
  maxParcelValueUsd: z.number().positive().max(100_000).multipleOf(0.01).nullable().optional(),
});
export const capSchema = z.object({ maxParcelValueUsd: z.number().positive().max(100_000).multipleOf(0.01).nullable() });
export const rejectSchema = z.object({ note: z.string().trim().min(3).max(300) });
export const adjustSchema = z.object({
  /** Positive: cash deposited with an agent; negative: correction */
  amountUsd: z.number().min(-10_000).max(10_000).multipleOf(0.01).refine((v) => v !== 0, 'Enter a non-zero amount'),
  reference: z.string().trim().max(60).optional(),
  memo: z.string().trim().min(3).max(200),
});
export const paidSchema = z.object({ externalRef: z.string().trim().min(2).max(60) });

/** A driver's location older than this doesn't count for matching */
export const LOCATION_FRESH_MS = 30 * 60_000;

const profileInclude = {
  user: { select: { email: true, phone: true, profile: { select: { fullName: true } } } },
  city: { select: { id: true, name: true } },
  wallet: true,
} satisfies Prisma.DriverProfileInclude;
type ProfileRow = Prisma.DriverProfileGetPayload<{ include: typeof profileInclude }>;

function profileDto(p: ProfileRow) {
  const w = p.wallet;
  return {
    id: p.id,
    fullName: p.user.profile?.fullName ?? p.user.email,
    email: p.user.email,
    phone: p.user.phone,
    nationalId: p.nationalId,
    licenseNumber: p.licenseNumber,
    licenseExpiry: p.licenseExpiry,
    vehicleClass: p.vehicleClass,
    vehicleReg: p.vehicleReg,
    vehicleDescription: p.vehicleDescription,
    city: p.city,
    documents: { idDocUrl: p.idDocUrl, licenseDocUrl: p.licenseDocUrl, selfieUrl: p.selfieUrl },
    kycStatus: p.kycStatus,
    rejectionNote: p.rejectionNote,
    maxParcelValueUsd: p.maxParcelValueUsd?.toNumber() ?? null,
    isOnline: p.isOnline,
    location: p.lat != null && p.lng != null ? { lat: p.lat, lng: p.lng, updatedAt: p.locationUpdatedAt } : null,
    ratingAvg: p.ratingAvg,
    completedJobs: p.completedJobs,
    wallet: {
      availableFloatUsd: w?.availableFloatUsd.toNumber() ?? 0,
      lockedFloatUsd: w?.lockedFloatUsd.toNumber() ?? 0,
      withdrawableEarningsUsd: w?.withdrawableEarningsUsd.toNumber() ?? 0,
    },
    createdAt: p.createdAt,
  };
}

export type DriverProfileDto = ReturnType<typeof profileDto>;

async function safeSms(to: string | null | undefined, body: string) {
  if (!to) return;
  await sendSms(to, body).catch((err) => logger.error('SMS failed', { to, err: (err as Error).message }));
}

export const driversService = {
  async profileFor(userId: string) {
    return prisma.driverProfile.findUnique({ where: { userId }, include: profileInclude });
  },

  /** The approved driver acting on a request */
  async requireApproved(userId: string) {
    const p = await prisma.driverProfile.findUnique({ where: { userId } });
    if (!p) throw new ForbiddenError('Apply to drive with Kuwana first');
    if (p.kycStatus !== 'APPROVED') throw new ForbiddenError(p.kycStatus === 'PENDING' ? 'Your driver application is still being reviewed' : 'Your driver account is not active');
    return p;
  },

  async me(userId: string) {
    const p = await this.profileFor(userId);
    return p ? profileDto(p) : null;
  },

  /** Self-service onboarding; a rejected applicant may re-apply with corrected details */
  async apply(userId: string, input: z.infer<typeof applySchema>) {
    const existing = await prisma.driverProfile.findUnique({ where: { userId } });
    if (existing && existing.kycStatus !== 'REJECTED') throw new ConflictError('You have already applied');
    if (!(await prisma.city.findUnique({ where: { id: input.cityId }, select: { id: true } }))) throw new BadRequestError('Unknown city');
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { phone: true, phoneVerified: true, role: true } });
    if (!user.phone || !user.phoneVerified) throw new BadRequestError('Verify your phone number first: customers and stores call you on it');
    if (!['USER', 'DRIVER'].includes(user.role)) throw new BadRequestError('This account cannot drive; register a separate account to drive');
    const data = { ...input, kycStatus: 'PENDING' as const, rejectionNote: null, approvedAt: null, approvedBy: null };
    const p = existing
      ? await prisma.driverProfile.update({ where: { userId }, data, include: profileInclude })
      : await prisma.driverProfile.create({ data: { ...data, userId, wallet: { create: {} } }, include: profileInclude });
    return profileDto(p);
  },

  /** Go online / offline and share location. Going online needs an approved account and a location. */
  async setStatus(userId: string, input: z.infer<typeof statusSchema>) {
    const p = await this.requireApproved(userId);
    const now = new Date();
    const hasLocation = input.lat !== undefined || (p.lat != null && p.locationUpdatedAt && now.getTime() - p.locationUpdatedAt.getTime() < LOCATION_FRESH_MS);
    if (input.isOnline && !hasLocation) throw new BadRequestError('Share your location to go online');
    const updated = await prisma.driverProfile.update({
      where: { id: p.id },
      data: {
        ...(input.isOnline !== undefined ? { isOnline: input.isOnline } : {}),
        ...(input.lat !== undefined ? { lat: input.lat, lng: input.lng, locationUpdatedAt: now } : {}),
      },
      include: profileInclude,
    });
    return profileDto(updated);
  },

  // ── Wallet ────────────────────────────────────────────

  async walletHistory(userId: string) {
    const p = await this.requireApproved(userId);
    const [entries, withdrawals, wallet] = await Promise.all([
      prisma.driverWalletEntry.findMany({ where: { driverId: p.id }, orderBy: { createdAt: 'desc' }, take: 100, include: { deliveryJob: { select: { reference: true } } } }),
      prisma.driverWithdrawal.findMany({ where: { driverId: p.id }, orderBy: { createdAt: 'desc' }, take: 20 }),
      walletDto(p.id),
    ]);
    return {
      ...wallet,
      entries: entries.map((e) => ({
        id: e.id, type: e.type, availableDeltaUsd: e.availableDeltaUsd.toNumber(), lockedDeltaUsd: e.lockedDeltaUsd.toNumber(),
        earningsDeltaUsd: e.earningsDeltaUsd.toNumber(), availableAfterUsd: e.availableAfterUsd.toNumber(), jobReference: e.deliveryJob?.reference ?? null,
        memo: e.memo, createdAt: e.createdAt,
      })),
      withdrawals: withdrawals.map((w) => ({ id: w.id, bucket: w.bucket, amountUsd: w.amountUsd.toNumber(), method: w.method, status: w.status, externalRef: w.externalRef, note: w.note, createdAt: w.createdAt })),
    };
  },

  /** Top up the collateral float by mobile money; credited when the payment succeeds */
  async startDeposit(userId: string, input: z.infer<typeof depositSchema>) {
    const p = await this.requireApproved(userId);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
    return paymentsService.startPayment({
      purpose: 'DRIVER_FLOAT', checkoutRef: p.id, amount: input.amountUsd, currency: 'USD', method: input.method,
      phone: input.phone, customerEmail: user.email, description: 'Kuwana driver float top-up',
    });
  },

  async onDepositSucceeded(paymentId: string, paidAmount?: number) {
    await prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({ where: { id: paymentId } });
      if (!payment || payment.status === 'SUCCEEDED') return;
      if (paidAmount !== undefined && Math.abs(paidAmount - payment.amount.toNumber()) > 0.009) {
        await tx.payment.update({ where: { id: paymentId }, data: { status: 'FAILED', failureCode: 'amount_mismatch' } });
        return;
      }
      await tx.payment.update({ where: { id: paymentId }, data: { status: 'SUCCEEDED' } });
      await moveWallet(tx, payment.checkoutRef, 'FLOAT_DEPOSIT', { available: payment.amount }, { reference: paymentId, memo: `${payment.method} top-up` });
    });
  },

  async onDepositFailed(paymentId: string, failureCode: string) {
    await prisma.payment.updateMany({ where: { id: paymentId, status: { not: 'SUCCEEDED' } }, data: { status: 'FAILED', failureCode } });
  },

  /** Ask for float or earnings to be paid out. The amount leaves the wallet now and returns if rejected. */
  async requestWithdrawal(userId: string, input: z.infer<typeof withdrawSchema>) {
    const p = await this.requireApproved(userId);
    const amount = new Decimal(input.amountUsd);
    const w = await prisma.$transaction(async (tx) => {
      await moveWallet(
        tx, p.id, input.bucket === 'FLOAT' ? 'FLOAT_WITHDRAWAL' : 'EARNINGS_WITHDRAWAL',
        input.bucket === 'FLOAT' ? { available: amount.negated() } : { earnings: amount.negated() },
        { memo: `Withdrawal to ${input.method} ${input.phone}`, insufficient: input.bucket === 'FLOAT' ? 'You can only withdraw float that is not locked by a job' : 'You don’t have that much in earnings' },
      );
      return tx.driverWithdrawal.create({ data: { driverId: p.id, bucket: input.bucket, amountUsd: amount, method: input.method, destination: { phone: input.phone } } });
    });
    return { id: w.id, status: w.status, amountUsd: w.amountUsd.toNumber() };
  },

  // ── Admin ─────────────────────────────────────────────

  async adminList(status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'SUSPENDED') {
    const rows = await prisma.driverProfile.findMany({ where: status ? { kycStatus: status } : {}, include: profileInclude, orderBy: { createdAt: 'desc' }, take: 200 });
    return rows.map(profileDto);
  },

  async decide(adminId: string, driverId: string, decision: 'APPROVED' | 'REJECTED' | 'SUSPENDED', note?: string, maxParcelValueUsd?: number | null) {
    const p = await prisma.driverProfile.findUnique({ where: { id: driverId }, include: { user: { select: { id: true, role: true, phone: true } } } });
    if (!p) throw new NotFoundError('Driver');
    if (decision === 'SUSPENDED') {
      const active = await prisma.deliveryJob.count({ where: { driverId, status: { in: ['CLAIMED', 'IN_TRANSIT', 'RETURNING'] } } });
      if (active) throw new BadRequestError(`This driver has ${active} parcel(s) in hand; resolve them before suspending`);
    }
    await prisma.$transaction(async (tx) => {
      await tx.driverProfile.update({
        where: { id: driverId },
        data: {
          kycStatus: decision,
          rejectionNote: decision === 'APPROVED' ? null : note ?? null,
          ...(decision === 'APPROVED' ? { approvedAt: new Date(), approvedBy: adminId } : { isOnline: false }),
          ...(decision === 'APPROVED' && maxParcelValueUsd !== undefined ? { maxParcelValueUsd } : {}),
        },
      });
      await tx.driverWallet.upsert({ where: { driverId }, update: {}, create: { driverId } });
      // Approved gig drivers use the DRIVER role (shared with Kuwana's own drivers)
      if (decision === 'APPROVED' && p.user.role === 'USER') await tx.user.update({ where: { id: p.user.id }, data: { role: 'DRIVER' } });
    });
    const msg = decision === 'APPROVED'
      ? 'Welcome to Kuwana delivery! Your driver account is approved. Top up your float in the app, go online and start taking jobs.'
      : decision === 'REJECTED' ? `Your Kuwana driver application needs changes: ${note ?? 'see the app'}`
      : 'Your Kuwana driver account has been suspended. Contact Kuwana support.';
    await safeSms(p.user.phone, msg);
    return profileDto(await prisma.driverProfile.findUniqueOrThrow({ where: { id: driverId }, include: profileInclude }));
  },

  /** Change the highest parcel value a driver may carry */
  async setParcelCap(driverId: string, maxParcelValueUsd: number | null) {
    if (!(await prisma.driverProfile.findUnique({ where: { id: driverId }, select: { id: true } }))) throw new NotFoundError('Driver');
    await prisma.driverProfile.update({ where: { id: driverId }, data: { maxParcelValueUsd } });
    return profileDto(await prisma.driverProfile.findUniqueOrThrow({ where: { id: driverId }, include: profileInclude }));
  },

  /** Record cash a driver deposited with an agent (or correct a balance) */
  async adjustFloat(adminId: string, driverId: string, input: z.infer<typeof adjustSchema>) {
    if (!(await prisma.driverProfile.findUnique({ where: { id: driverId }, select: { id: true } }))) throw new NotFoundError('Driver');
    await prisma.$transaction((tx) =>
      moveWallet(tx, driverId, input.amountUsd > 0 ? 'FLOAT_DEPOSIT' : 'ADJUSTMENT', { available: input.amountUsd }, {
        reference: input.reference, memo: input.memo, actorId: adminId, insufficient: 'That would take the free float below zero',
      }),
    );
    return walletDto(driverId);
  },

  async adminWithdrawals(status: 'REQUESTED' | 'PAID' | 'REJECTED' = 'REQUESTED') {
    const rows = await prisma.driverWithdrawal.findMany({
      where: { status }, orderBy: { createdAt: 'asc' }, take: 200,
      include: { driver: { select: { id: true, user: { select: { phone: true, profile: { select: { fullName: true } } } } } } },
    });
    return rows.map((w) => ({
      id: w.id, driverId: w.driver.id, driverName: w.driver.user.profile?.fullName ?? 'Driver', bucket: w.bucket, amountUsd: w.amountUsd.toNumber(),
      method: w.method, destination: w.destination, status: w.status, externalRef: w.externalRef, note: w.note, createdAt: w.createdAt,
    }));
  },

  async markWithdrawalPaid(adminId: string, id: string, externalRef: string) {
    const { count } = await prisma.driverWithdrawal.updateMany({ where: { id, status: 'REQUESTED' }, data: { status: 'PAID', externalRef, handledById: adminId, handledAt: new Date() } });
    if (!count) throw new BadRequestError('This withdrawal has already been handled');
    const w = await prisma.driverWithdrawal.findUniqueOrThrow({ where: { id }, include: { driver: { select: { user: { select: { phone: true } } } } } });
    await safeSms(w.driver.user.phone, `Kuwana sent your $${w.amountUsd.toFixed(2)} withdrawal (ref ${externalRef}).`);
    return { id, status: 'PAID' };
  },

  async rejectWithdrawal(adminId: string, id: string, note: string) {
    await prisma.$transaction(async (tx) => {
      const { count } = await tx.driverWithdrawal.updateMany({ where: { id, status: 'REQUESTED' }, data: { status: 'REJECTED', note, handledById: adminId, handledAt: new Date() } });
      if (!count) throw new BadRequestError('This withdrawal has already been handled');
      const w = await tx.driverWithdrawal.findUniqueOrThrow({ where: { id } });
      await moveWallet(tx, w.driverId, 'ADJUSTMENT', w.bucket === 'FLOAT' ? { available: w.amountUsd } : { earnings: w.amountUsd }, { memo: `Withdrawal rejected: ${note}`, actorId: adminId });
    });
    return { id, status: 'REJECTED' };
  },
};

registerPaymentPurpose('DRIVER_FLOAT', {
  onSucceeded: (paymentId, paidAmount) => driversService.onDepositSucceeded(paymentId, paidAmount),
  onFailed: (paymentId, code) => driversService.onDepositFailed(paymentId, code),
});
