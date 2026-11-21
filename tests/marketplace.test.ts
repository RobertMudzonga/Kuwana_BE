import request from 'supertest';
import { createApp } from '../src/app';
import prisma from '../src/lib/prisma';
import { generateAccessToken } from '../src/middleware/auth.middleware';
import { currencyService } from '../src/modules/currency/currency.service';
import { invalidateMarketSettings } from '../src/modules/market/market.settings';

const app = createApp();
const api = '/api/v1';
const stamp = Date.now();
/** Unique search token so these tests only see their own products */
const token = `zq${stamp}`;

let adminToken: string;
let adminSellerId: string;
let buyerToken: string;
let sellerAToken: string;
let sellerAId: string;
let sellerBToken: string;
let sellerBId: string;
let cityA: { id: string; slug: string };
let cityB: { id: string; slug: string };
let hubA: string;
let hubB: string;
let branchA: string;
let branchB: string;
let branchBNearA: string;
let hubsWereEnabled = false;
let categoryId: string;
let brandId: string;
let phoneId: string;
let blenderId: string;
const createdRateIds: string[] = [];

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function register(label: string) {
  const res = await request(app).post(`${api}/auth/register`).send({
    email: `mkt_${label}_${stamp}@kuwana.test`,
    password: 'Test@12345',
    fullName: `Test ${label}`,
  });
  return { token: res.body.data.accessToken as string, id: res.body.data.user.id as string };
}

async function onboard(t: string, name: string, cityId: string) {
  return request(app).post(`${api}/sellers/onboard`).set(auth(t)).send({
    businessName: `${name} ${stamp}`,
    kycTier: 'REGISTERED',
    taxNumber: '200000001',
    phone: '+263771000000',
    cityId,
  });
}

const winnerOf = async (productId: string) =>
  (await prisma.product.findUniqueOrThrow({ where: { id: productId }, select: { buyBoxOfferId: true } })).buyBoxOfferId;

beforeAll(async () => {
  const admin = await prisma.user.create({
    data: { email: `mkt_admin_${stamp}@kuwana.test`, passwordHash: 'x', role: 'ADMIN', profile: { create: { fullName: 'Test Admin' } } },
  });
  adminToken = generateAccessToken({ sub: admin.id, role: 'ADMIN', email: admin.email });

  const [a, b] = await Promise.all([
    // ~260 km apart, so a store in one can't deliver to the other
    prisma.city.create({ data: { name: `Testa ${stamp}`, slug: `testa-${stamp}`, province: 'Test', zone: 'METRO', lat: -17.8, lng: 31.04 } }),
    prisma.city.create({ data: { name: `Testb ${stamp}`, slug: `testb-${stamp}`, province: 'Test', zone: 'INTERCITY', lat: -20.15, lng: 28.58 } }),
  ]);
  hubsWereEnabled = (await prisma.marketSettings.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } })).hubsEnabled;
  await prisma.marketSettings.update({ where: { id: 1 }, data: { hubsEnabled: false } });
  invalidateMarketSettings();
  cityA = a;
  cityB = b;
  hubA = (await prisma.hub.create({ data: { code: `TA-${stamp}`, name: 'Test Hub A', cityId: a.id, address: 'A' } })).id;
  hubB = (await prisma.hub.create({ data: { code: `TB-${stamp}`, name: 'Test Hub B', cityId: b.id, address: 'B' } })).id;

  // Admin's own retail account (1P), approved
  adminSellerId = (
    await prisma.sellerProfile.create({
      data: { userId: admin.id, businessName: `Test Retail ${stamp}`, slug: `test-retail-${stamp}`, isFirstParty: true, kycTier: 'REGISTERED', kycStatus: 'APPROVED', cityId: a.id },
    })
  ).id;

  ({ token: buyerToken } = await register('buyer'));
  ({ token: sellerAToken } = await register('sellera'));
  ({ token: sellerBToken } = await register('sellerb'));
});

afterAll(async () => {
  const users = await prisma.user.findMany({ where: { email: { endsWith: `${stamp}@kuwana.test` } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  await prisma.product.deleteMany({ where: { sku: { startsWith: `T${stamp}` } } });
  await prisma.sellerProfile.deleteMany({ where: { userId: { in: ids } } });
  await prisma.hub.deleteMany({ where: { id: { in: [hubA, hubB].filter(Boolean) } } });
  await prisma.city.deleteMany({ where: { slug: { in: [`testa-${stamp}`, `testb-${stamp}`] } } });
  await prisma.category.deleteMany({ where: { slug: `test-cat-${stamp}` } });
  await prisma.brand.deleteMany({ where: { slug: `testbrand${stamp}` } });
  await prisma.exchangeRate.deleteMany({ where: { id: { in: createdRateIds } } });
  await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.marketSettings.update({ where: { id: 1 }, data: { hubsEnabled: hubsWereEnabled } });
  currencyService.invalidate();
  await prisma.$disconnect();
});

describe('Exchange rates', () => {
  it('only admins can set a rate', async () => {
    const res = await request(app).post(`${api}/currency/rates`).set(auth(buyerToken)).send({ rate: 27 });
    expect(res.status).toBe(403);
  });

  it('rejects non-positive rates', async () => {
    const res = await request(app).post(`${api}/currency/rates`).set(auth(adminToken)).send({ rate: 0 });
    expect(res.status).toBe(422);
  });

  it('a scheduled rate does not change the current rate until it takes effect', async () => {
    const res = await request(app)
      .post(`${api}/currency/rates`)
      .set(auth(adminToken))
      .send({ rate: 99.5, effectiveFrom: '2099-01-01T00:00:00Z', note: 'test' });
    expect(res.status).toBe(201);
    createdRateIds.push(res.body.data.id);

    // The scheduled value must not apply early (compared by value, so other rate changes can't break this)
    const after = (await request(app).get(`${api}/currency/rate`)).body.data;
    expect(after?.rate).not.toBe(99.5);
    expect(new Date(after?.effectiveFrom ?? 0).getTime()).toBeLessThanOrEqual(Date.now());

    const future = await currencyService.getUsdToZwg(new Date('2099-06-01T00:00:00Z'));
    expect(future?.rate.toNumber()).toBe(99.5);

    const history = await request(app).get(`${api}/currency/rates`).set(auth(adminToken));
    expect(history.body.data.find((r: { id: string }) => r.id === res.body.data.id).status).toBe('SCHEDULED');
  });

  it('an immediate rate becomes current and is used for ZiG prices', async () => {
    const res = await request(app).post(`${api}/currency/rates`).set(auth(adminToken)).send({ rate: 30 });
    createdRateIds.push(res.body.data.id);
    const current = (await request(app).get(`${api}/currency/rate`)).body.data;
    expect(current.rate).toBe(30);
  });
});

describe('Catalog admin', () => {
  it('creates a category, brand and products', async () => {
    const cat = await request(app).post(`${api}/catalog/categories`).set(auth(adminToken)).send({ name: 'Test Cat', slug: `test-cat-${stamp}`, commissionRate: 7.5 });
    expect(cat.status).toBe(201);
    categoryId = cat.body.data.id;

    const brand = await request(app).post(`${api}/catalog/brands`).set(auth(adminToken)).send({ name: `TestBrand${stamp}` });
    expect(brand.status).toBe(201);
    brandId = brand.body.data.id;

    const phone = await request(app).post(`${api}/catalog/products`).set(auth(adminToken)).send({
      sku: `T${stamp}-PHONE`,
      title: `${token} Smartphone 128GB`,
      categoryId,
      brandId,
      specifications: { Storage: '128 GB', Colour: 'Midnight' },
      images: [{ url: 'https://example.com/p.png' }],
    });
    expect(phone.status).toBe(201);
    expect(phone.body.data.inStock).toBe(false);
    phoneId = phone.body.data.id;

    const blender = await request(app).post(`${api}/catalog/products`).set(auth(adminToken)).send({
      sku: `T${stamp}-BLEND`,
      title: `${token} Countertop Blender`,
      categoryId,
    });
    blenderId = blender.body.data.id;
  });

  it('rejects duplicate SKUs and non-admin writes', async () => {
    const dup = await request(app).post(`${api}/catalog/products`).set(auth(adminToken)).send({ sku: `T${stamp}-PHONE`, title: 'Dup', categoryId });
    expect(dup.status).toBe(409);
    const notAdmin = await request(app).post(`${api}/catalog/products`).set(auth(buyerToken)).send({ sku: `T${stamp}-X`, title: 'X', categoryId });
    expect(notAdmin.status).toBe(403);
  });

  it('lists drafts and archived products for admins only', async () => {
    const draft = await request(app).post(`${api}/catalog/products`).set(auth(adminToken)).send({
      sku: `T${stamp}-DRAFT`, title: `${token} Draft Heater`, categoryId, status: 'DRAFT',
    });
    expect(draft.status).toBe(201);
    expect(draft.body.data.categoryId).toBe(categoryId);

    const res = await request(app).get(`${api}/catalog/admin/products`).query({ q: `T${stamp}-DRAFT` }).set(auth(adminToken));
    expect(res.body.data).toEqual([expect.objectContaining({ status: 'DRAFT', category: 'Test Cat' })]);
    const publicSearch = await request(app).get(`${api}/catalog/products`).query({ q: `${token} heater` });
    // Buyers never see drafts
    expect(publicSearch.body.data.map((p: { id: string }) => p.id)).not.toContain(draft.body.data.id);
    expect((await request(app).get(`${api}/catalog/admin/products`).set(auth(buyerToken))).status).toBe(403);
  });

  it('refuses to move a category under itself', async () => {
    const res = await request(app).patch(`${api}/catalog/categories/${categoryId}`).set(auth(adminToken)).send({ parentId: categoryId });
    expect(res.status).toBe(400);
  });
});

describe('Seller onboarding', () => {
  it('requires a BP number for registered businesses', async () => {
    const res = await request(app).post(`${api}/sellers/onboard`).set(auth(sellerAToken)).send({
      businessName: 'No Tax', kycTier: 'REGISTERED', phone: '+263771000000', cityId: cityA.id,
    });
    expect(res.status).toBe(422);
  });

  it('creates a pending seller account, once', async () => {
    const res = await onboard(sellerAToken, 'Seller A', cityA.id);
    expect(res.status).toBe(201);
    expect(res.body.data.kycStatus).toBe('PENDING');
    sellerAId = res.body.data.id;
    expect((await onboard(sellerAToken, 'Seller A again', cityA.id)).status).toBe(409);

    const b = await onboard(sellerBToken, 'Seller B', cityB.id);
    sellerBId = b.body.data.id;
    await request(app).patch(`${api}/sellers/${sellerBId}/kyc`).set(auth(adminToken)).send({ status: 'APPROVED' });
  });

  it('hides pending sellers from the public', async () => {
    const me = await request(app).get(`${api}/sellers/me`).set(auth(sellerAToken));
    expect((await request(app).get(`${api}/sellers/${me.body.data.slug}`)).status).toBe(404);
  });
});

const ALL_DAY = { mon: [['00:00', '24:00']], tue: [['00:00', '24:00']], wed: [['00:00', '24:00']], thu: [['00:00', '24:00']], fri: [['00:00', '24:00']], sat: [['00:00', '24:00']], sun: [['00:00', '24:00']] };

describe('Store branches', () => {
  const branch = (cityId: string, lat: number, lng: number, extra: Record<string, unknown> = {}) => ({
    name: 'Main', cityId, address: '1 Test Street', landmark: 'Blue gate', lat, lng, operatingHours: ALL_DAY, ...extra,
  });

  it('validates location and opening hours', async () => {
    const otherCitySuburb = await prisma.suburb.create({ data: { cityId: cityB.id, name: `Sub ${stamp}` } });
    const bad = await request(app).post(`${api}/merchant/branches`).set(auth(sellerAToken)).send(branch(cityA.id, -17.8, 31.04, { suburbId: otherCitySuburb.id }));
    expect(bad.status).toBe(400);
    const hours = await request(app).post(`${api}/merchant/branches`).set(auth(sellerAToken)).send(branch(cityA.id, -17.8, 31.04, { operatingHours: { mon: [['17:00', '08:00']] } }));
    expect(hours.status).toBe(422);
    expect((await request(app).post(`${api}/merchant/branches`).set(auth(buyerToken)).send(branch(cityA.id, -17.8, 31.04))).status).toBe(403);
  });

  it('adds branches with a GPS pin and a unique code', async () => {
    const a = await request(app).post(`${api}/merchant/branches`).set(auth(sellerAToken)).send(branch(cityA.id, -17.801, 31.041));
    expect(a.status).toBe(201);
    expect(a.body.data).toMatchObject({ isOpenNow: true, isActive: true, landmark: 'Blue gate' });
    expect(a.body.data.code).toMatch(/^[A-Z0-9]+-[A-Z]+\d*$/);
    branchA = a.body.data.id;

    branchB = (await request(app).post(`${api}/merchant/branches`).set(auth(sellerBToken)).send(branch(cityB.id, -20.15, 28.58))).body.data.id;
    // Seller B also has a shop ~3 km from city A's centre
    const near = await request(app).post(`${api}/merchant/branches`).set(auth(sellerBToken)).send(branch(cityA.id, -17.78, 31.06, { name: 'Branch near A' }));
    branchBNearA = near.body.data.id;
    expect(near.body.data.code).not.toBe(a.body.data.code);

    const mine = await request(app).get(`${api}/merchant/branches`).set(auth(sellerBToken));
    expect(mine.body.data.map((b: { id: string }) => b.id).sort()).toEqual([branchB, branchBNearA].sort());
    // A branch is private to its store
    expect((await request(app).get(`${api}/merchant/branches/${branchB}`).set(auth(sellerAToken))).status).toBe(404);
  });
});

describe('Offers and the Buy Box', () => {
  let sellerBOfferId: string;
  let sellerBNearOfferId: string;
  let sellerAOfferId: string;

  it('a buyer without a seller account cannot list offers', async () => {
    const res = await request(app).post(`${api}/offers`).set(auth(buyerToken)).send({
      productId: phoneId, priceUsd: 100, stockQty: 5, fulfilmentType: 'SELLER_FULFILLED', storeBranchId: branchA,
    });
    expect(res.status).toBe(403);
  });

  it('store offers need one of the store\'s own branches', async () => {
    const none = await request(app).post(`${api}/offers`).set(auth(sellerBToken)).send({ productId: phoneId, priceUsd: 100, stockQty: 5, fulfilmentType: 'SELLER_FULFILLED' });
    expect(none.status).toBe(422);
    const other = await request(app).post(`${api}/offers`).set(auth(sellerBToken)).send({ productId: phoneId, priceUsd: 100, stockQty: 5, fulfilmentType: 'SELLER_FULFILLED', storeBranchId: branchA });
    expect(other.status).toBe(400);
  });

  it('only admins may list for another seller', async () => {
    const res = await request(app).post(`${api}/offers`).set(auth(sellerBToken)).send({
      productId: phoneId, sellerId: adminSellerId, priceUsd: 100, stockQty: 5, fulfilmentType: 'SELLER_FULFILLED', storeBranchId: branchB,
    });
    expect(res.status).toBe(403);
  });

  it('the first in-stock offer wins', async () => {
    const res = await request(app).post(`${api}/offers`).set(auth(sellerBToken)).send({
      productId: phoneId, priceUsd: 120, shippingFeeUsd: 2, stockQty: 6, fulfilmentType: 'SELLER_FULFILLED', storeBranchId: branchB, prepTimeMins: 45,
    });
    expect(res.status).toBe(201);
    sellerBOfferId = res.body.data.id;
    expect(res.body.data).toMatchObject({ isBuyBoxWinner: true, prepTimeMins: 45, branch: { id: branchB } });
    expect(await winnerOf(phoneId)).toBe(sellerBOfferId);
  });

  it('a pending seller\'s cheaper offer does not win until KYC is approved', async () => {
    const res = await request(app).post(`${api}/offers`).set(auth(sellerAToken)).send({
      productId: phoneId, priceUsd: 99, stockQty: 10, fulfilmentType: 'SELLER_FULFILLED', storeBranchId: branchA,
    });
    expect(res.status).toBe(201);
    sellerAOfferId = res.body.data.id;
    expect(res.body.data.eligibility).toBe('SELLER_NOT_APPROVED');
    expect(await winnerOf(phoneId)).toBe(sellerBOfferId);

    const approve = await request(app).patch(`${api}/sellers/${sellerAId}/kyc`).set(auth(adminToken)).send({ status: 'APPROVED' });
    expect(approve.status).toBe(200);
    expect(await winnerOf(phoneId)).toBe(sellerAOfferId);
  });

  it('rejects a duplicate offer at the same branch and edits by another seller', async () => {
    const dup = await request(app).post(`${api}/offers`).set(auth(sellerAToken)).send({
      productId: phoneId, priceUsd: 98, stockQty: 1, fulfilmentType: 'SELLER_FULFILLED', storeBranchId: branchA,
    });
    expect(dup.status).toBe(409);
    const steal = await request(app).patch(`${api}/offers/${sellerAOfferId}`).set(auth(sellerBToken)).send({ priceUsd: 1 });
    expect(steal.status).toBe(403);
  });

  it('hub offers are refused while hubs are off, and drop out of the Buy Box when hubs are switched off', async () => {
    const hubOffer = { productId: phoneId, priceUsd: 50, stockQty: 50, fulfilmentType: 'PLATFORM_FULFILLED', hubId: hubA };
    expect((await request(app).post(`${api}/offers`).set(auth(sellerBToken)).send(hubOffer)).status).toBe(400);

    expect((await request(app).patch(`${api}/market/settings`).set(auth(adminToken)).send({ hubsEnabled: true })).status).toBe(200);
    const created = await request(app).post(`${api}/offers`).set(auth(sellerBToken)).send(hubOffer);
    expect(created.status).toBe(201);
    // Sellers can't set hub stock themselves; the hub receives it
    expect(created.body.data.stockQty).toBe(0);
    expect((await request(app).patch(`${api}/offers/${created.body.data.id}`).set(auth(sellerBToken)).send({ stockQty: 50 })).status).toBe(400);
    await request(app).patch(`${api}/offers/${created.body.data.id}`).set(auth(adminToken)).send({ stockQty: 20 });
    expect(await winnerOf(phoneId)).toBe(created.body.data.id);

    await request(app).patch(`${api}/market/settings`).set(auth(adminToken)).send({ hubsEnabled: false });
    expect(await winnerOf(phoneId)).toBe(sellerAOfferId);
    const mine = await request(app).get(`${api}/offers/mine`).set(auth(sellerBToken));
    expect(mine.body.data.find((o: { id: string }) => o.id === created.body.data.id).eligibility).toBe('HUBS_DISABLED');
  });

  it('ranks for the buyer\'s location: distant stores are out of range, delivery is priced in', async () => {
    const res = await request(app).post(`${api}/offers`).set(auth(sellerBToken)).send({
      productId: phoneId, priceUsd: 105, stockQty: 8, fulfilmentType: 'SELLER_FULFILLED', storeBranchId: branchBNearA,
    });
    sellerBNearOfferId = res.body.data.id;

    // City A buyer: seller B's city-B shop is out of range; the cheaper local shop wins
    const inA = (await request(app).get(`${api}/catalog/products/${phoneId}?city=${cityA.slug}`)).body.data;
    expect(inA.buyBox.id).toBe(sellerAOfferId);
    expect(inA.otherOffers.map((o: { id: string }) => o.id)).toEqual([sellerBNearOfferId]);
    expect(inA.outOfRangeOfferCount).toBe(1);
    expect(inA.buyBox.distanceKm).toBeLessThan(1);
    expect(inA.buyBox.deliveryFee.usd).toBeGreaterThan(0);
    expect(inA.buyBox.landedPrice.usd).toBeCloseTo(99 + inA.buyBox.deliveryFee.usd, 2);
    expect(inA.buyBox.price.zwg).toBeCloseTo(99 * 30, 2);
    expect(inA.buyerLocation).toMatchObject({ city: { id: cityA.id }, precision: 'CITY' });

    // City B buyer: only the city-B shop can deliver
    const inB = (await request(app).get(`${api}/catalog/products/${phoneId}?city=${cityB.slug}`)).body.data;
    expect(inB.buyBox.id).toBe(sellerBOfferId);
    expect(inB.otherOffers).toHaveLength(0);
    expect(inB.outOfRangeOfferCount).toBe(2);

    // Price still decides within range: next to seller B's shop, the cheaper (further) store keeps the Buy Box
    const pinned = (await request(app).get(`${api}/catalog/products/${phoneId}?city=${cityA.slug}&lat=-17.7801&lng=31.0601`)).body.data;
    expect(pinned.buyerLocation.precision).toBe('GPS');
    expect(pinned.buyBox.distanceKm).toBeGreaterThan(pinned.otherOffers[0].distanceKm);
  });

  it('an open store beats a cheaper store that is closed right now', async () => {
    await request(app).patch(`${api}/merchant/branches/${branchA}`).set(auth(sellerAToken)).send({ operatingHours: {} });
    const inA = (await request(app).get(`${api}/catalog/products/${phoneId}?city=${cityA.slug}`)).body.data;
    expect(inA.buyBox.id).toBe(sellerBNearOfferId);
    expect(inA.buyBox.isOpenNow).toBe(true);
    expect(inA.otherOffers[0]).toMatchObject({ id: sellerAOfferId, isOpenNow: false, availability: 'Closed · Testa ' + stamp });
    await request(app).patch(`${api}/merchant/branches/${branchA}`).set(auth(sellerAToken)).send({ operatingHours: ALL_DAY });
  });

  it('pausing a branch takes its offers out of the Buy Box until it resumes', async () => {
    await request(app).patch(`${api}/merchant/branches/${branchA}`).set(auth(sellerAToken)).send({ isPaused: true });
    expect(await winnerOf(phoneId)).toBe(sellerBNearOfferId);
    await request(app).patch(`${api}/merchant/branches/${branchA}`).set(auth(sellerAToken)).send({ isPaused: false });
    expect(await winnerOf(phoneId)).toBe(sellerAOfferId);
  });

  it('deactivating the winner hands the Buy Box to the next offer', async () => {
    const winner = await winnerOf(phoneId);
    await request(app).delete(`${api}/offers/${winner}`).set(auth(sellerAToken));
    const next = await winnerOf(phoneId);
    expect(next).not.toBe(winner);
    expect(next).not.toBeNull();
    await request(app).patch(`${api}/offers/${sellerAOfferId}`).set(auth(sellerAToken)).send({ isActive: true });
  });

  it('archiving a product clears its Buy Box and hides it', async () => {
    await request(app).post(`${api}/offers`).set(auth(sellerAToken)).send({
      productId: blenderId, priceUsd: 45, stockQty: 3, fulfilmentType: 'SELLER_FULFILLED', storeBranchId: branchA,
    });
    expect(await winnerOf(blenderId)).not.toBeNull();
    const res = await request(app).delete(`${api}/catalog/products/${blenderId}`).set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(await winnerOf(blenderId)).toBeNull();
    expect((await request(app).get(`${api}/catalog/products/${blenderId}`)).status).toBe(404);
  });

  it('lists the seller\'s own offers with Buy Box status', async () => {
    const res = await request(app).get(`${api}/offers/mine`).set(auth(sellerAToken));
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    expect(res.body.data[0]).toHaveProperty('isBuyBoxWinner');
    expect(res.body.data[0].branch).toMatchObject({ id: branchA });
  });
});

describe('Product search', () => {
  it('finds products by a prefix of a title word', async () => {
    const res = await request(app).get(`${api}/catalog/products`).query({ q: token.slice(0, -3), limit: 10 });
    expect(res.status).toBe(200);
    expect(res.body.data.map((p: { id: string }) => p.id)).toContain(phoneId);
    // Archived products never appear
    expect(res.body.data.map((p: { id: string }) => p.id)).not.toContain(blenderId);
  });

  it('matches specification values', async () => {
    const res = await request(app).get(`${api}/catalog/products`).query({ q: `${token} midnight` });
    expect(res.body.data.map((p: { id: string }) => p.id)).toEqual([phoneId]);
  });

  it('filters to products a store can deliver to the buyer, with facets', async () => {
    const inA = await request(app).get(`${api}/catalog/products`).query({ q: token, city: cityA.slug });
    expect(inA.body.data.map((p: { id: string }) => p.id)).toEqual([phoneId]);
    expect(inA.body.data[0].buyBox).toMatchObject({ offerId: expect.any(String), isOpenNow: true });
    expect(inA.body.data[0].buyBox.distanceKm).toBeLessThan(5);
    expect(inA.body.buyerLocation.city.id).toBe(cityA.id);
    expect(inA.body.facets.brands).toEqual([expect.objectContaining({ id: brandId, count: 1 })]);
    expect(inA.body.facets.cities.map((c: { id: string }) => c.id)).toEqual(expect.arrayContaining([cityA.id, cityB.id]));
    // No hub stock while hubs are off, so no fulfilment facet
    expect(inA.body.facets.fulfilment).toEqual([]);

    // A GPS pin far from every store finds nothing deliverable
    const nowhere = await request(app).get(`${api}/catalog/products`).query({ q: token, lat: -22.2, lng: 30.0 });
    expect(nowhere.body.meta.total).toBe(0);
  });

  it('filters by price typed in ZiG', async () => {
    const price = (await request(app).get(`${api}/catalog/products/${phoneId}`)).body.data.buyBox.price;
    const under = await request(app).get(`${api}/catalog/products`).query({ q: token, maxPrice: price.zwg, currency: 'ZWG' });
    expect(under.body.meta.total).toBe(1);
    const over = await request(app).get(`${api}/catalog/products`).query({ q: token, maxPrice: price.zwg - 1, currency: 'ZWG' });
    expect(over.body.meta.total).toBe(0);
  });

  it('validates query parameters', async () => {
    expect((await request(app).get(`${api}/catalog/products`).query({ minPrice: 10, maxPrice: 5 })).status).toBe(422);
    expect((await request(app).get(`${api}/catalog/products`).query({ city: 'atlantis' })).status).toBe(400);
    expect((await request(app).get(`${api}/catalog/products`).query({ lat: -17.8 })).status).toBe(422);
  });
});

describe('Seller product requests', () => {
  let requestId: string;
  const body = () => ({
    title: `${token} Solar Lantern 20W`,
    brandName: 'Sunbright',
    categoryId,
    barcode: '6001234567890',
    images: [{ url: 'https://example.com/lantern.png' }],
    specifications: { Power: '20 W' },
    note: 'Popular in rural areas',
  });

  it('lets a seller request a product and see it in their list', async () => {
    expect((await request(app).post(`${api}/merchant/product-requests`).set(auth(sellerBToken)).send({ ...body(), images: [] })).status).toBe(422);
    // Only sellers can request
    expect((await request(app).post(`${api}/merchant/product-requests`).set(auth(buyerToken)).send(body())).status).toBe(403);

    const res = await request(app).post(`${api}/merchant/product-requests`).set(auth(sellerBToken)).send(body());
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'PENDING', brandName: 'Sunbright', category: { id: categoryId } });
    requestId = res.body.data.id;

    const mine = await request(app).get(`${api}/merchant/product-requests`).set(auth(sellerBToken));
    expect(mine.body.data.map((r: { id: string }) => r.id)).toContain(requestId);
    const other = await request(app).get(`${api}/merchant/product-requests`).set(auth(sellerAToken));
    expect(other.body.data.map((r: { id: string }) => r.id)).not.toContain(requestId);
  });

  it('shows admins the queue with possible duplicates', async () => {
    const dupe = await request(app).post(`${api}/merchant/product-requests`).set(auth(sellerAToken))
      .send({ ...body(), title: `${token} Smartphone 128GB`, barcode: undefined });
    const queue = await request(app).get(`${api}/catalog/admin/requests`).query({ status: 'PENDING' }).set(auth(adminToken));
    expect(queue.status).toBe(200);
    expect(queue.body.data.map((r: { id: string }) => r.id)).toEqual(expect.arrayContaining([requestId, dupe.body.data.id]));
    expect(queue.body.counts.PENDING).toBeGreaterThanOrEqual(2);

    const detail = await request(app).get(`${api}/catalog/admin/requests/${dupe.body.data.id}`).set(auth(adminToken));
    expect(detail.body.data.seller.id).toBe(sellerAId);
    expect(detail.body.data.possibleMatches[0].id).toBe(phoneId);

    // Admin links it to the existing phone
    const linked = await request(app).post(`${api}/catalog/admin/requests/${dupe.body.data.id}/link`).set(auth(adminToken)).send({ productId: phoneId });
    expect(linked.body.data).toMatchObject({ status: 'DUPLICATE', product: { id: phoneId } });
    expect((await request(app).get(`${api}/catalog/admin/requests`).set(auth(sellerAToken))).status).toBe(403);
  });

  it('creates the product on approval, once, and lets the seller list an offer on it', async () => {
    const approve = (sku: string) =>
      request(app).post(`${api}/catalog/admin/requests/${requestId}/approve`).set(auth(adminToken)).send({
        sku, title: `${token} Sunbright Solar Lantern 20W`, categoryId, specifications: { Power: '20 W', Barcode: '6001234567890' },
        images: [{ url: 'https://example.com/lantern.png' }], status: 'ACTIVE', reviewNote: 'Title tidied',
      });
    // A taken SKU fails and leaves the request pending
    expect((await approve(`T${stamp}-PHONE`)).status).toBe(409);
    expect((await prisma.productRequest.findUniqueOrThrow({ where: { id: requestId } })).status).toBe('PENDING');

    const res = await approve(`T${stamp}-LANTERN`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'APPROVED', reviewNote: 'Title tidied', product: { sku: `T${stamp}-LANTERN`, status: 'ACTIVE' } });
    expect((await approve(`T${stamp}-LANTERN2`)).status).toBe(409);

    const offer = await request(app).post(`${api}/offers`).set(auth(sellerBToken)).send({
      productId: res.body.data.product.id, priceUsd: 24, fulfilmentType: 'SELLER_FULFILLED', stockQty: 5, storeBranchId: branchB,
    });
    expect(offer.status).toBe(201);

    // A later request with the same barcode is flagged as a likely duplicate
    const again = await request(app).post(`${api}/merchant/product-requests`).set(auth(sellerAToken)).send({ ...body(), title: 'Lamp thing' });
    const detail = await request(app).get(`${api}/catalog/admin/requests/${again.body.data.id}`).set(auth(adminToken));
    expect(detail.body.data.possibleMatches[0]).toMatchObject({ id: res.body.data.product.id, barcodeMatch: true });
  });

  it('rejects with a reason, and only pending requests can be cancelled', async () => {
    const r = await request(app).post(`${api}/merchant/product-requests`).set(auth(sellerAToken)).send({ ...body(), title: `${token} Mystery box` });
    expect((await request(app).post(`${api}/catalog/admin/requests/${r.body.data.id}/reject`).set(auth(adminToken)).send({})).status).toBe(422);
    const rejected = await request(app).post(`${api}/catalog/admin/requests/${r.body.data.id}/reject`).set(auth(adminToken)).send({ reviewNote: 'Too vague: add the exact model' });
    expect(rejected.body.data.status).toBe('REJECTED');
    expect((await request(app).post(`${api}/merchant/product-requests/${r.body.data.id}/cancel`).set(auth(sellerAToken))).status).toBe(409);

    const c = await request(app).post(`${api}/merchant/product-requests`).set(auth(sellerAToken)).send({ ...body(), title: `${token} Torch` });
    expect((await request(app).post(`${api}/merchant/product-requests/${c.body.data.id}/cancel`).set(auth(sellerBToken))).status).toBe(404);
    const cancelled = await request(app).post(`${api}/merchant/product-requests/${c.body.data.id}/cancel`).set(auth(sellerAToken));
    expect(cancelled.body.data.status).toBe('CANCELLED');
  });
});
