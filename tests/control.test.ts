import request from 'supertest';
import { Prisma } from '@prisma/client';
import { createApp } from '../src/app';
import prisma from '../src/lib/prisma';
import { consoleOutbox } from '../src/lib/sms';
import { generateAccessToken } from '../src/middleware/auth.middleware';
import { getMarketSettings, updateMarketSettings, settingsDto } from '../src/modules/market/market.settings';
import { buyBoxService, invalidateFeeBands } from '../src/modules/catalog/buybox.service';
import { quoteRun, ZoneTable } from '../src/modules/delivery/fees';
import { sellerBalances } from '../src/modules/merchant/earnings.service';
import { pinFeeBands, TEST_BANDS } from './helpers/fee-bands';

/**
 * Admin control tower: towns, suburbs and zone pricing, pickup-point capacity, store KYC review,
 * driver parcel caps, live dispatch overrides, disputes, payout holds and catalog merges.
 */

const app = createApp();
const api = '/api/v1';
const stamp = Date.now();
const buyerPhone = `+26371${String(stamp).slice(-7)}`;
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const ALL_DAY = Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((d) => [d, [['00:00', '24:00']]]));
const lastSmsTo = (to: string) => [...consoleOutbox].reverse().find((m) => m.to === to)?.body ?? '';
const D = (n: number) => new Prisma.Decimal(n);

let restoreBands: () => Promise<void>;
let originalSettings: ReturnType<typeof settingsDto>;
let adminToken: string;
let buyerToken: string;
let cityId: string;
let innerSuburbId: string;
let outerSuburbId: string;
let innerZoneId: string;
let outerZoneId: string;
let addressId: string;
let categoryId: string;
let productId: string;
const stores: { sellerId: string; branchId: string; offerId: string; token: string }[] = [];

const sellerNet = async (orderId: string, sellerId: string) =>
  (await prisma.ledgerEntry.findMany({ where: { orderId, sellerId } })).reduce((s, e) => s.plus(e.sellerNetUsd), D(0)).toNumber();

async function placeOrder(opts: { quantity?: number; offerId?: string; fulfilment?: object } = {}) {
  const body = {
    items: [{ offerId: opts.offerId ?? stores[0].offerId, quantity: opts.quantity ?? 1 }],
    fulfilment: opts.fulfilment ?? { mode: 'DELIVERY', addressId },
    paymentCurrency: 'USD', paymentMethod: 'CARD',
  };
  const q = await request(app).post(`${api}/market/checkout/quote`).set(auth(buyerToken)).send(body);
  expect(q.status).toBe(200);
  const res = await request(app).post(`${api}/market/orders`).set(auth(buyerToken)).send({ ...body, expectedTotalUsd: q.body.data.totals.total.usd });
  expect(res.status).toBe(201);
  const order = res.body.data.order;
  return { orderId: order.id as string, shipmentId: order.shipments[0].id as string, quote: q.body.data };
}

async function makeStore(i: number, lat: number, lng: number, suburbId: string | null) {
  const owner = await prisma.user.create({ data: { email: `ct_store${i}_${stamp}@kuwana.test`, passwordHash: 'x', role: 'SELLER', phone: `+26373${String(stamp).slice(-6)}${i}` } });
  const seller = await prisma.sellerProfile.create({ data: { userId: owner.id, businessName: `CT Store ${i} ${stamp}`, slug: `ct-store-${i}-${stamp}`, kycStatus: 'APPROVED', nationalId: '63-111111-A-63' } });
  const branch = await prisma.storeBranch.create({ data: { sellerId: seller.id, code: `CT${i}-${stamp}`, name: `Branch ${i}`, cityId, suburbId, address: 'x', lat, lng, operatingHours: ALL_DAY } });
  const offer = await prisma.offer.create({ data: { productId, sellerId: seller.id, storeBranchId: branch.id, priceUsd: 20, stockQty: 50, fulfilmentType: 'SELLER_FULFILLED' } });
  stores.push({ sellerId: seller.id, branchId: branch.id, offerId: offer.id, token: generateAccessToken({ sub: owner.id, role: 'SELLER', email: owner.email }) });
}

beforeAll(async () => {
  restoreBands = await pinFeeBands();
  originalSettings = settingsDto(await getMarketSettings());
  await updateMarketSettings({
    hubsEnabled: false, codDepositRequired: false, freeDeliveryThresholdUsd: 5000, maxDeliveryRadiusKm: 40,
    storeAcceptSlaMinutes: 15, escrowHoldHours: 48, collateralBufferPct: 0, returnWindowDays: 7,
  });
  const admin = await prisma.user.create({ data: { email: `ct_admin_${stamp}@kuwana.test`, passwordHash: 'x', role: 'ADMIN' } });
  adminToken = generateAccessToken({ sub: admin.id, role: 'ADMIN', email: admin.email });
  const buyer = await prisma.user.create({ data: { email: `ct_buyer_${stamp}@kuwana.test`, passwordHash: 'x', phone: buyerPhone, phoneVerified: true, profile: { create: { fullName: 'Tendai Buyer' } } } });
  buyerToken = generateAccessToken({ sub: buyer.id, role: 'USER', email: buyer.email });
  categoryId = (await prisma.category.create({ data: { name: 'CT Cat', slug: `ct-cat-${stamp}`, commissionRate: 10 } })).id;
  productId = (await prisma.product.create({ data: { sku: `CT${stamp}-A`, slug: `ct${stamp}-a`, title: `Ctower Blender Pro ${stamp}`, categoryId } })).id;
});

afterAll(async () => {
  await updateMarketSettings(originalSettings);
  await restoreBands();
  const users = await prisma.user.findMany({ where: { email: { endsWith: `${stamp}@kuwana.test` } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  const orderIds = (await prisma.marketOrder.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((o) => o.id);
  const sellerIds = stores.map((s) => s.sellerId);
  const driver = await prisma.driverProfile.findFirst({ where: { userId: { in: ids } }, select: { id: true } });
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('kuwana.ledger_maintenance', 'on', true)`;
    await tx.ledgerEntry.deleteMany({ where: { OR: [{ orderId: { in: orderIds } }, { userId: { in: ids } }, { sellerId: { in: sellerIds } }] } });
    if (driver) await tx.driverWalletEntry.deleteMany({ where: { driverId: driver.id } });
  });
  await prisma.returnRequest.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.payment.deleteMany({ where: { checkoutRef: { in: orderIds } } });
  await prisma.payout.deleteMany({ where: { sellerId: { in: sellerIds } } });
  await prisma.marketOrder.deleteMany({ where: { id: { in: orderIds } } });
  if (driver) await prisma.driverProfile.delete({ where: { id: driver.id } });
  await prisma.product.deleteMany({ where: { sku: { startsWith: `CT${stamp}-` } } });
  await prisma.sellerProfile.deleteMany({ where: { id: { in: sellerIds } } });
  await prisma.address.deleteMany({ where: { userId: { in: ids } } });
  await prisma.wallet.deleteMany({ where: { userId: { in: ids } } });
  await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
  await prisma.pickupPoint.deleteMany({ where: { code: { startsWith: `PP-CT${String(stamp).slice(-6)}` } } });
  await prisma.city.deleteMany({ where: { slug: { startsWith: `ct-town-${stamp}` } } });
  await prisma.category.deleteMany({ where: { slug: `ct-cat-${stamp}` } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  invalidateFeeBands();
  await prisma.$disconnect();
});

describe('Zone pricing (pure)', () => {
  const table: ZoneTable = {
    suburbZone: new Map([['s-in', 'z1'], ['s-out', 'z2']]),
    rules: [{ originZoneId: 'z1', destinationZoneId: 'z2', vehicleClass: 'BIKE', customerFeeUsd: 3, driverPayoutUsd: 2, customerPerKmUsd: 0.2, driverPerKmUsd: 0.5 }],
  };
  it('uses the zone rule (both ways) with per-km, capping the driver at the customer fee', () => {
    const q = quoteRun(TEST_BANDS, 'BIKE', 5, 40, { table, ends: { originSuburbId: 's-out', destinationSuburbId: 's-in' } })!;
    expect([q.source, q.customerFeeUsd.toNumber(), q.driverFeeUsd.toNumber()]).toEqual(['ZONE', 4, 4]);
  });
  it('falls back to distance bands for an unzoned end, a missing vehicle rule, and respects the radius cap', () => {
    expect(quoteRun(TEST_BANDS, 'BIKE', 5, 40, { table, ends: { originSuburbId: 's-in', destinationSuburbId: 'nowhere' } })).toMatchObject({ source: 'BAND', bandMaxKm: 7 });
    expect(quoteRun(TEST_BANDS, 'CAR', 5, 40, { table, ends: { originSuburbId: 's-in', destinationSuburbId: 's-out' } })).toMatchObject({ source: 'BAND' });
    expect(quoteRun(TEST_BANDS, 'BIKE', 50, 40, { table, ends: { originSuburbId: 's-in', destinationSuburbId: 's-out' } })).toBeNull();
  });
});

describe('Towns, suburbs and zones', () => {
  it('admins add a town with zones and suburbs, and assign suburbs to zones', async () => {
    const city = await request(app).post(`${api}/control/cities`).set(auth(adminToken))
      .send({ name: `CT Town ${stamp}`, province: 'Harare', zone: 'METRO', codEligible: true, lat: -17.8, lng: 31.05 });
    expect(city.status).toBe(201);
    cityId = city.body.data.id;
    expect(city.body.data.slug).toBe(`ct-town-${stamp}`);

    for (const z of [{ code: 'zone_1_inner', name: 'Zone 1 Inner' }, { code: 'ZONE_2_OUTER', name: 'Zone 2 Outer', sortOrder: 1 }]) {
      expect((await request(app).post(`${api}/control/cities/${cityId}/zones`).set(auth(adminToken)).send(z)).status).toBe(201);
    }
    const dup = await request(app).post(`${api}/control/cities/${cityId}/zones`).set(auth(adminToken)).send({ code: 'ZONE_1_INNER', name: 'Again' });
    expect(dup.status).toBe(409);

    await request(app).post(`${api}/control/cities/${cityId}/suburbs`).set(auth(adminToken)).send({ name: 'Inner Park', lat: -17.8, lng: 31.05 });
    const res = await request(app).post(`${api}/control/cities/${cityId}/suburbs`).set(auth(adminToken)).send({ name: 'Outer Heights', lat: -17.85, lng: 31.05 });
    const t = res.body.data;
    [innerZoneId, outerZoneId] = t.zones.map((z: { id: string }) => z.id);
    expect(t.zones.map((z: { code: string }) => z.code)).toEqual(['ZONE_1_INNER', 'ZONE_2_OUTER']);
    innerSuburbId = t.suburbs.find((s: { name: string }) => s.name === 'Inner Park').id;
    outerSuburbId = t.suburbs.find((s: { name: string }) => s.name === 'Outer Heights').id;
    expect(t.unzonedSuburbs).toBe(2);

    await request(app).post(`${api}/control/cities/${cityId}/assign-zone`).set(auth(adminToken)).send({ zoneId: innerZoneId, suburbIds: [innerSuburbId] });
    const assigned = await request(app).patch(`${api}/control/suburbs/${outerSuburbId}`).set(auth(adminToken)).send({ zoneId: outerZoneId });
    expect(assigned.body.data.unzonedSuburbs).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'LOCATION_UPDATED' } })).toBeGreaterThan(0);
  });

  it('rejects a matrix where the driver earns more than the customer pays', async () => {
    const bad = await request(app).put(`${api}/control/cities/${cityId}/zone-pricing`).set(auth(adminToken))
      .send({ rules: [{ originZoneId: innerZoneId, destinationZoneId: outerZoneId, vehicleClass: 'BIKE', customerFeeUsd: 2, driverPayoutUsd: 3 }] });
    expect(bad.status).toBe(400);
    const ok = await request(app).put(`${api}/control/cities/${cityId}/zone-pricing`).set(auth(adminToken)).send({
      rules: [
        { originZoneId: innerZoneId, destinationZoneId: outerZoneId, vehicleClass: 'BIKE', customerFeeUsd: 4, driverPayoutUsd: 3 },
        { originZoneId: innerZoneId, destinationZoneId: innerZoneId, vehicleClass: 'BIKE', customerFeeUsd: 1.5, driverPayoutUsd: 1 },
      ],
    });
    expect(ok.status).toBe(200);
    expect(ok.body.data.rules).toHaveLength(2);
    expect(ok.body.data.rules.find((r: { destinationZoneId: string }) => r.destinationZoneId === outerZoneId).marginUsd).toBe(1);
  });

  it('checkout prices a zoned store run from the matrix, and the Buy Box uses the same fee', async () => {
    await makeStore(1, -17.8, 31.05, innerSuburbId); // in Inner Park
    await makeStore(2, -17.81, 31.06, null); // unzoned branch, used later for reassignment
    await buyBoxService.recomputeProduct(productId);
    const buyer = await prisma.user.findFirstOrThrow({ where: { email: `ct_buyer_${stamp}@kuwana.test` } });
    addressId = (await prisma.address.create({ data: { userId: buyer.id, label: 'Home', line1: '1 Outer Rd', city: `CT Town ${stamp}`, cityId, suburb: 'Outer Heights' } })).id;

    const body = { items: [{ offerId: stores[0].offerId, quantity: 1 }], fulfilment: { mode: 'DELIVERY', addressId }, paymentCurrency: 'USD', paymentMethod: 'CARD' };
    const q = (await request(app).post(`${api}/market/checkout/quote`).set(auth(buyerToken)).send(body)).body.data;
    // Inner → Outer zone rule ($4), not the ~5.6 km band ($3.50)
    expect(q.shipments[0].fee.usd).toBe(4);

    const detail = await request(app).get(`${api}/catalog/products/ct${stamp}-a`).query({ city: cityId, suburb: outerSuburbId });
    const d = detail.body.data;
    const offer = [d.buyBox, ...d.otherOffers].find((o: { id: string }) => o.id === stores[0].offerId);
    expect(offer.deliveryFee.usd).toBe(4);

    // Unzoning the destination falls back to the band
    await request(app).patch(`${api}/control/suburbs/${outerSuburbId}`).set(auth(adminToken)).send({ zoneId: null });
    const q2 = (await request(app).post(`${api}/market/checkout/quote`).set(auth(buyerToken)).send(body)).body.data;
    expect(q2.shipments[0].fee.usd).toBe(3.5);
    await request(app).patch(`${api}/control/suburbs/${outerSuburbId}`).set(auth(adminToken)).send({ zoneId: outerZoneId });
  });

  it('hides inactive towns and suburbs from buyers', async () => {
    await request(app).patch(`${api}/control/suburbs/${outerSuburbId}`).set(auth(adminToken)).send({ isActive: false });
    let towns = (await request(app).get(`${api}/logistics/cities`)).body.data;
    expect(towns.find((c: { id: string }) => c.id === cityId).suburbs.map((s: { name: string }) => s.name)).toEqual(['Inner Park']);
    await request(app).patch(`${api}/control/suburbs/${outerSuburbId}`).set(auth(adminToken)).send({ isActive: true });

    const other = await request(app).post(`${api}/control/cities`).set(auth(adminToken)).send({ name: `CT Town ${stamp} B`, province: 'Xy', isActive: false });
    towns = (await request(app).get(`${api}/logistics/cities`)).body.data;
    expect(towns.some((c: { id: string }) => c.id === other.body.data.id)).toBe(false);
  });
});

describe('Pickup points', () => {
  it('admins add a point with an agent fee and a daily cap; a full point is refused at checkout', async () => {
    const created = await request(app).post(`${api}/control/pickup-points`).set(auth(adminToken)).send({
      code: `PP-CT${String(stamp).slice(-6)}`, name: 'CT Tuckshop', type: 'PARTNER_SHOP', cityId, suburbId: innerSuburbId,
      address: '5 Shop St', lat: -17.801, lng: 31.051, operatingHours: 'Mon–Sat 08:00–18:00', agentFeeUsd: 0.5, maxDailyParcels: 1,
    });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ suburb: { name: 'Inner Park' }, agentFeeUsd: 0.5, maxDailyParcels: 1, bookedToday: 0 });
    const pointId = created.body.data.id;

    // Inner → Inner rule, then the 40% pickup discount: $1.50 × 0.6
    const first = await placeOrder({ fulfilment: { mode: 'PICKUP', pickupPointId: pointId } });
    expect(first.quote.shipments[0].fee.usd).toBe(0.9);

    const list = (await request(app).get(`${api}/logistics/pickup-points`).query({ city: cityId })).body.data;
    expect(list.find((p: { id: string }) => p.id === pointId).isFull).toBe(true);
    const full = await request(app).post(`${api}/market/checkout/quote`).set(auth(buyerToken))
      .send({ items: [{ offerId: stores[0].offerId, quantity: 1 }], fulfilment: { mode: 'PICKUP', pickupPointId: pointId }, paymentCurrency: 'USD', paymentMethod: 'CARD' });
    expect(full.status).toBe(400);
    expect(full.body.message).toMatch(/full for today/);

    const raised = await request(app).patch(`${api}/control/pickup-points/${pointId}`).set(auth(adminToken)).send({ maxDailyParcels: 5 });
    expect(raised.body.data.bookedToday).toBe(1);
  });
});

describe('Store KYC', () => {
  it('shows the review checklist and lets an admin verify a branch pin (reset when the pin moves)', async () => {
    const res = await request(app).get(`${api}/control/stores/${stores[0].sellerId}/kyc`).set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.checklist.find((c: { key: string }) => c.key === 'PINS').ok).toBe(false);
    expect(res.body.data.branches[0].mapUrl).toContain('-17.8,31.05');
    const v = await request(app).post(`${api}/control/branches/${stores[0].branchId}/verify-location`).set(auth(adminToken)).send({ verified: true });
    expect(v.body.data.checklist.find((c: { key: string }) => c.key === 'PINS').ok).toBe(true);

    await request(app).patch(`${api}/merchant/branches/${stores[0].branchId}`).set(auth(stores[0].token)).send({ lat: -17.8001, lng: 31.05 });
    expect((await prisma.storeBranch.findUniqueOrThrow({ where: { id: stores[0].branchId } })).locationVerifiedAt).toBeNull();
    await request(app).patch(`${api}/merchant/branches/${stores[0].branchId}`).set(auth(stores[0].token)).send({ lat: -17.8, lng: 31.05 });
  });
});

describe('Live dispatch', () => {
  it('flags a store that missed its accept deadline and lets an admin move the parcel without an SLA penalty', async () => {
    const { orderId, shipmentId } = await placeOrder({ quantity: 1 });
    await prisma.shipment.update({ where: { id: shipmentId }, data: { acceptBy: new Date(Date.now() - 5 * 60_000) } });

    const board = (await request(app).get(`${api}/control/dispatch`).set(auth(adminToken))).body.data;
    const row = board.late.find((r: { shipmentId: string }) => r.shipmentId === shipmentId);
    expect(row).toMatchObject({ reason: 'STORE_NOT_ACCEPTED', actions: ['REASSIGN', 'CANCEL', 'CALL'] });
    expect(row.minutesLate).toBeGreaterThanOrEqual(4);

    const candidates = (await request(app).get(`${api}/control/dispatch/${shipmentId}/candidates`).set(auth(adminToken))).body.data;
    expect(candidates.find((c: { id: string }) => c.id === stores[1].branchId).canFill).toBe(true);

    const moved = await request(app).post(`${api}/control/dispatch/${shipmentId}/reassign`).set(auth(adminToken)).send({ branchId: stores[1].branchId, note: 'Store not answering' });
    expect(moved.status).toBe(200);
    const sh = await prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId } });
    expect([sh.storeBranchId, sh.reassignCount]).toEqual([stores[1].branchId, 1]);
    const events = await prisma.storeOrderEvent.findMany({ where: { shipmentId }, select: { type: true, branchId: true } });
    expect(events.map((e) => e.type).sort()).toEqual(['MOVED_BY_ADMIN', 'REASSIGNED_IN']);
    expect(await sellerNet(orderId, stores[0].sellerId)).toBe(0);
    expect(await sellerNet(orderId, stores[1].sellerId)).toBe(18);
    expect((await prisma.offer.findUniqueOrThrow({ where: { id: stores[0].offerId } })).stockQty).toBe(50 - 1); // only the pickup order holds stock
    expect(await prisma.auditLog.count({ where: { action: 'DISPATCH_OVERRIDE', targetId: shipmentId } })).toBe(1);
  });

  it('cancels a parcel still at the store and refunds the buyer’s wallet', async () => {
    const { shipmentId } = await placeOrder({ quantity: 1 });
    const res = await request(app).post(`${api}/control/dispatch/${shipmentId}/cancel`).set(auth(adminToken)).send({ reason: 'Buyer asked by phone' });
    expect(res.status).toBe(200);
    expect(res.body.data.refundUsd).toBeGreaterThan(20);
    expect((await prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId } })).status).toBe('CANCELLED');
    expect(lastSmsTo(buyerPhone)).toMatch(/cancelled: Buyer asked by phone/);
  });

  it('takes a claimed job off a no-show driver, and caps the parcel value a driver may carry', async () => {
    const { shipmentId } = await placeOrder({ quantity: 2 });
    await request(app).post(`${api}/store/orders/${shipmentId}/ready`).set(auth(stores[0].token));
    const job = await prisma.deliveryJob.findUniqueOrThrow({ where: { shipmentId } });
    expect(job.parcelValueUsd.toNumber()).toBe(40);

    const u = await prisma.user.create({ data: { email: `ct_driver_${stamp}@kuwana.test`, passwordHash: 'x', phone: `+26374${String(stamp).slice(-7)}`, phoneVerified: true } });
    const token = generateAccessToken({ sub: u.id, role: 'USER', email: u.email });
    const applied = await request(app).post(`${api}/drivers/apply`).set(auth(token)).send({ nationalId: '63-7654321-F-63', licenseNumber: 'DL123456', vehicleClass: 'BIKE', vehicleReg: 'AAA 1', cityId });
    const driverId = applied.body.data.id;
    const approved = await request(app).post(`${api}/drivers/admin/${driverId}/approve`).set(auth(adminToken)).send({ maxParcelValueUsd: 30 });
    expect(approved.body.data.maxParcelValueUsd).toBe(30);
    await request(app).post(`${api}/drivers/admin/${driverId}/wallet/adjust`).set(auth(adminToken)).send({ amountUsd: 100, memo: 'Cash at agent' });
    await request(app).post(`${api}/drivers/me/status`).set(auth(token)).send({ isOnline: true, lat: -17.801, lng: 31.051 });

    const feed = (await request(app).get(`${api}/drivers/jobs/available`).set(auth(token))).body.data;
    expect(feed.some((j: { id: string }) => j.id === job.id)).toBe(false);
    const refused = await request(app).post(`${api}/drivers/jobs/${job.id}/claim`).set(auth(token));
    expect(refused.status).toBe(400);
    expect(refused.body.message).toMatch(/up to \$30/);

    await request(app).post(`${api}/drivers/admin/${driverId}/parcel-cap`).set(auth(adminToken)).send({ maxParcelValueUsd: null });
    expect((await request(app).post(`${api}/drivers/jobs/${job.id}/claim`).set(auth(token))).status).toBe(200);
    await prisma.deliveryJob.update({ where: { id: job.id }, data: { claimedAt: new Date(Date.now() - 60 * 60_000) } });

    const board = (await request(app).get(`${api}/control/dispatch`).set(auth(adminToken))).body.data;
    expect(board.late.find((r: { shipmentId: string }) => r.shipmentId === shipmentId)).toMatchObject({ reason: 'PICKUP_LATE', driver: { id: driverId } });
    const released = await request(app).post(`${api}/control/dispatch/${shipmentId}/release-driver`).set(auth(adminToken)).send({ reason: 'Not at the store after an hour' });
    expect(released.status).toBe(200);
    expect((await prisma.deliveryJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('OPEN');
    expect((await prisma.driverWallet.findUniqueOrThrow({ where: { driverId } })).availableFloatUsd.toNumber()).toBe(100);
  });
});

describe('Disputes and payout holds', () => {
  async function deliveredOrder(quantity = 1) {
    const o = await placeOrder({ quantity });
    await prisma.shipment.update({ where: { id: o.shipmentId }, data: { status: 'DELIVERED', deliveredAt: new Date(Date.now() - 72 * 3600_000) } });
    return o;
  }
  async function openReturn(orderId: string, reason = 'DEFECTIVE') {
    const items = (await request(app).get(`${api}/returns/order/${orderId}`).set(auth(buyerToken))).body.data.items;
    return request(app).post(`${api}/returns`).set(auth(buyerToken)).send({
      orderId, items: [{ orderItemId: items[0].orderItemId, quantity: 1 }], reason, method: 'COURIER_COLLECTION', refundDestination: 'WALLET',
    });
  }
  const walletUsd = async () => {
    const u = await prisma.user.findFirstOrThrow({ where: { email: `ct_buyer_${stamp}@kuwana.test` }, select: { id: true } });
    return (await prisma.wallet.findUnique({ where: { userId: u.id } }))?.balanceUsd.toNumber() ?? 0;
  };

  it('a held order stays in escrow and a held store cannot request a payout', async () => {
    const { orderId } = await deliveredOrder();
    const before = await sellerBalances(stores[0].sellerId);
    await request(app).post(`${api}/control/orders/${orderId}/payout-hold`).set(auth(adminToken)).send({ reason: 'Buyer says box was empty' });
    const held = await sellerBalances(stores[0].sellerId);
    expect(held.availableUsd.toNumber()).toBe(before.availableUsd.minus(18).toNumber());
    expect(held.heldUsd.toNumber()).toBe(18);
    await request(app).post(`${api}/control/orders/${orderId}/payout-hold`).set(auth(adminToken)).send({ reason: null });
    expect((await sellerBalances(stores[0].sellerId)).availableUsd.toNumber()).toBe(before.availableUsd.toNumber());

    await prisma.sellerProfile.update({ where: { id: stores[0].sellerId }, data: { usdPayoutDetails: { bank: 'CBZ', accountNumber: '1' } } });
    await request(app).post(`${api}/control/stores/${stores[0].sellerId}/payout-hold`).set(auth(adminToken)).send({ reason: 'Fraud check' });
    const blocked = await request(app).post(`${api}/merchant/payouts`).set(auth(stores[0].token)).send({ currency: 'USD' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.message).toMatch(/Fraud check/);
    await request(app).post(`${api}/control/stores/${stores[0].sellerId}/payout-hold`).set(auth(adminToken)).send({ reason: null });
  });

  it('settles a dispute as Kuwana goodwill: the buyer is refunded and the store keeps its earnings', async () => {
    const { orderId } = await deliveredOrder();
    const ret = await openReturn(orderId);
    expect(ret.status).toBe(201);
    const list = (await request(app).get(`${api}/control/disputes`).set(auth(adminToken))).body.data;
    expect(list.find((r: { id: string }) => r.id === ret.body.data.id)).toMatchObject({ fullValueUsd: 20, stores: [{ id: stores[0].sellerId }] });

    const w0 = await walletUsd();
    const res = await request(app).post(`${api}/control/disputes/${ret.body.data.id}/resolve`).set(auth(adminToken))
      .send({ outcome: 'REFUND', payer: 'PLATFORM', amountUsd: 12, note: 'Courier damaged the box' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'REFUNDED', refundUsd: 12, refundPaidBy: 'PLATFORM' });
    expect(await walletUsd()).toBe(w0 + 12);
    expect(await sellerNet(orderId, stores[0].sellerId)).toBe(18);
  });

  it('settles a dispute against the store with a partial refund and restocks the item', async () => {
    const { orderId } = await deliveredOrder();
    const ret = await openReturn(orderId);
    const stock0 = (await prisma.offer.findUniqueOrThrow({ where: { id: stores[0].offerId } })).stockQty;
    const res = await request(app).post(`${api}/control/disputes/${ret.body.data.id}/resolve`).set(auth(adminToken))
      .send({ outcome: 'REFUND', payer: 'STORE', amountUsd: 10, restock: true, note: 'Half refund agreed' });
    expect(res.status).toBe(200);
    expect(await sellerNet(orderId, stores[0].sellerId)).toBe(9); // half of $18
    expect((await prisma.offer.findUniqueOrThrow({ where: { id: stores[0].offerId } })).stockQty).toBe(stock0 + 1);

    const again = await request(app).post(`${api}/control/disputes/${ret.body.data.id}/resolve`).set(auth(adminToken)).send({ outcome: 'REJECT', note: 'Double click' });
    expect(again.status).toBe(400);
  });

  it('only wrong or damaged deliveries can be returned from a non-returnable category', async () => {
    const cat = await request(app).patch(`${api}/catalog/categories/${categoryId}`).set(auth(adminToken)).send({ isReturnable: false });
    expect(cat.status).toBe(200);
    const { orderId } = await deliveredOrder();
    const refused = await openReturn(orderId, 'DEFECTIVE');
    expect(refused.status).toBe(400);
    expect(refused.body.message).toMatch(/wrong item or it arrived damaged/);
    expect((await openReturn(orderId, 'DAMAGED_IN_TRANSIT')).status).toBe(201);
    await prisma.category.update({ where: { id: categoryId }, data: { isReturnable: true } });
  });
});

describe('Catalog merge', () => {
  it('finds a likely duplicate, merges it, and old links show the master product', async () => {
    const dup = await prisma.product.create({ data: { sku: `CT${stamp}-B`, slug: `ct${stamp}-b`, title: `Ctower Blender Pro ${stamp} (new)`, categoryId } });
    const twin = await prisma.offer.create({ data: { productId: dup.id, sellerId: stores[1].sellerId, storeBranchId: stores[1].branchId, priceUsd: 19, stockQty: 4, fulfilmentType: 'SELLER_FULFILLED' } });
    await buyBoxService.recomputeProduct(dup.id);

    const similar = (await request(app).get(`${api}/control/products/${dup.id}/similar`).set(auth(adminToken))).body.data;
    expect(similar[0].id).toBe(productId);

    const stock1 = (await prisma.offer.findUniqueOrThrow({ where: { id: stores[1].offerId } })).stockQty;
    const res = await request(app).post(`${api}/catalog/admin/products/${dup.id}/merge`).set(auth(adminToken)).send({ intoProductId: productId });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ offersMoved: 0, offersCombined: 1 });
    expect((await prisma.offer.findUniqueOrThrow({ where: { id: stores[1].offerId } })).stockQty).toBe(stock1 + 4);
    expect((await prisma.offer.findUniqueOrThrow({ where: { id: twin.id } })).isActive).toBe(false);

    const old = await request(app).get(`${api}/catalog/products/ct${stamp}-b`);
    expect(old.status).toBe(200);
    expect(old.body.data.id).toBe(productId);
    expect((await request(app).post(`${api}/catalog/admin/products/${dup.id}/merge`).set(auth(adminToken)).send({ intoProductId: productId })).status).toBe(400);
  });
});
