import { Prisma, VehicleClass } from '@prisma/client';
import { haversineDistanceKm } from '../../lib/geo';
import { isOpenAt, nextOpening } from '../../lib/opening-hours';
import { FeeBand, quoteRun, ZoneTable } from '../delivery/fees';

/**
 * Buy Box ranking — pure functions, no database access.
 *
 * Zero-warehouse model: every offer is stock on a store branch's shelf. Eligible offers
 * (active, in stock, seller KYC approved, branch active and not paused, within delivery range
 * of the buyer) are ranked lexicographically:
 *   1. Open now: branches open at `now` before closed ones (skipped when `now` is not given,
 *      e.g. for the stored, location-free default winner)
 *   2. Proximity: a branch in the buyer's city before one in a neighbouring town
 *   3. Landed price in USD = item price + estimated delivery fee for that distance and vehicle
 *      (+ any legacy seller shipping fee). Within a city, distance is priced into the fee rather
 *      than ranked on its own, so a slightly further but cheaper store can still win.
 *   4. Store SLA score (higher first), rating (higher first), dispute rate (lower first)
 *   5. Tie-breaks for a stable result: shorter distance, shorter prep time, older offer, then id
 *
 * Hub (PLATFORM_FULFILLED) offers only take part while hubs are enabled in market settings;
 * a hub then ranks like a branch at the hub's location.
 */

type Numeric = Prisma.Decimal | number | string;
const Decimal = Prisma.Decimal;

export type FulfilmentMethod = 'PLATFORM_FULFILLED' | 'SELLER_FULFILLED';

export enum ProximityTier {
  /** Same city as the buyer (or buyer location unknown) */
  SAME_CITY = 0,
  /** Another town within delivery range */
  OTHER_CITY = 1,
}

export interface Origin {
  cityId: string;
  lat: number | null;
  lng: number | null;
}

export interface BuyBoxCandidate {
  id: string;
  priceUsd: Numeric;
  shippingFeeUsd: Numeric;
  stockQty: number;
  isActive: boolean;
  fulfilmentType: FulfilmentMethod;
  prepTimeMins: number;
  createdAt: Date;
  /** PLATFORM_FULFILLED: the hub holding the stock */
  hub: Origin | null;
  /** SELLER_FULFILLED: the branch holding the stock */
  branch: (Origin & { isActive: boolean; isPaused: boolean; operatingHours: unknown; suburbId?: string | null }) | null;
  seller: {
    kycStatus: string;
    slaScore: Numeric;
    disputeRate: Numeric;
    ratingAvg: number;
  };
}

export interface BuyerLocation {
  cityId?: string | null;
  /** Prices the run from the zone matrix when both ends are zoned */
  suburbId?: string | null;
  lat?: number | null;
  lng?: number | null;
}

export interface RankOptions {
  buyer?: BuyerLocation | null;
  /** Rank open branches first as of this moment */
  now?: Date | null;
  hubsEnabled?: boolean;
  /** Fee bands and radius cap for delivery estimates; without them landed price = price + shipping */
  delivery?: { bands: FeeBand[]; zones?: ZoneTable | null; vehicleClass: VehicleClass; maxRadiusKm: number } | null;
}

export type IneligibleReason =
  | 'INACTIVE'
  | 'OUT_OF_STOCK'
  | 'SELLER_NOT_APPROVED'
  | 'HUBS_DISABLED'
  | 'MISSING_HUB'
  | 'NO_BRANCH'
  | 'BRANCH_UNAVAILABLE'
  | 'OUT_OF_RANGE';

export interface RankedOffer<T extends BuyBoxCandidate> {
  offer: T;
  tier: ProximityTier;
  /** null when ranking without a clock */
  isOpen: boolean | null;
  /** When a closed branch next opens */
  opensAt: Date | null;
  /** Straight-line km from the stock to the buyer, when both locations are known */
  distanceKm: number | null;
  /** Estimated delivery fee for this buyer, when distance and fee bands are known */
  deliveryFeeUsd: Prisma.Decimal | null;
  landedPriceUsd: Prisma.Decimal;
}

export interface BuyBoxResult<T extends BuyBoxCandidate> {
  winner: RankedOffer<T> | null;
  /** Eligible offers, best first (winner included at index 0) */
  ranked: RankedOffer<T>[];
  ineligible: { offer: T; reason: IneligibleReason; distanceKm?: number | null }[];
}

export function originOf(offer: BuyBoxCandidate): Origin | null {
  return offer.fulfilmentType === 'PLATFORM_FULFILLED' ? offer.hub : offer.branch;
}

/** Reasons that don't depend on the buyer's location */
export function ineligibleReason(offer: BuyBoxCandidate, opts: Pick<RankOptions, 'hubsEnabled'> = {}): IneligibleReason | null {
  if (!offer.isActive) return 'INACTIVE';
  if (offer.seller.kycStatus !== 'APPROVED') return 'SELLER_NOT_APPROVED';
  if (offer.stockQty <= 0) return 'OUT_OF_STOCK';
  if (offer.fulfilmentType === 'PLATFORM_FULFILLED') {
    if (!opts.hubsEnabled) return 'HUBS_DISABLED';
    if (!offer.hub) return 'MISSING_HUB';
  } else {
    if (!offer.branch) return 'NO_BRANCH';
    if (!offer.branch.isActive || offer.branch.isPaused) return 'BRANCH_UNAVAILABLE';
  }
  return null;
}

function distanceBetween(origin: Origin, buyer: BuyerLocation | null | undefined): number | null {
  if (!buyer || buyer.lat == null || buyer.lng == null || origin.lat == null || origin.lng == null) return null;
  return haversineDistanceKm({ lat: origin.lat, lng: origin.lng }, { lat: buyer.lat, lng: buyer.lng });
}

/**
 * Rank one offer for a buyer, or explain why it can't be bought by them.
 */
export function evaluate<T extends BuyBoxCandidate>(
  offer: T,
  opts: RankOptions = {},
): { ranked: RankedOffer<T> } | { reason: IneligibleReason; distanceKm?: number | null } {
  const reason = ineligibleReason(offer, opts);
  if (reason) return { reason };
  const origin = originOf(offer)!;
  const buyer = opts.buyer;

  const distanceKm = distanceBetween(origin, buyer);
  let deliveryFeeUsd: Prisma.Decimal | null = null;
  if (distanceKm !== null && opts.delivery) {
    const quote = quoteRun(opts.delivery.bands, opts.delivery.vehicleClass, distanceKm, opts.delivery.maxRadiusKm, {
      table: opts.delivery.zones,
      ends: { originSuburbId: offer.branch?.suburbId ?? null, destinationSuburbId: buyer?.suburbId ?? null },
    });
    if (!quote) return { reason: 'OUT_OF_RANGE', distanceKm };
    deliveryFeeUsd = quote.customerFeeUsd;
  }

  const tier = buyer?.cityId && origin.cityId !== buyer.cityId ? ProximityTier.OTHER_CITY : ProximityTier.SAME_CITY;

  let isOpen: boolean | null = null;
  let opensAt: Date | null = null;
  if (opts.now) {
    if (offer.fulfilmentType === 'PLATFORM_FULFILLED') {
      isOpen = true; // hubs dispatch on their own schedule
    } else {
      isOpen = isOpenAt(offer.branch!.operatingHours, opts.now);
      if (!isOpen) opensAt = nextOpening(offer.branch!.operatingHours, opts.now);
    }
  }

  const landedPriceUsd = new Decimal(offer.priceUsd).plus(offer.shippingFeeUsd).plus(deliveryFeeUsd ?? 0);
  return { ranked: { offer, tier, isOpen, opensAt, distanceKm, deliveryFeeUsd, landedPriceUsd } };
}

function compare<T extends BuyBoxCandidate>(a: RankedOffer<T>, b: RankedOffer<T>): number {
  if (a.isOpen !== b.isOpen) return a.isOpen ? -1 : 1;

  if (a.tier !== b.tier) return a.tier - b.tier;

  const price = a.landedPriceUsd.comparedTo(b.landedPriceUsd);
  if (price !== 0) return price;

  const sla = new Decimal(b.offer.seller.slaScore).comparedTo(a.offer.seller.slaScore);
  if (sla !== 0) return sla;

  if (a.offer.seller.ratingAvg !== b.offer.seller.ratingAvg) return b.offer.seller.ratingAvg - a.offer.seller.ratingAvg;

  const disputes = new Decimal(a.offer.seller.disputeRate).comparedTo(b.offer.seller.disputeRate);
  if (disputes !== 0) return disputes;

  if (a.distanceKm !== null && b.distanceKm !== null && a.distanceKm !== b.distanceKm) return a.distanceKm - b.distanceKm;

  if (a.offer.prepTimeMins !== b.offer.prepTimeMins) return a.offer.prepTimeMins - b.offer.prepTimeMins;

  const age = a.offer.createdAt.getTime() - b.offer.createdAt.getTime();
  if (age !== 0) return age;

  return a.offer.id < b.offer.id ? -1 : a.offer.id > b.offer.id ? 1 : 0;
}

export function rankOffers<T extends BuyBoxCandidate>(offers: T[], opts: RankOptions = {}): BuyBoxResult<T> {
  const ranked: RankedOffer<T>[] = [];
  const ineligible: BuyBoxResult<T>['ineligible'] = [];

  for (const offer of offers) {
    const r = evaluate(offer, opts);
    if ('reason' in r) ineligible.push({ offer, reason: r.reason, distanceKm: r.distanceKm });
    else ranked.push(r.ranked);
  }

  ranked.sort(compare);
  return { winner: ranked[0] ?? null, ranked, ineligible };
}
