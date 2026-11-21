import { MarketSettings, Prisma } from '@prisma/client';
import { z } from 'zod';
import prisma from '../../lib/prisma';

const CACHE_MS = 30_000;
let cached: { value: MarketSettings; expiresAt: number } | null = null;

export async function getMarketSettings(): Promise<MarketSettings> {
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = await prisma.marketSettings.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
  cached = { value, expiresAt: Date.now() + CACHE_MS };
  return value;
}

const money = z.number().min(0).max(100_000).multipleOf(0.01);

export const updateMarketSettingsSchema = z
  .object({
    freeDeliveryThresholdUsd: money,
    metroNextDayFeeUsd: money,
    metroSameDayFeeUsd: money,
    sameDayCutoffHour: z.number().int().min(0).max(23),
    intercityFeeUsd: money,
    pickupFeeUsd: money,
    intercityPickupFeeUsd: money,
    heavyThresholdKg: z.number().min(0).max(1000),
    heavySurchargePerKgUsd: money,
    codEnabled: z.boolean(),
    codMaxOrderUsd: money,
    codMinTrustScore: z.number().int().min(0).max(100),
    codFeeUsd: money,
    paymentTimeoutMinutes: z.number().int().min(5).max(24 * 60),
    codOtpTimeoutMinutes: z.number().int().min(5).max(120),
    sellerHoldDays: z.number().int().min(0).max(60),
    minPayoutUsd: money,
    returnWindowDays: z.number().int().min(0).max(60),
    maxDeliveryAttempts: z.number().int().min(1).max(5),
    hubsEnabled: z.boolean(),
    collateralBufferPct: z.number().min(0).max(100).multipleOf(0.01),
    jobBroadcastRadiusKm: z.number().min(1).max(100),
    maxDeliveryRadiusKm: z.number().min(1).max(200),
    storeAcceptSlaMinutes: z.number().int().min(5).max(240),
    escrowHoldHours: z.number().int().min(0).max(24 * 30),
    pickupPointDiscountPct: z.number().min(0).max(100),
    codDepositRequired: z.boolean(),
    driverMaxActiveJobs: z.number().int().min(1).max(10),
  })
  .partial();

export async function updateMarketSettings(dto: z.infer<typeof updateMarketSettingsSchema>) {
  const before = await getMarketSettings();
  const value = await prisma.marketSettings.upsert({ where: { id: 1 }, update: dto, create: { id: 1, ...dto } });
  cached = null;
  if (dto.hubsEnabled !== undefined && dto.hubsEnabled !== before.hubsEnabled) {
    // Hub offers join or leave every Buy Box (imported lazily: buybox.service reads these settings)
    const { buyBoxService } = await import('../catalog/buybox.service');
    await buyBoxService.recomputeAll();
  }
  return value;
}

/** Drop the cached row (tests that change settings directly) */
export function invalidateMarketSettings() {
  cached = null;
}

/** Plain numbers for API responses */
export function settingsDto(s: MarketSettings) {
  const n = (d: Prisma.Decimal) => d.toNumber();
  return {
    freeDeliveryThresholdUsd: n(s.freeDeliveryThresholdUsd),
    metroNextDayFeeUsd: n(s.metroNextDayFeeUsd),
    metroSameDayFeeUsd: n(s.metroSameDayFeeUsd),
    sameDayCutoffHour: s.sameDayCutoffHour,
    intercityFeeUsd: n(s.intercityFeeUsd),
    pickupFeeUsd: n(s.pickupFeeUsd),
    intercityPickupFeeUsd: n(s.intercityPickupFeeUsd),
    heavyThresholdKg: n(s.heavyThresholdKg),
    heavySurchargePerKgUsd: n(s.heavySurchargePerKgUsd),
    codEnabled: s.codEnabled,
    codMaxOrderUsd: n(s.codMaxOrderUsd),
    codMinTrustScore: s.codMinTrustScore,
    codFeeUsd: n(s.codFeeUsd),
    paymentTimeoutMinutes: s.paymentTimeoutMinutes,
    codOtpTimeoutMinutes: s.codOtpTimeoutMinutes,
    sellerHoldDays: s.sellerHoldDays,
    minPayoutUsd: n(s.minPayoutUsd),
    returnWindowDays: s.returnWindowDays,
    maxDeliveryAttempts: s.maxDeliveryAttempts,
    hubsEnabled: s.hubsEnabled,
    collateralBufferPct: n(s.collateralBufferPct),
    jobBroadcastRadiusKm: n(s.jobBroadcastRadiusKm),
    maxDeliveryRadiusKm: n(s.maxDeliveryRadiusKm),
    storeAcceptSlaMinutes: s.storeAcceptSlaMinutes,
    escrowHoldHours: s.escrowHoldHours,
    pickupPointDiscountPct: n(s.pickupPointDiscountPct),
    codDepositRequired: s.codDepositRequired,
    driverMaxActiveJobs: s.driverMaxActiveJobs,
  };
}
