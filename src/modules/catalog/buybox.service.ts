import { Prisma, VehicleClass } from '@prisma/client';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { BadRequestError } from '../../middleware/error.middleware';
import { getMarketSettings } from '../market/market.settings';
import { FeeBand, ZoneTable } from '../delivery/fees';
import { BuyerLocation, rankOffers, RankOptions } from './buybox';

type Tx = Prisma.TransactionClient;

/** Offer fields the Buy Box needs, loaded the same way everywhere */
export const buyBoxOfferInclude = {
  seller: {
    select: {
      id: true,
      businessName: true,
      slug: true,
      isFirstParty: true,
      kycStatus: true,
      slaScore: true,
      disputeRate: true,
      ratingAvg: true,
      ratingCount: true,
    },
  },
  hub: { select: { id: true, code: true, name: true, cityId: true, lat: true, lng: true, city: { select: { id: true, name: true, slug: true, zone: true } } } },
  storeBranch: {
    select: {
      id: true,
      code: true,
      name: true,
      cityId: true,
      lat: true,
      lng: true,
      landmark: true,
      isActive: true,
      isPaused: true,
      operatingHours: true,
      suburbId: true,
      city: { select: { id: true, name: true, slug: true, zone: true } },
      suburb: { select: { id: true, name: true } },
    },
  },
  dispatchCity: { select: { id: true, name: true, slug: true, zone: true } },
} satisfies Prisma.OfferInclude;

export type OfferWithBuyBoxData = Prisma.OfferGetPayload<{ include: typeof buyBoxOfferInclude }>;

export function toCandidate(o: OfferWithBuyBoxData) {
  return { ...o, hub: o.hub, branch: o.storeBranch };
}

/** Where the buyer is, as precisely as we know it */
export interface ResolvedLocation extends BuyerLocation {
  city: { id: string; name: string; slug: string; zone: string } | null;
  suburb: { id: string; name: string } | null;
  /** How lat/lng were obtained */
  precision: 'GPS' | 'SUBURB' | 'CITY' | 'NONE';
}

export interface LocationQuery {
  city?: string;
  suburb?: string;
  lat?: number;
  lng?: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BAND_CACHE_MS = 60_000;
let bandCache: { rows: FeeBand[]; expiresAt: number } | null = null;

export async function getFeeBands(): Promise<FeeBand[]> {
  if (bandCache && bandCache.expiresAt > Date.now()) return bandCache.rows;
  const rows = await prisma.deliveryFeeBand.findMany({ orderBy: [{ vehicleClass: 'asc' }, { maxKm: 'asc' }] });
  bandCache = { rows, expiresAt: Date.now() + BAND_CACHE_MS };
  return rows;
}

export function invalidateFeeBands() {
  bandCache = null;
  zoneCache = null;
}

let zoneCache: { table: ZoneTable; expiresAt: number } | null = null;

/** Zone matrix and which suburb sits in which zone (active suburbs only) */
export async function getZoneTable(): Promise<ZoneTable> {
  if (zoneCache && zoneCache.expiresAt > Date.now()) return zoneCache.table;
  const [suburbs, rules] = await Promise.all([
    prisma.suburb.findMany({ where: { zoneId: { not: null }, isActive: true }, select: { id: true, zoneId: true } }),
    prisma.zonePricingRule.findMany(),
  ]);
  const table: ZoneTable = { suburbZone: new Map(suburbs.map((s) => [s.id, s.zoneId!])), rules };
  zoneCache = { table, expiresAt: Date.now() + BAND_CACHE_MS };
  return table;
}

/** Everything needed to price a store run */
export async function getDeliveryPricing() {
  const [bands, zones] = await Promise.all([getFeeBands(), getZoneTable()]);
  return { bands, zones };
}

export class BuyBoxService {
  /**
   * Turn city / suburb / GPS query params into a buyer location.
   * GPS wins; otherwise the suburb centre, then the city centre.
   */
  async resolveLocation(q: LocationQuery): Promise<ResolvedLocation> {
    const city = q.city
      ? await prisma.city.findFirst({
          where: UUID_RE.test(q.city) ? { id: q.city } : { slug: q.city.toLowerCase() },
          select: { id: true, name: true, slug: true, zone: true, lat: true, lng: true },
        })
      : null;
    if (q.city && !city) throw new BadRequestError(`Unknown city "${q.city}"`);
    const suburb = city && q.suburb
      ? await prisma.suburb.findFirst({
          where: UUID_RE.test(q.suburb) ? { id: q.suburb, cityId: city.id } : { cityId: city.id, name: { equals: q.suburb, mode: 'insensitive' } },
          select: { id: true, name: true, lat: true, lng: true },
        })
      : null;

    const cityDto = city ? { id: city.id, name: city.name, slug: city.slug, zone: city.zone } : null;
    const suburbDto = suburb ? { id: suburb.id, name: suburb.name } : null;
    const suburbId = suburb?.id ?? null;
    if (q.lat !== undefined && q.lng !== undefined) {
      return { cityId: city?.id ?? null, suburbId, lat: q.lat, lng: q.lng, city: cityDto, suburb: suburbDto, precision: 'GPS' };
    }
    if (suburb?.lat != null && suburb.lng != null) {
      return { cityId: city!.id, suburbId, lat: suburb.lat, lng: suburb.lng, city: cityDto, suburb: suburbDto, precision: 'SUBURB' };
    }
    if (city?.lat != null && city.lng != null) {
      return { cityId: city.id, suburbId, lat: city.lat, lng: city.lng, city: cityDto, suburb: suburbDto, precision: 'CITY' };
    }
    return { cityId: city?.id ?? null, suburbId, lat: null, lng: null, city: cityDto, suburb: suburbDto, precision: 'NONE' };
  }

  /** Ranking options for a live, buyer-specific ranking */
  async liveOptions(buyer: BuyerLocation | null, vehicleClass: VehicleClass, now = new Date()): Promise<RankOptions> {
    const [settings, { bands, zones }] = await Promise.all([getMarketSettings(), getDeliveryPricing()]);
    return {
      buyer,
      now,
      hubsEnabled: settings.hubsEnabled,
      delivery: { bands, zones, vehicleClass, maxRadiusKm: settings.maxDeliveryRadiusKm.toNumber() },
    };
  }

  /**
   * Re-rank a product's offers and persist the default (location- and time-free) winner on both
   * the offers and the product. Listing pages without a buyer location and price sorting use it.
   * The product row is locked so concurrent recomputes for the same product run one at a time.
   */
  async recomputeProduct(productId: string, tx?: Tx): Promise<string | null> {
    const run = async (db: Tx) => {
      const locked = await db.$queryRaw<{ status: string }[]>`
        SELECT status::text AS status FROM products WHERE id = ${productId} FOR UPDATE`;
      if (!locked.length) return null;

      const [offers, settings] = await Promise.all([
        db.offer.findMany({ where: { productId }, include: buyBoxOfferInclude }),
        getMarketSettings(),
      ]);
      const productActive = locked[0].status === 'ACTIVE';
      const result = productActive ? rankOffers(offers.map(toCandidate), { hubsEnabled: settings.hubsEnabled }) : null;
      const winner = result?.winner?.offer ?? null;

      await db.offer.updateMany({
        where: { productId, isBuyBoxWinner: true, ...(winner ? { id: { not: winner.id } } : {}) },
        data: { isBuyBoxWinner: false },
      });
      if (winner && !winner.isBuyBoxWinner) {
        await db.offer.update({ where: { id: winner.id }, data: { isBuyBoxWinner: true } });
      }
      await db.product.update({
        where: { id: productId },
        data: {
          buyBoxOfferId: winner?.id ?? null,
          buyBoxPriceUsd: winner?.priceUsd ?? null,
          inStock: !!winner,
          offerCount: result?.ranked.length ?? 0,
        },
      });
      return winner?.id ?? null;
    };

    return tx ? run(tx) : prisma.$transaction(run);
  }

  async recomputeProducts(productIds: Iterable<string>) {
    for (const id of new Set(productIds)) {
      await this.recomputeProduct(id);
    }
  }

  /** After a seller's KYC status or scores change, every product they sell may have a new winner */
  async recomputeForSeller(sellerId: string) {
    const rows = await prisma.offer.findMany({ where: { sellerId }, select: { productId: true }, distinct: ['productId'] });
    await this.recomputeProducts(rows.map((r) => r.productId));
    logger.info('Buy Box recomputed for seller', { sellerId, products: rows.length });
  }

  /** A branch was paused, closed or moved */
  async recomputeForBranch(branchId: string) {
    const rows = await prisma.offer.findMany({ where: { storeBranchId: branchId }, select: { productId: true }, distinct: ['productId'] });
    await this.recomputeProducts(rows.map((r) => r.productId));
  }

  /** Every product with offers, e.g. after hubs are switched on or off */
  async recomputeAll() {
    const rows = await prisma.offer.findMany({ select: { productId: true }, distinct: ['productId'] });
    await this.recomputeProducts(rows.map((r) => r.productId));
    logger.info('Buy Box recomputed for all products', { products: rows.length });
    return rows.length;
  }
}

export const buyBoxService = new BuyBoxService();

/** Vehicle needed for a product: its own override, else its category's */
export function productVehicle(p: { requiredVehicleClass: VehicleClass | null; category: { requiredVehicleClass: VehicleClass } }): VehicleClass {
  return p.requiredVehicleClass ?? p.category.requiredVehicleClass;
}
