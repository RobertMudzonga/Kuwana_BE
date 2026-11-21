import { opensLabel } from '../../lib/opening-hours';
import { storeEtaMinutes } from '../delivery/fees';
import { money, RateSnapshot } from '../currency/currency.service';
import { ProximityTier, RankedOffer } from './buybox';
import { OfferWithBuyBoxData, toCandidate } from './buybox.service';

export type City = { id: string; name: string; slug: string; zone: string };

type Ranked = RankedOffer<ReturnType<typeof toCandidate>>;

/** Rough ETA in minutes: prep time plus ~3 min/km on a bike in city traffic, plus pickup slack */
export function etaMinutes(prepTimeMins: number, distanceKm: number | null): number | null {
  if (distanceKm === null) return null;
  return storeEtaMinutes(prepTimeMins, distanceKm);
}

function etaText(mins: number): string {
  if (mins < 90) return `~${Math.max(15, Math.round(mins / 5) * 5)} min`;
  const h = Math.round(mins / 30) / 2;
  return `~${h} h`;
}

/**
 * Plain-language availability for an offer, from the buyer's point of view.
 */
export function availabilityLabel(offer: OfferWithBuyBoxData, ranked: Ranked | null, now: Date): string {
  if (!ranked) return offer.stockQty > 0 ? 'Unavailable' : 'Out of stock';
  if (offer.fulfilmentType === 'PLATFORM_FULFILLED') {
    return `In stock · ${offer.hub?.city.name ?? 'warehouse'} hub`;
  }
  const where = offer.storeBranch!.suburb?.name ?? offer.storeBranch!.city.name;
  if (ranked.isOpen === false) {
    return `${opensLabel(ranked.opensAt, now)} · ${where}`;
  }
  const eta = etaMinutes(offer.prepTimeMins, ranked.distanceKm);
  if (eta !== null) return `Delivered in ${etaText(eta)} · from ${where}`;
  return `In stock at ${where}${ranked.tier === ProximityTier.OTHER_CITY ? `, ${offer.storeBranch!.city.name}` : ''}`;
}

export function toOfferDto(
  offer: OfferWithBuyBoxData,
  opts: { ranked: Ranked | null; isWinner: boolean; rate: RateSnapshot | null; now?: Date },
) {
  const { ranked, rate } = opts;
  const now = opts.now ?? new Date();
  const b = offer.storeBranch;
  return {
    id: offer.id,
    isBuyBoxWinner: opts.isWinner,
    seller: {
      id: offer.seller.id,
      name: offer.seller.businessName,
      slug: offer.seller.slug,
      isFirstParty: offer.seller.isFirstParty,
      ratingAvg: offer.seller.ratingAvg,
      ratingCount: offer.seller.ratingCount,
      slaScore: offer.seller.slaScore.toNumber(),
    },
    branch: b
      ? {
          id: b.id,
          code: b.code,
          name: b.name,
          suburb: b.suburb?.name ?? null,
          city: b.city.name,
          landmark: b.landmark,
        }
      : null,
    price: money(offer.priceUsd, rate),
    listPrice: offer.listPriceUsd && offer.listPriceUsd.gt(offer.priceUsd) ? money(offer.listPriceUsd, rate) : null,
    shippingFee: money(offer.shippingFeeUsd, rate),
    /** Estimated delivery to the buyer's location (null without a location) */
    deliveryFee: ranked?.deliveryFeeUsd ? money(ranked.deliveryFeeUsd, rate) : null,
    landedPrice: money(ranked?.landedPriceUsd ?? offer.priceUsd.plus(offer.shippingFeeUsd), rate),
    distanceKm: ranked?.distanceKm != null ? Math.round(ranked.distanceKm * 10) / 10 : null,
    etaMinutes: ranked && ranked.isOpen !== false ? etaMinutes(offer.prepTimeMins, ranked.distanceKm) : null,
    isOpenNow: ranked?.isOpen ?? null,
    opensAt: ranked?.opensAt ?? null,
    prepTimeMins: offer.prepTimeMins,
    fulfilmentType: offer.fulfilmentType,
    hub: offer.hub ? { code: offer.hub.code, name: offer.hub.name, city: offer.hub.city.name } : null,
    stockQty: offer.stockQty,
    /** Show "Only N left" below this */
    lowStock: offer.stockQty > 0 && offer.stockQty <= 5,
    proximity: ranked ? ProximityTier[ranked.tier] : null,
    availability: availabilityLabel(offer, ranked, now),
  };
}

export type OfferDto = ReturnType<typeof toOfferDto>;
