import { rankOffers, ProximityTier, BuyBoxCandidate } from '../src/modules/catalog/buybox';
import { usdToZwg, zwgToUsd, roundMoney, money } from '../src/modules/currency/currency.service';
import { collateralFor, quoteDelivery, requiredVehicle, vehicleCanCarry, FeeBand } from '../src/modules/delivery/fees';
import { isOpenAt, nextOpening, opensLabel, parseHours } from '../src/lib/opening-hours';
import { Prisma } from '@prisma/client';

const HARARE = 'city-hre';
const CHITUNGWIZA = 'city-ctg';
const BULAWAYO = 'city-byo';
const ALL_DAY = Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((d) => [d, [['00:00', '24:00']]]));
const NEVER = {};

const BANDS: FeeBand[] = [
  { vehicleClass: 'BIKE', maxKm: 3, customerFeeUsd: 2.5, driverFeeUsd: 1.8 },
  { vehicleClass: 'BIKE', maxKm: 7, customerFeeUsd: 3.5, driverFeeUsd: 2.5 },
  { vehicleClass: 'BIKE', maxKm: 15, customerFeeUsd: 5, driverFeeUsd: 3.6 },
  { vehicleClass: 'BIKE', maxKm: 40, customerFeeUsd: 9.5, driverFeeUsd: 7 },
  { vehicleClass: 'CAR', maxKm: 40, customerFeeUsd: 12, driverFeeUsd: 9 },
];
const delivery = { bands: BANDS, vehicleClass: 'BIKE' as const, maxRadiusKm: 40 };

/** Avondale, Harare */
const BUYER = { cityId: HARARE, lat: -17.799, lng: 31.038 };
const NOW = new Date('2026-11-21T10:00:00Z'); // Saturday 12:00 in Harare

let seq = 0;
type Opts = Partial<BuyBoxCandidate> & { sla?: number; disputes?: number; kyc?: string; rating?: number; at?: [number, number]; city?: string; hours?: unknown; paused?: boolean };
function offer(o: Opts = {}): BuyBoxCandidate {
  const { sla = 95, disputes = 1, kyc = 'APPROVED', rating = 4.5, at = [-17.8, 31.04], city = HARARE, hours = ALL_DAY, paused = false, ...rest } = o;
  seq++;
  return {
    id: `offer-${String(seq).padStart(3, '0')}`,
    priceUsd: 100,
    shippingFeeUsd: 0,
    stockQty: 10,
    isActive: true,
    fulfilmentType: 'SELLER_FULFILLED',
    prepTimeMins: 30,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    hub: null,
    branch: { cityId: city, lat: at[0], lng: at[1], isActive: true, isPaused: paused, operatingHours: hours },
    seller: { kycStatus: kyc, slaScore: sla, disputeRate: disputes, ratingAvg: rating },
    ...rest,
  };
}
const hubOffer = (o: Opts = {}) => offer({ fulfilmentType: 'PLATFORM_FULFILLED', branch: null, hub: { cityId: HARARE, lat: -17.858, lng: 31.008 }, ...o });

describe('Buy Box ranking', () => {
  it('explains why offers are not buyable', () => {
    const result = rankOffers([
      offer({ stockQty: 0 }),
      offer({ isActive: false }),
      offer({ kyc: 'PENDING' }),
      offer({ branch: null }),
      offer({ paused: true }),
      hubOffer(),
    ]);
    expect(result.winner).toBeNull();
    expect(result.ineligible.map((x) => x.reason).sort()).toEqual(
      ['BRANCH_UNAVAILABLE', 'HUBS_DISABLED', 'INACTIVE', 'NO_BRANCH', 'OUT_OF_STOCK', 'SELLER_NOT_APPROVED'],
    );
  });

  it('hub stock competes only while hubs are enabled', () => {
    const hub = hubOffer({ priceUsd: 90 });
    const store = offer({ priceUsd: 100 });
    expect(rankOffers([hub, store]).winner?.offer.id).toBe(store.id);
    expect(rankOffers([hub, store], { hubsEnabled: true }).winner?.offer.id).toBe(hub.id);
    expect(rankOffers([hubOffer({ hub: null })], { hubsEnabled: true }).ineligible[0].reason).toBe('MISSING_HUB');
  });

  it('without a location or clock, the cheapest approved offer wins', () => {
    const cheap = offer({ priceUsd: 90, hours: NEVER });
    const pricey = offer({ priceUsd: 95 });
    const r = rankOffers([pricey, cheap]);
    expect(r.winner?.offer.id).toBe(cheap.id);
    expect(r.winner).toMatchObject({ isOpen: null, distanceKm: null, deliveryFeeUsd: null });
  });

  it('ranks open stores before closed ones, even if the closed one is cheaper', () => {
    const closed = offer({ priceUsd: 80, hours: NEVER });
    const open = offer({ priceUsd: 100 });
    const r = rankOffers([closed, open], { buyer: BUYER, now: NOW, delivery });
    expect(r.winner?.offer.id).toBe(open.id);
    expect(r.ranked[1]).toMatchObject({ isOpen: false, opensAt: null });
  });

  it('prices delivery into the landed price, so a nearby store can beat a cheaper far one', () => {
    const near = offer({ priceUsd: 100, at: [-17.8, 31.04] }); // ~0.2 km → $2.50
    const far = offer({ priceUsd: 98, at: [-17.9, 31.0] }); // ~12 km → $5.00
    const r = rankOffers([far, near], { buyer: BUYER, now: NOW, delivery });
    expect(r.winner?.offer.id).toBe(near.id);
    expect(r.winner?.deliveryFeeUsd?.toString()).toBe('2.5');
    expect(r.winner?.landedPriceUsd.toString()).toBe('102.5');
    expect(r.ranked[1].landedPriceUsd.toString()).toBe('103');
  });

  it('prefers a store in the buyer\'s city over a cheaper one in a nearby town', () => {
    const chitungwiza = offer({ priceUsd: 80, city: CHITUNGWIZA, at: [-18.01, 31.061] }); // ~23 km
    const harare = offer({ priceUsd: 100, at: [-17.86, 31.04] });
    const r = rankOffers([chitungwiza, harare], { buyer: BUYER, now: NOW, delivery });
    expect(r.ranked.map((x) => [x.offer.id, x.tier])).toEqual([[harare.id, ProximityTier.SAME_CITY], [chitungwiza.id, ProximityTier.OTHER_CITY]]);
  });

  it('stores beyond the delivery radius or the vehicle\'s last band are out of range', () => {
    const bulawayo = offer({ priceUsd: 50, city: BULAWAYO, at: [-20.15, 28.58] });
    const local = offer();
    const r = rankOffers([bulawayo, local], { buyer: BUYER, now: NOW, delivery });
    expect(r.winner?.offer.id).toBe(local.id);
    expect(r.ineligible).toEqual([expect.objectContaining({ offer: bulawayo, reason: 'OUT_OF_RANGE' })]);
    expect(r.ineligible[0].distanceKm).toBeGreaterThan(300);

    // A tighter admin cap excludes a 12 km store too
    const twelveKm = offer({ at: [-17.9, 31.0] });
    expect(rankOffers([twelveKm], { buyer: BUYER, now: NOW, delivery: { ...delivery, maxRadiusKm: 10 } }).ineligible[0].reason).toBe('OUT_OF_RANGE');
  });

  it('uses the vehicle class\'s fee bands', () => {
    const r = rankOffers([offer()], { buyer: BUYER, now: NOW, delivery: { ...delivery, vehicleClass: 'CAR' } });
    expect(r.winner?.deliveryFeeUsd?.toString()).toBe('12');
  });

  it('breaks price ties on SLA, then rating, then dispute rate, then distance', () => {
    const base = { priceUsd: 100 };
    const lowSla = offer({ ...base, sla: 80 });
    const highSla = offer({ ...base, sla: 99 });
    expect(rankOffers([lowSla, highSla]).winner?.offer.id).toBe(highSla.id);

    const lowRating = offer({ ...base, rating: 3.9 });
    const highRating = offer({ ...base, rating: 4.8 });
    expect(rankOffers([lowRating, highRating]).winner?.offer.id).toBe(highRating.id);

    const manyDisputes = offer({ ...base, disputes: 6 });
    const fewDisputes = offer({ ...base, disputes: 0.5 });
    expect(rankOffers([manyDisputes, fewDisputes]).winner?.offer.id).toBe(fewDisputes.id);

    // Same fee band (both under 3 km), so distance breaks the tie
    const nearer = offer({ ...base, at: [-17.7995, 31.0385] });
    const further = offer({ ...base, at: [-17.81, 31.05] });
    expect(rankOffers([further, nearer], { buyer: BUYER, delivery }).winner?.offer.id).toBe(nearer.id);
  });

  it('compares money exactly, without float error', () => {
    const a = offer({ priceUsd: '0.10', shippingFeeUsd: '0.20' }); // 0.30 exactly
    const b = offer({ priceUsd: '0.30', shippingFeeUsd: '0.00' });
    const r = rankOffers([a, b]);
    expect(r.ranked[0].landedPriceUsd.equals(r.ranked[1].landedPriceUsd)).toBe(true);
  });

  it('is deterministic for otherwise identical offers', () => {
    const older = offer({ createdAt: new Date('2026-01-01') });
    const newer = offer({ createdAt: new Date('2026-06-01') });
    expect(rankOffers([newer, older]).winner?.offer.id).toBe(older.id);
    expect(rankOffers([older, newer]).winner?.offer.id).toBe(older.id);
  });
});

describe('Opening hours (Africa/Harare)', () => {
  const hours = { mon: [['08:00', '17:00']], sat: [['08:00', '13:00']] };

  it('is open inside an interval, in Harare time', () => {
    expect(isOpenAt(hours, new Date('2026-11-21T06:30:00Z'))).toBe(true); // Sat 08:30
    expect(isOpenAt(hours, new Date('2026-11-21T05:59:00Z'))).toBe(false); // Sat 07:59
    expect(isOpenAt(hours, new Date('2026-11-21T11:00:00Z'))).toBe(false); // Sat 13:00, closing time
  });

  it('finds the next opening across the week', () => {
    const satAfternoon = new Date('2026-11-21T12:00:00Z'); // Sat 14:00
    const next = nextOpening(hours, satAfternoon)!;
    expect(next.toISOString()).toBe('2026-11-23T06:00:00.000Z'); // Mon 08:00
    expect(opensLabel(next, satAfternoon)).toBe('Opens Mon 08:00');
    const sunEvening = new Date('2026-11-22T16:00:00Z'); // Sun 18:00
    expect(opensLabel(nextOpening(hours, sunEvening), sunEvening)).toBe('Opens tomorrow 08:00');
    expect(nextOpening({}, satAfternoon)).toBeNull();
  });

  it('treats malformed hours as closed', () => {
    expect(parseHours({ mon: [['25:00', '26:00']] })).toEqual({});
    expect(isOpenAt('nonsense', NOW)).toBe(false);
  });
});

describe('Delivery fees and collateral', () => {
  it('picks the first band that covers the distance', () => {
    expect(quoteDelivery(BANDS, 'BIKE', 3)?.customerFeeUsd.toString()).toBe('2.5');
    const q = quoteDelivery(BANDS, 'BIKE', 3.01)!;
    expect([q.customerFeeUsd.toString(), q.driverFeeUsd.toString(), q.marginUsd.toString()]).toEqual(['3.5', '2.5', '1']);
    expect(quoteDelivery(BANDS, 'BIKE', 41)).toBeNull();
    expect(quoteDelivery(BANDS, 'BAKKIE', 1)).toBeNull();
    expect(quoteDelivery(BANDS, 'BIKE', 20, 15)).toBeNull();
  });

  it('a shipment needs its biggest item\'s vehicle; bigger vehicles carry smaller parcels', () => {
    expect(requiredVehicle(['BIKE', 'CAR', 'BIKE'])).toBe('CAR');
    expect(requiredVehicle([])).toBe('BIKE');
    expect(vehicleCanCarry('BAKKIE', 'BIKE')).toBe(true);
    expect(vehicleCanCarry('BIKE', 'CAR')).toBe(false);
  });

  it('collateral is the parcel value plus the buffer, rounded up to the cent', () => {
    expect(collateralFor(182.5, 0).toString()).toBe('182.5');
    expect(collateralFor(100, 10).toString()).toBe('110');
    expect(collateralFor('33.33', 5).toString()).toBe('35'); // 34.9965 → 35.00
  });
});

describe('Currency conversion', () => {
  it('converts USD to ZiG and rounds half-up to cents', () => {
    expect(usdToZwg(19.99, 26.75).toString()).toBe('534.73'); // 534.7325
    expect(usdToZwg(1, '0.125').toString()).toBe('0.13');
    expect(usdToZwg('5.49', '26.75').toNumber()).toBe(146.86); // 146.8575
  });

  it('converts ZiG to USD for price filters', () => {
    expect(zwgToUsd(5000, 26.75).toString()).toBe('186.92');
  });

  it('roundMoney avoids float drift', () => {
    expect(roundMoney(0.1 + 0.2).toString()).toBe('0.3');
    expect(roundMoney('2.675').toString()).toBe('2.68'); // a float would give 2.67
  });

  it('money() returns both currencies, or null ZiG without a rate', () => {
    const rate = { id: 'r', rate: new Prisma.Decimal('26.75'), effectiveFrom: new Date() };
    expect(money(189, rate)).toEqual({ usd: 189, zwg: 5055.75 });
    expect(money(189, null)).toEqual({ usd: 189, zwg: null });
  });
});
