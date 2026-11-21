import { Prisma, VehicleClass } from '@prisma/client';

/**
 * Delivery fees for store-to-door runs — pure functions, no database access.
 * Fees come from admin-editable bands keyed by vehicle class and straight-line distance.
 */

type Numeric = Prisma.Decimal | number | string;
const Decimal = Prisma.Decimal;

export const VEHICLE_ORDER: VehicleClass[] = ['BIKE', 'CAR', 'BAKKIE'];

export interface FeeBand {
  vehicleClass: VehicleClass;
  maxKm: Numeric;
  customerFeeUsd: Numeric;
  driverFeeUsd: Numeric;
}

export interface DeliveryQuote {
  vehicleClass: VehicleClass;
  distanceKm: number;
  customerFeeUsd: Prisma.Decimal;
  driverFeeUsd: Prisma.Decimal;
  /** Platform's delivery margin */
  marginUsd: Prisma.Decimal;
  /** ZONE: an admin zone-matrix rule priced it; BAND: the distance bands did */
  source: 'ZONE' | 'BAND';
  /** Upper end of the distance band used (BAND only) */
  bandMaxKm: number | null;
}

/** Admin zone matrix: (origin zone, destination zone, vehicle) → fee */
export interface ZoneRule {
  originZoneId: string;
  destinationZoneId: string;
  vehicleClass: VehicleClass;
  customerFeeUsd: Numeric;
  driverPayoutUsd: Numeric;
  customerPerKmUsd: Numeric;
  driverPerKmUsd: Numeric;
}

export interface ZoneTable {
  /** suburbId → zoneId, for zoned suburbs only */
  suburbZone: Map<string, string>;
  rules: ZoneRule[];
}

/** Both ends of a run, by suburb, for zone pricing */
export interface RunEnds {
  originSuburbId?: string | null;
  destinationSuburbId?: string | null;
}

/**
 * The zone rule for a run, or null when either end is unzoned or no rule covers the pair.
 * A rule A→B also covers B→A unless B→A has its own.
 */
export function zoneRuleFor(table: ZoneTable | null | undefined, ends: RunEnds | null | undefined, vehicleClass: VehicleClass): ZoneRule | null {
  if (!table || !ends?.originSuburbId || !ends.destinationSuburbId) return null;
  const from = table.suburbZone.get(ends.originSuburbId);
  const to = table.suburbZone.get(ends.destinationSuburbId);
  if (!from || !to) return null;
  const match = (o: string, d: string) => table.rules.find((r) => r.vehicleClass === vehicleClass && r.originZoneId === o && r.destinationZoneId === d);
  return match(from, to) ?? match(to, from) ?? null;
}

/** The larger of two vehicle classes (a shipment needs the biggest vehicle any item needs) */
export function largerVehicle(a: VehicleClass, b: VehicleClass): VehicleClass {
  return VEHICLE_ORDER.indexOf(a) >= VEHICLE_ORDER.indexOf(b) ? a : b;
}

export function requiredVehicle(classes: Iterable<VehicleClass>): VehicleClass {
  let v: VehicleClass = 'BIKE';
  for (const c of classes) v = largerVehicle(v, c);
  return v;
}

/** Whether a driver's vehicle can carry a job (a bakkie can carry a bike parcel, not the reverse) */
export function vehicleCanCarry(driver: VehicleClass, required: VehicleClass): boolean {
  return VEHICLE_ORDER.indexOf(driver) >= VEHICLE_ORDER.indexOf(required);
}

/**
 * Price a run. Returns null when the distance is beyond the vehicle's last band or
 * the admin radius cap, i.e. the store can't deliver to this buyer.
 */
export function quoteDelivery(
  bands: FeeBand[],
  vehicleClass: VehicleClass,
  distanceKm: number,
  maxRadiusKm?: number,
): DeliveryQuote | null {
  if (!Number.isFinite(distanceKm) || distanceKm < 0) return null;
  if (maxRadiusKm !== undefined && distanceKm > maxRadiusKm) return null;
  const band = bands
    .filter((b) => b.vehicleClass === vehicleClass)
    .sort((a, b) => new Decimal(a.maxKm).comparedTo(b.maxKm))
    .find((b) => new Decimal(distanceKm).lte(b.maxKm));
  if (!band) return null;
  const customerFeeUsd = new Decimal(band.customerFeeUsd);
  const driverFeeUsd = new Decimal(band.driverFeeUsd);
  return {
    vehicleClass,
    distanceKm: Math.round(distanceKm * 100) / 100,
    customerFeeUsd,
    driverFeeUsd,
    marginUsd: customerFeeUsd.minus(driverFeeUsd),
    source: 'BAND',
    bandMaxKm: new Decimal(band.maxKm).toNumber(),
  };
}

/**
 * Price a run: the zone matrix when both suburbs are zoned and a rule exists, else the distance bands.
 * The radius cap applies either way. Zone fee = base + per-km × straight-line km (driver likewise),
 * and the driver never gets more than the customer pays.
 */
export function quoteRun(
  bands: FeeBand[],
  vehicleClass: VehicleClass,
  distanceKm: number,
  maxRadiusKm?: number,
  zones?: { table: ZoneTable | null | undefined; ends: RunEnds | null | undefined } | null,
): DeliveryQuote | null {
  if (!Number.isFinite(distanceKm) || distanceKm < 0) return null;
  if (maxRadiusKm !== undefined && distanceKm > maxRadiusKm) return null;
  const rule = zoneRuleFor(zones?.table, zones?.ends, vehicleClass);
  if (!rule) return quoteDelivery(bands, vehicleClass, distanceKm, maxRadiusKm);
  const km = new Decimal(distanceKm);
  const customerFeeUsd = new Decimal(rule.customerFeeUsd).plus(km.times(rule.customerPerKmUsd)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const driverFeeUsd = Decimal.min(
    new Decimal(rule.driverPayoutUsd).plus(km.times(rule.driverPerKmUsd)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP),
    customerFeeUsd,
  );
  return {
    vehicleClass,
    distanceKm: Math.round(distanceKm * 100) / 100,
    customerFeeUsd,
    driverFeeUsd,
    marginUsd: customerFeeUsd.minus(driverFeeUsd),
    source: 'ZONE',
    bandMaxKm: null,
  };
}

/** Cheapest fee for a vehicle class — a "from $X" estimate when the buyer's location is unknown */
export function minimumFee(bands: FeeBand[], vehicleClass: VehicleClass): Prisma.Decimal | null {
  const fees = bands.filter((b) => b.vehicleClass === vehicleClass).map((b) => new Decimal(b.customerFeeUsd));
  return fees.length ? Decimal.min(...fees) : null;
}

/**
 * Collateral a driver must lock to claim a job. The driver holds either the goods or the cash
 * collected for them, never both, so exposure is the parcel value (plus an optional buffer).
 */
export function collateralFor(parcelValueUsd: Numeric, bufferPct: Numeric): Prisma.Decimal {
  const value = new Decimal(parcelValueUsd);
  return value.plus(value.times(bufferPct).dividedBy(100)).toDecimalPlaces(2, Decimal.ROUND_UP);
}

/** Rough door-to-door minutes for a store run: packing + ~15 min pickup slack + ~3 min/km on a bike in town */
export function storeEtaMinutes(prepTimeMins: number, distanceKm: number): number {
  return Math.round(prepTimeMins + 15 + distanceKm * 3);
}
