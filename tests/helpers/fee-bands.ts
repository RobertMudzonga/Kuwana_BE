import prisma from '../../src/lib/prisma';
import { replaceFeeBands } from '../../src/modules/delivery/fee-bands.service';

/** Bands the store-delivery assertions are written against */
export const TEST_BANDS = [
  { vehicleClass: 'BIKE' as const, maxKm: 3, customerFeeUsd: 2.5, driverFeeUsd: 1.8 },
  { vehicleClass: 'BIKE' as const, maxKm: 7, customerFeeUsd: 3.5, driverFeeUsd: 2.5 },
  { vehicleClass: 'BIKE' as const, maxKm: 15, customerFeeUsd: 5, driverFeeUsd: 3.6 },
  { vehicleClass: 'BIKE' as const, maxKm: 40, customerFeeUsd: 9.5, driverFeeUsd: 7 },
  { vehicleClass: 'CAR' as const, maxKm: 40, customerFeeUsd: 12, driverFeeUsd: 9 },
  { vehicleClass: 'BAKKIE' as const, maxKm: 40, customerFeeUsd: 25, driverFeeUsd: 19 },
];

/** Replace the (admin-editable) fee table for a test file; returns a function that puts the original back */
export async function pinFeeBands() {
  const saved = await prisma.deliveryFeeBand.findMany();
  await replaceFeeBands({ bands: TEST_BANDS });
  return async () => {
    if (!saved.length) return;
    await replaceFeeBands({
      bands: saved.map((b) => ({ vehicleClass: b.vehicleClass, maxKm: b.maxKm.toNumber(), customerFeeUsd: b.customerFeeUsd.toNumber(), driverFeeUsd: b.driverFeeUsd.toNumber() })),
    });
  };
}
