import { Prisma, VehicleClass } from '@prisma/client';
import { roundMoney } from '../currency/currency.service';
import { haversineDistanceKm } from '../../lib/geo';
import { isOpenAt, nextOpening } from '../../lib/opening-hours';
import { FeeBand, quoteRun, requiredVehicle, storeEtaMinutes, ZoneTable } from '../delivery/fees';

/**
 * Marketplace checkout rules — pure functions, no database access.
 * Shipment splitting, delivery tiers/fees/ETAs, free delivery, COD eligibility
 * and which payment methods a buyer may use.
 */

const Decimal = Prisma.Decimal;
type Decimal = Prisma.Decimal;
type Numeric = Decimal | number | string;

export type FulfilmentMethod = 'PLATFORM_FULFILLED' | 'SELLER_FULFILLED';
export type DeliveryMode = 'DELIVERY' | 'PICKUP';
export type DeliverySpeed = 'STANDARD' | 'EXPRESS';
export type DeliveryTier = 'METRO_SAME_DAY' | 'METRO_NEXT_DAY' | 'INTERCITY_COURIER' | 'PICKUP_POINT' | 'SELLER_COURIER' | 'STORE_DELIVERY';
export type Currency = 'USD' | 'ZWG';
export type PaymentMethod = 'ECOCASH' | 'ONEMONEY' | 'INNBUCKS' | 'ZIMSWITCH' | 'CARD' | 'WALLET' | 'CASH';

export interface PricingSettings {
  freeDeliveryThresholdUsd: Numeric;
  metroNextDayFeeUsd: Numeric;
  metroSameDayFeeUsd: Numeric;
  sameDayCutoffHour: number;
  intercityFeeUsd: Numeric;
  pickupFeeUsd: Numeric;
  intercityPickupFeeUsd: Numeric;
  heavyThresholdKg: Numeric;
  heavySurchargePerKgUsd: Numeric;
  codEnabled: boolean;
  codMaxOrderUsd: Numeric;
  codMinTrustScore: number;
  codFeeUsd: Numeric;
  /** Store runs: discount when delivering to a pickup point (drivers batch these) */
  pickupPointDiscountPct: Numeric;
  maxDeliveryRadiusKm: Numeric;
  codDepositRequired: boolean;
}

export interface PricedLine {
  offerId: string;
  quantity: number;
  unitPriceUsd: Numeric;
  /** Seller's shipping charge (per shipment) for SELLER_FULFILLED offers */
  shippingFeeUsd: Numeric;
  fulfilmentType: FulfilmentMethod;
  hubId: string | null;
  hubCityId: string | null;
  hubCityName: string | null;
  sellerId: string;
  sellerName: string;
  dispatchCityId: string | null;
  dispatchCityName: string | null;
  leadTimeDays: number;
  /** Per unit; null when unknown */
  weightKg: Numeric | null;
  /** Store branch holding the stock (zero-warehouse model) */
  branch: StoreOrigin | null;
  prepTimeMins: number;
  vehicleClass: VehicleClass;
}

export interface StoreOrigin {
  id: string;
  name: string;
  sellerName: string;
  cityId: string;
  suburb: string | null;
  /** For zone-matrix pricing */
  suburbId?: string | null;
  lat: number;
  lng: number;
  operatingHours: unknown;
}

export interface Destination {
  cityId: string;
  zone: 'METRO' | 'INTERCITY';
  codEligible: boolean;
  /** Drop-off point: GPS pin, else suburb or city centre; null when unknown */
  lat: number | null;
  lng: number | null;
  /** Drop-off suburb, for zone-matrix pricing */
  suburbId?: string | null;
}

export interface PlannedShipment {
  /** Stable grouping key: PLATFORM:<hubId> or SELLER:<sellerId>:<dispatchCityId> */
  key: string;
  sourceType: FulfilmentMethod;
  hubId: string | null;
  sellerId: string | null;
  dispatchCityId: string | null;
  label: string;
  lines: PricedLine[];
  weightKg: Decimal;
  tier: DeliveryTier | null;
  /** Fee before free delivery is applied (null when no destination yet) */
  baseFeeUsd: Decimal | null;
  /** What the buyer pays for this shipment */
  feeUsd: Decimal | null;
  /** True when free delivery waived (part of) the fee */
  feeWaived: boolean;
  etaMinDays: number | null;
  etaMaxDays: number | null;
  /** Could go same-day if EXPRESS were chosen */
  expressEligible: boolean;
  /** Store runs only */
  storeBranchId: string | null;
  distanceKm: number | null;
  vehicleClass: VehicleClass | null;
  /** Platform's cost: what the driver is paid */
  driverFeeUsd: Decimal | null;
  etaMinutes: number | null;
  /** The branch is closed now and packs this when it opens */
  opensAt: Date | null;
  /** Why this parcel can't be delivered to the chosen destination */
  undeliverable: string | null;
}

export interface ShipmentPlan {
  shipments: PlannedShipment[];
  itemsSubtotalUsd: Decimal;
  /** Platform delivery charges after free delivery */
  deliveryFeeUsd: Decimal;
  sellerShippingUsd: Decimal;
  freeDelivery: { thresholdUsd: Decimal; qualifies: boolean; remainingUsd: Decimal };
  express: { available: boolean; reason: string | null };
  /** Parcels that can't reach the destination (too far from the store) */
  undeliverable: { key: string; label: string; reason: string }[];
}

const STORE_EXTRAS = { storeBranchId: null, distanceKm: null, vehicleClass: null, driverFeeUsd: null, etaMinutes: null, opensAt: null, undeliverable: null };

/** Whole days between two instants in Harare local time (0 = same day) */
function harareDayDiff(from: Date, to: Date): number {
  const day = (d: Date) => Math.floor((d.getTime() + 2 * 3_600_000) / 86_400_000);
  return Math.max(0, day(to) - day(from));
}

/** Current hour in Zimbabwe (CAT, UTC+2, no daylight saving) */
export function harareHour(now: Date): number {
  return (now.getUTCHours() + 2) % 24;
}

function heavySurcharge(weightKg: Decimal, s: PricingSettings): Decimal {
  const over = weightKg.minus(s.heavyThresholdKg);
  if (over.lte(0)) return new Decimal(0);
  return roundMoney(over.ceil().times(s.heavySurchargePerKgUsd));
}

/** Group cart lines into shipments: one per hub, one per seller dispatch location */
type GroupedShipment = Pick<PlannedShipment, 'key' | 'sourceType' | 'hubId' | 'sellerId' | 'dispatchCityId' | 'label' | 'lines' | 'weightKg'>;

export function groupShipments(lines: PricedLine[]): GroupedShipment[] {
  const groups = new Map<string, PricedLine[]>();
  for (const line of lines) {
    const key = line.fulfilmentType === 'PLATFORM_FULFILLED'
      ? `PLATFORM:${line.hubId}`
      : line.branch
        ? `BRANCH:${line.branch.id}`
        : `SELLER:${line.sellerId}:${line.dispatchCityId ?? '-'}`;
    groups.set(key, [...(groups.get(key) ?? []), line]);
  }
  return [...groups.entries()]
    // Platform parcels first, then sellers; cart order within each (sort is stable)
    .sort(([a], [b]) => Number(b.startsWith('PLATFORM')) - Number(a.startsWith('PLATFORM')))
    .map(([key, group]) => {
      const first = group[0];
      const platform = first.fulfilmentType === 'PLATFORM_FULFILLED';
      const weightKg = group.reduce((w, l) => w.plus(new Decimal(l.weightKg ?? 0).times(l.quantity)), new Decimal(0));
      return {
        key,
        sourceType: first.fulfilmentType,
        hubId: platform ? first.hubId : null,
        sellerId: platform ? null : first.sellerId,
        dispatchCityId: platform ? first.hubCityId : first.dispatchCityId,
        label: platform
          ? (first.hubCityName ? `Kuwana · ${first.hubCityName} warehouse` : 'Kuwana warehouse')
          : first.branch
            ? `${first.sellerName} · ${first.branch.suburb ?? first.branch.name}`
            : `${first.sellerName}${first.dispatchCityName ? ` · ships from ${first.dispatchCityName}` : ''}`,
        lines: group,
        weightKg,
      };
    });
}

/**
 * Price and schedule every shipment for a destination.
 * Free delivery (items subtotal ≥ threshold) waives standard platform delivery fees;
 * same-day express still pays its premium over next-day, and heavy surcharges still apply.
 * Seller shipping is set by sellers and never waived.
 */
export function planShipments(
  lines: PricedLine[],
  opts: { destination: Destination | null; mode: DeliveryMode; speed: DeliverySpeed; settings: PricingSettings; bands?: FeeBand[]; zones?: ZoneTable | null; now?: Date },
): ShipmentPlan {
  const s = opts.settings;
  const now = opts.now ?? new Date();
  const itemsSubtotalUsd = lines.reduce((sum, l) => sum.plus(roundMoney(new Decimal(l.unitPriceUsd).times(l.quantity))), new Decimal(0));
  const threshold = new Decimal(s.freeDeliveryThresholdUsd);
  const qualifies = threshold.gt(0) && itemsSubtotalUsd.gte(threshold);
  const beforeCutoff = harareHour(now) < s.sameDayCutoffHour;

  const shipments: PlannedShipment[] = groupShipments(lines).map((g) => {
    const dest = opts.destination;
    const branch = g.lines[0].branch;
    if (!dest) {
      return {
        ...g, ...STORE_EXTRAS, storeBranchId: branch?.id ?? null, vehicleClass: branch ? requiredVehicle(g.lines.map((l) => l.vehicleClass)) : null,
        tier: null, baseFeeUsd: null, feeUsd: null, feeWaived: false, etaMinDays: null, etaMaxDays: null, expressEligible: false,
      };
    }
    const local = g.dispatchCityId === dest.cityId;

    if (branch) return planStoreShipment(g, branch, { dest, mode: opts.mode, settings: s, bands: opts.bands ?? [], zones: opts.zones ?? null, qualifies, now });

    if (g.sourceType === 'SELLER_FULFILLED') {
      const sellerFee = g.lines.reduce((max, l) => Decimal.max(max, new Decimal(l.shippingFeeUsd)), new Decimal(0));
      const lead = Math.max(...g.lines.map((l) => l.leadTimeDays));
      const [min, max] = opts.mode === 'PICKUP' ? [2, 5] : local ? [1, 2] : [2, 4];
      return {
        ...g,
        tier: opts.mode === 'PICKUP' ? 'PICKUP_POINT' : 'SELLER_COURIER',
        baseFeeUsd: sellerFee,
        feeUsd: sellerFee,
        feeWaived: false,
        etaMinDays: lead + min,
        etaMaxDays: lead + max,
        expressEligible: false,
        ...STORE_EXTRAS,
      };
    }

    const surcharge = heavySurcharge(g.weightKg, s);
    let tier: DeliveryTier;
    let standardFee: Decimal;
    let premium = new Decimal(0);
    let eta: [number, number];
    const expressEligible = opts.mode === 'DELIVERY' && local && dest.zone === 'METRO' && beforeCutoff;

    if (opts.mode === 'PICKUP') {
      tier = 'PICKUP_POINT';
      standardFee = new Decimal(local ? s.pickupFeeUsd : s.intercityPickupFeeUsd);
      eta = local ? [1, 2] : [2, 5];
    } else if (local && dest.zone === 'METRO') {
      standardFee = new Decimal(s.metroNextDayFeeUsd);
      if (opts.speed === 'EXPRESS' && expressEligible) {
        tier = 'METRO_SAME_DAY';
        premium = Decimal.max(new Decimal(s.metroSameDayFeeUsd).minus(standardFee), 0);
        eta = [0, 0];
      } else {
        tier = 'METRO_NEXT_DAY';
        eta = [1, 1];
      }
    } else {
      tier = 'INTERCITY_COURIER';
      standardFee = new Decimal(s.intercityFeeUsd);
      eta = [2, 4];
    }

    const baseFeeUsd = standardFee.plus(premium).plus(surcharge);
    const feeUsd = (qualifies ? new Decimal(0) : standardFee).plus(premium).plus(surcharge);
    return {
      ...g,
      tier,
      baseFeeUsd,
      feeUsd,
      feeWaived: qualifies && standardFee.gt(0),
      etaMinDays: eta[0],
      etaMaxDays: eta[1],
      expressEligible,
      ...STORE_EXTRAS,
    };
  });

  const platform = shipments.filter((sh) => sh.sourceType === 'PLATFORM_FULFILLED');
  const anyExpress = platform.some((sh) => sh.expressEligible);
  let reason: string | null = null;
  if (!anyExpress) {
    if (!opts.destination) reason = 'Choose where to deliver';
    else if (opts.mode === 'PICKUP') reason = 'Same-day is for home delivery';
    else if (opts.destination.zone !== 'METRO') reason = 'Same-day delivery is available in Harare and Bulawayo';
    else if (!platform.length) reason = 'Store orders are delivered as soon as they are packed';
    else if (!beforeCutoff) reason = `Order before ${s.sameDayCutoffHour}:00 for same-day delivery`;
    else reason = 'These items ship from another city';
  }

  // Platform delivery = hub parcels + store runs (Kuwana pays the driver); seller shipping = legacy courier parcels
  const platformDelivered = shipments.filter((sh) => sh.sourceType === 'PLATFORM_FULFILLED' || sh.storeBranchId);
  return {
    shipments,
    itemsSubtotalUsd,
    deliveryFeeUsd: platformDelivered.reduce((sum, sh) => sum.plus(sh.feeUsd ?? 0), new Decimal(0)),
    sellerShippingUsd: shipments.filter((sh) => sh.sourceType === 'SELLER_FULFILLED' && !sh.storeBranchId).reduce((sum, sh) => sum.plus(sh.feeUsd ?? 0), new Decimal(0)),
    freeDelivery: { thresholdUsd: threshold, qualifies, remainingUsd: Decimal.max(threshold.minus(itemsSubtotalUsd), 0) },
    express: { available: anyExpress, reason },
    undeliverable: shipments.filter((sh) => sh.undeliverable).map((sh) => ({ key: sh.key, label: sh.label, reason: sh.undeliverable! })),
  };
}

/**
 * A store run: a gig driver collects from the branch and drives to the door or a pickup point.
 * Fee comes from the zone matrix (both suburbs zoned) or else the distance band, for the biggest item's vehicle; a pickup-point drop is discounted
 * (drivers batch them). Free delivery waives the buyer's fee; the driver is still paid.
 */
export function planStoreShipment(
  g: GroupedShipment,
  branch: StoreOrigin,
  o: { dest: Destination; mode: DeliveryMode; settings: PricingSettings; bands: FeeBand[]; zones?: ZoneTable | null; qualifies: boolean; now: Date },
): PlannedShipment {
  const vehicleClass = requiredVehicle(g.lines.map((l) => l.vehicleClass));
  const prep = Math.max(...g.lines.map((l) => l.prepTimeMins));
  const tier: DeliveryTier = o.mode === 'PICKUP' ? 'PICKUP_POINT' : 'STORE_DELIVERY';
  const base = { ...g, tier, storeBranchId: branch.id, vehicleClass, expressEligible: false };

  if (o.dest.lat == null || o.dest.lng == null) {
    return { ...base, ...STORE_EXTRAS, storeBranchId: branch.id, vehicleClass, baseFeeUsd: null, feeUsd: null, feeWaived: false, etaMinDays: null, etaMaxDays: null, undeliverable: 'We could not locate this address; add a GPS pin or choose a suburb' };
  }
  const distanceKm = Math.round(haversineDistanceKm({ lat: branch.lat, lng: branch.lng }, { lat: o.dest.lat, lng: o.dest.lng }) * 100) / 100;
  const quote = quoteRun(o.bands, vehicleClass, distanceKm, Number(o.settings.maxDeliveryRadiusKm), {
    table: o.zones,
    ends: { originSuburbId: branch.suburbId ?? null, destinationSuburbId: o.dest.suburbId ?? null },
  });
  if (!quote) {
    return {
      ...base, ...STORE_EXTRAS, storeBranchId: branch.id, vehicleClass, distanceKm, baseFeeUsd: null, feeUsd: null, feeWaived: false, etaMinDays: null, etaMaxDays: null,
      undeliverable: `${branch.sellerName} (${branch.suburb ?? branch.name}) is ${Math.round(distanceKm)} km away, too far to deliver`,
    };
  }

  const keep = o.mode === 'PICKUP' ? new Decimal(100).minus(o.settings.pickupPointDiscountPct).dividedBy(100) : new Decimal(1);
  const baseFeeUsd = roundMoney(quote.customerFeeUsd.times(keep));
  const driverFeeUsd = roundMoney(quote.driverFeeUsd.times(keep));
  const feeUsd = o.qualifies ? new Decimal(0) : baseFeeUsd;

  const open = isOpenAt(branch.operatingHours, o.now);
  const opensAt = open ? null : nextOpening(branch.operatingHours, o.now);
  const startAt = opensAt ?? o.now;
  const etaMinutes = Math.round((startAt.getTime() - o.now.getTime()) / 60_000) + storeEtaMinutes(prep, distanceKm);
  const days = harareDayDiff(o.now, new Date(o.now.getTime() + etaMinutes * 60_000));

  return {
    ...base,
    baseFeeUsd,
    feeUsd,
    feeWaived: o.qualifies && baseFeeUsd.gt(0),
    etaMinDays: days,
    etaMaxDays: days,
    distanceKm,
    driverFeeUsd,
    etaMinutes,
    opensAt,
    undeliverable: null,
  };
}

/**
 * Cash on delivery split: with deposits on, the delivery and COD fees are paid upfront (non-refundable)
 * by EcoCash / InnBucks and the driver collects only the goods. With nothing to deposit (free delivery)
 * the order is confirmed by SMS code instead.
 */
export function codSplit(totalUsd: Numeric, itemsSubtotalUsd: Numeric, depositRequired: boolean): { depositUsd: Decimal; cashDueUsd: Decimal } {
  const total = new Decimal(totalUsd);
  if (!depositRequired) return { depositUsd: new Decimal(0), cashDueUsd: total };
  const depositUsd = roundMoney(Decimal.max(total.minus(itemsSubtotalUsd), 0));
  return { depositUsd, cashDueUsd: total.minus(depositUsd) };
}

/** Methods that can pay a COD deposit */
export const DEPOSIT_METHODS: PaymentMethod[] = ['ECOCASH', 'INNBUCKS'];

export interface CodContext {
  settings: PricingSettings;
  mode: DeliveryMode;
  destination: Destination | null;
  /** Order total before the COD fee */
  orderTotalUsd: Numeric;
  /** Can a deposit be charged right now (EcoCash / InnBucks available) — only matters when one is due */
  depositPayable: boolean;
  depositUsd: Numeric;
  /** null when the buyer isn't signed in */
  buyer: { trustScore: number; phoneVerified: boolean } | null;
  isGift: boolean;
}

/** Whether cash on delivery may be offered, with every reason it can't */
export function codEligibility(c: CodContext): { eligible: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!c.settings.codEnabled) reasons.push('Cash on delivery is currently unavailable');
  if (!c.destination) reasons.push('Choose a delivery address or pickup point');
  else if (!c.destination.codEligible) reasons.push('Cash on delivery is only available in Harare and Bulawayo');
  if (new Decimal(c.depositUsd).gt(0) && !c.depositPayable) reasons.push('Cash on delivery needs the delivery fee paid upfront by EcoCash or InnBucks, which is unavailable right now');
  if (new Decimal(c.orderTotalUsd).plus(c.settings.codFeeUsd).gt(c.settings.codMaxOrderUsd)) {
    reasons.push(`Cash on delivery is limited to orders up to $${new Decimal(c.settings.codMaxOrderUsd).toFixed(2)}`);
  }
  if (!c.buyer) {
    reasons.push('Sign in to pay cash on delivery');
  } else {
    if (!c.buyer.phoneVerified) reasons.push('Verify your phone number to pay cash on delivery');
    if (c.buyer.trustScore < c.settings.codMinTrustScore) reasons.push('Cash on delivery is not available on your account; please pay online');
  }
  if (c.isGift) reasons.push('Cash on delivery is only for orders you receive yourself');
  return { eligible: reasons.length === 0, reasons };
}

export interface MethodOption {
  method: PaymentMethod;
  label: string;
  available: boolean;
  reason?: string;
}

const LABELS: Record<PaymentMethod, string> = {
  ECOCASH: 'EcoCash',
  ONEMONEY: 'OneMoney',
  INNBUCKS: 'InnBucks',
  ZIMSWITCH: 'Zimswitch',
  CARD: 'Visa / Mastercard',
  WALLET: 'Kuwana wallet',
  CASH: 'Cash on delivery',
};

/** Payment methods in display order, with why any are unavailable */
export function paymentMethodOptions(c: {
  currency: Currency;
  gatewaySupports: (m: PaymentMethod) => boolean;
  walletBalanceUsd: Numeric | null;
  totalUsd: Numeric;
  cod: { eligible: boolean; reasons: string[] };
}): MethodOption[] {
  const order: PaymentMethod[] = ['ECOCASH', 'ONEMONEY', 'INNBUCKS', 'ZIMSWITCH', 'CARD', 'WALLET', 'CASH'];
  return order.map((method) => {
    const label = LABELS[method];
    if (method === 'CASH') return { method, label, available: c.cod.eligible, reason: c.cod.reasons[0] };
    if (method === 'WALLET') {
      if (c.currency !== 'USD') return { method, label, available: false, reason: 'Wallet credit is in USD; pay in USD to use it' };
      if (c.walletBalanceUsd === null) return { method, label, available: false, reason: 'Sign in to use your wallet' };
      const enough = new Decimal(c.walletBalanceUsd).gte(c.totalUsd);
      return { method, label, available: enough, reason: enough ? undefined : `Wallet balance is $${new Decimal(c.walletBalanceUsd).toFixed(2)}` };
    }
    if (method === 'CARD' && c.currency !== 'USD') return { method, label, available: false, reason: 'Cards are charged in USD' };
    if (!c.gatewaySupports(method)) return { method, label, available: false, reason: 'Not available right now' };
    return { method, label, available: true };
  });
}

export const TIER_LABELS: Record<DeliveryTier, string> = {
  METRO_SAME_DAY: 'Same-day delivery',
  METRO_NEXT_DAY: 'Next-day delivery',
  INTERCITY_COURIER: 'Courier delivery',
  PICKUP_POINT: 'Collect from pickup point',
  SELLER_COURIER: "Seller's courier",
  STORE_DELIVERY: 'Delivered from the store',
};
