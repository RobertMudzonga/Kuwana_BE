import { planShipments, codEligibility, codSplit, paymentMethodOptions, PricedLine, PricingSettings, Destination, StoreOrigin } from '../src/modules/market/pricing';
import { FeeBand } from '../src/modules/delivery/fees';

const settings: PricingSettings = {
  freeDeliveryThresholdUsd: 50,
  metroNextDayFeeUsd: 3,
  metroSameDayFeeUsd: 6,
  sameDayCutoffHour: 12,
  intercityFeeUsd: 7,
  pickupFeeUsd: 1.5,
  intercityPickupFeeUsd: 4,
  heavyThresholdKg: 10,
  heavySurchargePerKgUsd: 0.5,
  codEnabled: true,
  codMaxOrderUsd: 150,
  codMinTrustScore: 40,
  codFeeUsd: 1,
  pickupPointDiscountPct: 40,
  maxDeliveryRadiusKm: 40,
  codDepositRequired: true,
};

const BANDS: FeeBand[] = [
  { vehicleClass: 'BIKE', maxKm: 3, customerFeeUsd: 2.5, driverFeeUsd: 1.8 },
  { vehicleClass: 'BIKE', maxKm: 7, customerFeeUsd: 3.5, driverFeeUsd: 2.5 },
  { vehicleClass: 'BIKE', maxKm: 40, customerFeeUsd: 9.5, driverFeeUsd: 7 },
  { vehicleClass: 'CAR', maxKm: 40, customerFeeUsd: 12, driverFeeUsd: 9 },
];
const ALL_DAY = Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((d) => [d, [['00:00', '24:00']]]));

const HRE = 'hre';
const BYO = 'byo';
/** Avondale, Harare */
const harare: Destination = { cityId: HRE, zone: 'METRO', codEligible: true, lat: -17.799, lng: 31.038 };
const mutare: Destination = { cityId: 'mut', zone: 'INTERCITY', codEligible: false, lat: -18.97, lng: 32.67 };
/** 09:00 and 14:00 in Harare (UTC+2) */
const MORNING = new Date('2026-11-20T07:00:00Z');
const AFTERNOON = new Date('2026-11-20T12:00:00Z');

function hubLine(o: Partial<PricedLine> = {}): PricedLine {
  return {
    offerId: `o-${Math.random()}`, quantity: 1, unitPriceUsd: 10, shippingFeeUsd: 0,
    fulfilmentType: 'PLATFORM_FULFILLED', hubId: 'hub-hre', hubCityId: HRE, hubCityName: 'Harare',
    sellerId: 'kuwana', sellerName: 'Kuwana Retail', dispatchCityId: null, dispatchCityName: null,
    leadTimeDays: 1, weightKg: 1, branch: null, prepTimeMins: 30, vehicleClass: 'BIKE', ...o,
  };
}

/** Store branches ~0.2 km and ~6.8 km from the Avondale buyer */
const avondaleShop: StoreOrigin = { id: 'b-avo', name: 'Avondale', sellerName: 'Harare Gadget Hub', cityId: HRE, suburb: 'Avondale', lat: -17.7995, lng: 31.0385, operatingHours: ALL_DAY };
const mbareShop: StoreOrigin = { id: 'b-mba', name: 'Mbare Musika', sellerName: 'Mbare Wholesalers', cityId: HRE, suburb: 'Mbare', lat: -17.86, lng: 31.04, operatingHours: ALL_DAY };
const storeLine = (o: Partial<PricedLine> = {}) =>
  hubLine({ fulfilmentType: 'SELLER_FULFILLED', hubId: null, hubCityId: null, hubCityName: null, sellerId: 's1', sellerName: 'Harare Gadget Hub', dispatchCityId: HRE, dispatchCityName: 'Harare', branch: avondaleShop, prepTimeMins: 20, ...o });
const sellerLine = (o: Partial<PricedLine> = {}) =>
  hubLine({ fulfilmentType: 'SELLER_FULFILLED', hubId: null, hubCityId: null, hubCityName: null, sellerId: 's1', sellerName: 'Mbare Wholesalers', dispatchCityId: HRE, dispatchCityName: 'Harare', leadTimeDays: 2, ...o });

const plan = (lines: PricedLine[], o: Partial<Parameters<typeof planShipments>[1]> = {}) =>
  planShipments(lines, { destination: harare, mode: 'DELIVERY', speed: 'STANDARD', settings, bands: BANDS, now: MORNING, ...o });

describe('Shipment splitting', () => {
  it('groups by hub and by seller location, platform parcels first', () => {
    const p = plan([
      sellerLine({ offerId: 'a' }),
      hubLine({ offerId: 'b' }),
      hubLine({ offerId: 'c' }),
      hubLine({ offerId: 'd', hubId: 'hub-byo', hubCityId: BYO, hubCityName: 'Bulawayo' }),
      sellerLine({ offerId: 'e', sellerId: 's2', sellerName: 'Other' }),
    ]);
    expect(p.shipments.map((s) => s.lines.map((l) => l.offerId))).toEqual([['b', 'c'], ['d'], ['a'], ['e']]);
    expect(p.shipments[0].label).toBe('Kuwana · Harare warehouse');
    expect(p.shipments[2].label).toBe('Mbare Wholesalers · ships from Harare');
  });

  it('leaves fees unpriced until a destination is known', () => {
    const p = plan([hubLine()], { destination: null });
    expect(p.shipments[0].feeUsd).toBeNull();
    expect(p.deliveryFeeUsd.toNumber()).toBe(0);
    expect(p.express).toEqual({ available: false, reason: 'Choose where to deliver' });
  });
});

describe('Delivery tiers and fees', () => {
  it('local metro hub stock goes next-day for $3', () => {
    const [s] = plan([hubLine()]).shipments;
    expect([s.tier, s.feeUsd?.toNumber(), s.etaMinDays, s.etaMaxDays]).toEqual(['METRO_NEXT_DAY', 3, 1, 1]);
  });

  it('express is same-day for $6 before the cutoff, and unavailable after it', () => {
    const before = plan([hubLine()], { speed: 'EXPRESS' });
    expect([before.shipments[0].tier, before.shipments[0].feeUsd?.toNumber(), before.shipments[0].etaMaxDays]).toEqual(['METRO_SAME_DAY', 6, 0]);
    expect(before.express.available).toBe(true);

    const after = plan([hubLine()], { speed: 'EXPRESS', now: AFTERNOON });
    expect(after.shipments[0].tier).toBe('METRO_NEXT_DAY');
    expect(after.express).toEqual({ available: false, reason: 'Order before 12:00 for same-day delivery' });
  });

  it('stock from another city, or an intercity destination, goes by courier for $7', () => {
    const otherHub = plan([hubLine({ hubId: 'hub-byo', hubCityId: BYO, hubCityName: 'Bulawayo' })]);
    expect([otherHub.shipments[0].tier, otherHub.shipments[0].feeUsd?.toNumber(), otherHub.shipments[0].etaMinDays]).toEqual(['INTERCITY_COURIER', 7, 2]);
    expect(plan([hubLine()], { destination: mutare }).shipments[0].tier).toBe('INTERCITY_COURIER');
    expect(plan([hubLine()], { destination: mutare, speed: 'EXPRESS' }).express.reason).toBe('Same-day delivery is available in Harare and Bulawayo');
  });

  it('pickup points cost $1.50 locally and $4 intercity', () => {
    expect(plan([hubLine()], { mode: 'PICKUP' }).shipments[0].feeUsd?.toNumber()).toBe(1.5);
    const far = plan([hubLine()], { mode: 'PICKUP', destination: mutare }).shipments[0];
    expect([far.tier, far.feeUsd?.toNumber(), far.etaMinDays, far.etaMaxDays]).toEqual(['PICKUP_POINT', 4, 2, 5]);
  });

  it('adds $0.50 per started kg above 10 kg', () => {
    // 2 × 5.6 kg = 11.2 kg → 2 kg over (rounded up) → $1 surcharge
    const [s] = plan([hubLine({ quantity: 2, weightKg: 5.6 })]).shipments;
    expect(s.weightKg.toNumber()).toBe(11.2);
    expect(s.feeUsd?.toNumber()).toBe(4);
  });

  it('seller shipping is the highest seller fee in the parcel, after their lead time', () => {
    const [s] = plan([sellerLine({ shippingFeeUsd: 2 }), sellerLine({ shippingFeeUsd: 3.5, leadTimeDays: 3 })]).shipments;
    expect([s.tier, s.feeUsd?.toNumber(), s.etaMinDays, s.etaMaxDays]).toEqual(['SELLER_COURIER', 3.5, 4, 5]);
  });
});

describe('Free delivery', () => {
  it('waives standard platform fees at $50 but not seller shipping', () => {
    const p = plan([hubLine({ unitPriceUsd: 45 }), sellerLine({ unitPriceUsd: 5, shippingFeeUsd: 2 })]);
    expect(p.freeDelivery.qualifies).toBe(true);
    expect(p.shipments[0].feeUsd?.toNumber()).toBe(0);
    expect(p.shipments[0].feeWaived).toBe(true);
    expect(p.deliveryFeeUsd.toNumber()).toBe(0);
    expect(p.sellerShippingUsd.toNumber()).toBe(2);
  });

  it('still charges the same-day premium and heavy surcharge', () => {
    const p = plan([hubLine({ unitPriceUsd: 60, weightKg: 12 })], { speed: 'EXPRESS' });
    // $6 same-day − $3 next-day waived = $3 premium, + 2 kg × $0.50
    expect(p.shipments[0].feeUsd?.toNumber()).toBe(4);
  });

  it('reports how much more is needed', () => {
    const p = plan([hubLine({ unitPriceUsd: 19.99, quantity: 2 })]);
    expect(p.freeDelivery.qualifies).toBe(false);
    expect(p.freeDelivery.remainingUsd.toNumber()).toBe(10.02);
  });
});

describe('Cash on delivery eligibility', () => {
  const ok = { settings, mode: 'DELIVERY' as const, destination: harare, orderTotalUsd: 100, depositUsd: 4.5, depositPayable: true, buyer: { trustScore: 50, phoneVerified: true }, isGift: false };

  it('is allowed for a verified, trusted buyer in Harare under the cap', () => {
    expect(codEligibility(ok)).toEqual({ eligible: true, reasons: [] });
  });

  it('counts the COD fee against the cap', () => {
    expect(codEligibility({ ...ok, orderTotalUsd: 149.5 }).eligible).toBe(false);
    expect(codEligibility({ ...ok, orderTotalUsd: 149 }).eligible).toBe(true);
  });

  it('lists every reason it is refused', () => {
    const r = codEligibility({ ...ok, destination: mutare, buyer: { trustScore: 10, phoneVerified: false }, isGift: true });
    expect(r.eligible).toBe(false);
    expect(r.reasons).toEqual([
      'Cash on delivery is only available in Harare and Bulawayo',
      'Verify your phone number to pay cash on delivery',
      'Cash on delivery is not available on your account; please pay online',
      'Cash on delivery is only for orders you receive yourself',
    ]);
  });

  it('needs EcoCash or InnBucks for the deposit, unless nothing is due upfront', () => {
    expect(codEligibility({ ...ok, depositPayable: false }).reasons).toEqual([
      'Cash on delivery needs the delivery fee paid upfront by EcoCash or InnBucks, which is unavailable right now',
    ]);
    expect(codEligibility({ ...ok, depositPayable: false, depositUsd: 0 }).eligible).toBe(true);
  });

  it('asks signed-out buyers to sign in', () => {
    expect(codEligibility({ ...ok, buyer: null }).reasons).toEqual(['Sign in to pay cash on delivery']);
  });
});

describe('Payment method options', () => {
  const base = { currency: 'USD' as const, gatewaySupports: () => true, walletBalanceUsd: 20, totalUsd: 15, cod: { eligible: false, reasons: ['nope'] } };
  const byMethod = (opts: ReturnType<typeof paymentMethodOptions>) => Object.fromEntries(opts.map((o) => [o.method, o]));

  it('cards and wallet need USD', () => {
    const m = byMethod(paymentMethodOptions({ ...base, currency: 'ZWG' }));
    expect(m.CARD.available).toBe(false);
    expect(m.WALLET.available).toBe(false);
    expect(m.ECOCASH.available).toBe(true);
  });

  it('wallet needs enough balance', () => {
    expect(byMethod(paymentMethodOptions(base)).WALLET.available).toBe(true);
    const low = byMethod(paymentMethodOptions({ ...base, totalUsd: 25 })).WALLET;
    expect(low).toMatchObject({ available: false, reason: 'Wallet balance is $20.00' });
  });

  it('cash follows COD eligibility; others follow the gateway', () => {
    const m = byMethod(paymentMethodOptions({ ...base, gatewaySupports: (x) => x !== 'INNBUCKS' }));
    expect(m.CASH).toMatchObject({ available: false, reason: 'nope' });
    expect(m.INNBUCKS.available).toBe(false);
  });
});

describe('Store runs (zero-warehouse)', () => {
  it('splits one parcel per branch, labelled with the store and suburb', () => {
    const p = plan([storeLine({ offerId: 'a' }), storeLine({ offerId: 'b', branch: mbareShop, sellerName: 'Mbare Wholesalers' }), storeLine({ offerId: 'c' })]);
    expect(p.shipments.map((s) => s.lines.map((l) => l.offerId))).toEqual([['a', 'c'], ['b']]);
    expect(p.shipments.map((s) => [s.label, s.tier, s.storeBranchId])).toEqual([
      ['Harare Gadget Hub · Avondale', 'STORE_DELIVERY', 'b-avo'],
      ['Mbare Wholesalers · Mbare', 'STORE_DELIVERY', 'b-mba'],
    ]);
  });

  it('prices by distance band and records the driver fee; delivery is platform revenue', () => {
    const p = plan([storeLine(), storeLine({ branch: mbareShop })]);
    const [near, far] = p.shipments;
    expect([near.feeUsd?.toNumber(), near.driverFeeUsd?.toNumber(), near.distanceKm! < 1]).toEqual([2.5, 1.8, true]);
    expect([far.feeUsd?.toNumber(), far.driverFeeUsd?.toNumber()]).toEqual([3.5, 2.5]);
    expect(p.deliveryFeeUsd.toNumber()).toBe(6);
    expect(p.sellerShippingUsd.toNumber()).toBe(0);
  });

  it('uses the biggest item\'s vehicle', () => {
    const [s] = plan([storeLine(), storeLine({ vehicleClass: 'CAR' })]).shipments;
    expect([s.vehicleClass, s.feeUsd?.toNumber()]).toEqual(['CAR', 12]);
  });

  it('discounts pickup-point drops, for buyer and driver alike', () => {
    const [s] = plan([storeLine({ branch: mbareShop })], { mode: 'PICKUP' }).shipments;
    expect([s.tier, s.feeUsd?.toNumber(), s.driverFeeUsd?.toNumber()]).toEqual(['PICKUP_POINT', 2.1, 1.5]);
  });

  it('free delivery waives the buyer\'s fee but the driver is still paid', () => {
    const [s] = plan([storeLine({ unitPriceUsd: 60 })]).shipments;
    expect([s.feeUsd?.toNumber(), s.feeWaived, s.driverFeeUsd?.toNumber()]).toEqual([0, true, 1.8]);
  });

  it('flags parcels too far to deliver, and unknown drop-off locations', () => {
    const p = plan([storeLine()], { destination: mutare });
    expect(p.shipments[0].feeUsd).toBeNull();
    expect(p.undeliverable).toEqual([{ key: 'BRANCH:b-avo', label: 'Harare Gadget Hub · Avondale', reason: expect.stringMatching(/km away, too far to deliver$/) }]);
    const nowhere = plan([storeLine()], { destination: { ...harare, lat: null, lng: null } });
    expect(nowhere.undeliverable[0].reason).toMatch(/could not locate/);
  });

  it('estimates minutes to the door; a closed store starts when it opens', () => {
    const [open] = plan([storeLine()]).shipments;
    expect([open.etaMinutes, open.etaMinDays, open.opensAt]).toEqual([35, 0, null]); // 20 prep + 15 + ~0.2 km
    const shut = plan([storeLine({ branch: { ...avondaleShop, operatingHours: { fri: [['10:00', '17:00']] } } })]).shipments[0];
    // 09:00 Friday → opens 10:00: 60 min wait + 35
    expect([shut.opensAt?.toISOString(), shut.etaMinutes]).toEqual(['2026-11-20T08:00:00.000Z', 95]);
  });

  it('cash on delivery: fees are deposited upfront, goods paid in cash', () => {
    const s = codSplit(54.5, 50, true);
    expect([s.depositUsd.toNumber(), s.cashDueUsd.toNumber()]).toEqual([4.5, 50]);
    const off = codSplit(54.5, 50, false);
    expect([off.depositUsd.toNumber(), off.cashDueUsd.toNumber()]).toEqual([0, 54.5]);
  });
});
