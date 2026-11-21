import { VehicleClass } from '@prisma/client';
import { z } from 'zod';
import prisma from '../../lib/prisma';
import { BadRequestError } from '../../middleware/error.middleware';
import { getFeeBands, invalidateFeeBands } from '../catalog/buybox.service';
import { FeeBand, VEHICLE_ORDER } from './fees';

const usd = z.number().min(0).max(1000).multipleOf(0.01);

/** The full band table; PUT replaces it */
export const replaceFeeBandsSchema = z.object({
  bands: z
    .array(
      z.object({
        vehicleClass: z.enum(['BIKE', 'CAR', 'BAKKIE']),
        maxKm: z.number().positive().max(500).multipleOf(0.01),
        customerFeeUsd: usd,
        driverFeeUsd: usd,
      }),
    )
    .min(1)
    .max(60),
});

export function feeBandsDto(rows: FeeBand[]) {
  return VEHICLE_ORDER.map((vehicleClass) => ({
    vehicleClass,
    bands: rows
      .filter((r) => r.vehicleClass === vehicleClass)
      .map((r) => ({ maxKm: Number(r.maxKm), customerFeeUsd: Number(r.customerFeeUsd), driverFeeUsd: Number(r.driverFeeUsd) }))
      .sort((a, b) => a.maxKm - b.maxKm),
  }));
}

export async function listFeeBands() {
  return feeBandsDto(await getFeeBands());
}

export async function replaceFeeBands(dto: z.infer<typeof replaceFeeBandsSchema>) {
  const seen = new Set<string>();
  for (const b of dto.bands) {
    const key = `${b.vehicleClass}:${b.maxKm}`;
    if (seen.has(key)) throw new BadRequestError(`Two ${b.vehicleClass} bands end at ${b.maxKm} km`);
    seen.add(key);
    if (b.driverFeeUsd > b.customerFeeUsd) {
      throw new BadRequestError(`${b.vehicleClass} up to ${b.maxKm} km: driver fee can't exceed the customer fee`);
    }
  }
  // Within a vehicle class, a longer band should never be cheaper than a shorter one
  for (const v of VEHICLE_ORDER) {
    const list = dto.bands.filter((b) => b.vehicleClass === (v as VehicleClass)).sort((a, b) => a.maxKm - b.maxKm);
    for (let i = 1; i < list.length; i++) {
      if (list[i].customerFeeUsd < list[i - 1].customerFeeUsd) {
        throw new BadRequestError(`${v}: the ${list[i].maxKm} km band is cheaper than the ${list[i - 1].maxKm} km band`);
      }
    }
  }
  await prisma.$transaction([
    prisma.deliveryFeeBand.deleteMany({}),
    prisma.deliveryFeeBand.createMany({ data: dto.bands }),
  ]);
  invalidateFeeBands();
  return listFeeBands();
}
