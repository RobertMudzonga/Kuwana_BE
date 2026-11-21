import request from 'supertest';
import { createApp } from '../src/app';
import prisma from '../src/lib/prisma';
import { consoleOutbox } from '../src/lib/sms';
import { testQueue } from '../src/lib/jobs';
import { generateAccessToken } from '../src/middleware/auth.middleware';
import { getMarketSettings, updateMarketSettings, settingsDto } from '../src/modules/market/market.settings';
import { buyBoxService } from '../src/modules/catalog/buybox.service';
import { pickupPinFor } from '../src/modules/store/store-orders.service';
import { effectiveRadiusKm } from '../src/modules/drivers/driver-jobs.service';
import { pinFeeBands } from './helpers/fee-bands';

/**
 * Gig drivers: onboarding, float top-ups, the job feed, claiming with collateral, the store-PIN /
 * customer-OTP chain of custody, COD offset against the float, failed deliveries and withdrawals.
 */

const app = createApp();
const api = '/api/v1';
const stamp = Date.now();
const buyerPhone = `+26377${String(stamp).slice(-7)}`;
const driverPhone = `+26378${String(stamp).slice(-7)}`;
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const ALL_DAY = Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((d) => [d, [['00:00', '24:00']]]));
const lastSmsTo = (to: string) => [...consoleOutbox].reverse().find((m) => m.to === to)?.body ?? '';

let restoreBands: () => Promise<void>;
let originalSettings: ReturnType<typeof settingsDto>;
let cityId: string;
let adminToken: string;
let buyerId: string;
let buyerToken: string;
let addressId: string;
let pickupPointId: string;
let storeToken: string;
let offerId: string;
let driverUserId: string;
let driverToken: string;
let driverId: string;

const wallet = async () => (await request(app).get(`${api}/drivers/me/wallet`).set(auth(driverToken))).body.data;

async function readyOrder(opts: { paymentMethod?: 'CARD' | 'CASH'; quantity?: number; pickup?: boolean } = {}) {
  const body = {
    items: [{ offerId, quantity: opts.quantity ?? 2 }],
    fulfilment: opts.pickup ? { mode: 'PICKUP', pickupPointId } : { mode: 'DELIVERY', addressId },
    paymentCurrency: 'USD', paymentMethod: opts.paymentMethod ?? 'CARD',
  };
  const q = await request(app).post(`${api}/market/checkout/quote`).set(auth(buyerToken)).send(body);
  const res = await request(app).post(`${api}/market/orders`).set(auth(buyerToken)).send({ ...body, expectedTotalUsd: q.body.data.totals.total.usd });
  expect(res.status).toBe(201);
  let order = res.body.data.order;
  if (order.status === 'AWAITING_COD_OTP') {
    const code = lastSmsTo(buyerPhone).match(/is (\d{6})/)![1];
    order = (await request(app).post(`${api}/market/orders/${order.id}/cod/verify`).set(auth(buyerToken)).send({ code })).body.data;
  }
  const pin = lastSmsTo(buyerPhone).match(/collection PIN is (\d{6})/)![1];
  const shipmentId = order.shipments[0].id;
  const ready = await request(app).post(`${api}/store/orders/${shipmentId}/ready`).set(auth(storeToken));
  expect(ready.status).toBe(200);
  const job = await prisma.deliveryJob.findUniqueOrThrow({ where: { shipmentId } });
  return { orderId: order.id as string, shipmentId, jobId: job.id, customerPin: pin };
}

beforeAll(async () => {
  restoreBands = await pinFeeBands();
  originalSettings = settingsDto(await getMarketSettings());
  await updateMarketSettings({
    hubsEnabled: false, codDepositRequired: false, codEnabled: true, codMaxOrderUsd: 150, codMinTrustScore: 0, codFeeUsd: 0,
    freeDeliveryThresholdUsd: 500, jobBroadcastRadiusKm: 8, maxDeliveryRadiusKm: 40, collateralBufferPct: 0, driverMaxActiveJobs: 3,
  });
  const city = await prisma.city.create({ data: { name: `Dr City ${stamp}`, slug: `dr-city-${stamp}`, province: 'Test', zone: 'METRO', codEligible: true, lat: -17.8, lng: 31.04 } });
  cityId = city.id;
  pickupPointId = (await prisma.pickupPoint.create({ data: { code: `PPDR-${stamp}`, name: 'Dr Corner Shop', type: 'PARTNER_SHOP', cityId, address: 'x', lat: -17.805, lng: 31.045 } })).id;
  const category = await prisma.category.create({ data: { name: 'Dr Cat', slug: `dr-cat-${stamp}`, commissionRate: 10 } });
  const product = await prisma.product.create({ data: { sku: `D${stamp}-K`, slug: `d${stamp}-k`, title: 'Dr Kettle', categoryId: category.id } });

  const owner = await prisma.user.create({ data: { email: `dr_store_${stamp}@kuwana.test`, passwordHash: 'x', role: 'SELLER' } });
  storeToken = generateAccessToken({ sub: owner.id, role: 'SELLER', email: owner.email });
  const seller = await prisma.sellerProfile.create({ data: { userId: owner.id, businessName: `Dr Store ${stamp}`, slug: `dr-store-${stamp}`, kycStatus: 'APPROVED' } });
  const branch = await prisma.storeBranch.create({ data: { sellerId: seller.id, code: `DRS-${stamp}`, name: 'Main', cityId, address: 'x', lat: -17.8, lng: 31.04, operatingHours: ALL_DAY } });
  offerId = (await prisma.offer.create({ data: { productId: product.id, sellerId: seller.id, storeBranchId: branch.id, priceUsd: 10, stockQty: 50, fulfilmentType: 'SELLER_FULFILLED' } })).id;
  await buyBoxService.recomputeProduct(product.id);

  const admin = await prisma.user.create({ data: { email: `dr_admin_${stamp}@kuwana.test`, passwordHash: 'x', role: 'ADMIN' } });
  adminToken = generateAccessToken({ sub: admin.id, role: 'ADMIN', email: admin.email });
  const buyer = await prisma.user.create({ data: { email: `dr_buyer_${stamp}@kuwana.test`, passwordHash: 'x', phone: buyerPhone, phoneVerified: true, codTrustScore: 50, profile: { create: { fullName: 'Chipo Buyer' } } } });
  buyerId = buyer.id;
  buyerToken = generateAccessToken({ sub: buyer.id, role: 'USER', email: buyer.email });
  addressId = (await prisma.address.create({ data: { userId: buyer.id, label: 'Home', line1: '3 Dr Rd', city: city.name, cityId, landmark: 'White wall' } })).id;

  const driver = await prisma.user.create({ data: { email: `dr_driver_${stamp}@kuwana.test`, passwordHash: 'x', phone: driverPhone, profile: { create: { fullName: 'Farai Rider' } } } });
  driverUserId = driver.id;
  driverToken = generateAccessToken({ sub: driver.id, role: 'USER', email: driver.email });
});

afterAll(async () => {
  await updateMarketSettings(originalSettings);
  await restoreBands();
  const users = await prisma.user.findMany({ where: { email: { endsWith: `${stamp}@kuwana.test` } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  const orders = await prisma.marketOrder.findMany({ where: { userId: { in: ids } }, select: { id: true } });
  const orderIds = orders.map((o) => o.id);
  const sellers = await prisma.sellerProfile.findMany({ where: { userId: { in: ids } }, select: { id: true } });
  await prisma.codRemittance.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('kuwana.ledger_maintenance', 'on', true)`;
    await tx.ledgerEntry.deleteMany({ where: { OR: [{ orderId: { in: orderIds } }, { userId: { in: ids } }, { sellerId: { in: sellers.map((s) => s.id) } }] } });
    if (driverId) {
      await tx.driverWalletEntry.deleteMany({ where: { driverId } });
      await tx.driverWithdrawal.deleteMany({ where: { driverId } });
    }
  });
  await prisma.payment.deleteMany({ where: { OR: [{ checkoutRef: { in: orderIds } }, ...(driverId ? [{ checkoutRef: driverId }] : [])] } });
  await prisma.marketOrder.deleteMany({ where: { id: { in: orderIds } } });
  if (driverId) await prisma.driverProfile.deleteMany({ where: { id: driverId } });
  await prisma.product.deleteMany({ where: { sku: { startsWith: `D${stamp}-` } } });
  await prisma.sellerProfile.deleteMany({ where: { userId: { in: ids } } });
  await prisma.address.deleteMany({ where: { userId: { in: ids } } });
  await prisma.wallet.deleteMany({ where: { userId: { in: ids } } });
  await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
  await prisma.pickupPoint.deleteMany({ where: { code: `PPDR-${stamp}` } });
  await prisma.city.deleteMany({ where: { slug: `dr-city-${stamp}` } });
  await prisma.category.deleteMany({ where: { slug: `dr-cat-${stamp}` } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.$disconnect();
});

const application = () => ({ nationalId: '63-1234567-F-63', licenseNumber: 'DL123456', vehicleClass: 'BIKE', vehicleReg: 'AEZ 1234', cityId });

describe('Onboarding', () => {
  it('needs a verified phone, then waits for admin approval', async () => {
    const unverified = await request(app).post(`${api}/drivers/apply`).set(auth(driverToken)).send(application());
    expect(unverified.status).toBe(400);
    await prisma.user.update({ where: { id: driverUserId }, data: { phoneVerified: true } });
    const res = await request(app).post(`${api}/drivers/apply`).set(auth(driverToken)).send(application());
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ kycStatus: 'PENDING', vehicleClass: 'BIKE', wallet: { availableFloatUsd: 0 } });
    driverId = res.body.data.id;
    expect((await request(app).post(`${api}/drivers/me/status`).set(auth(driverToken)).send({ isOnline: true, lat: -17.81, lng: 31.045 })).status).toBe(403);
    expect((await request(app).post(`${api}/drivers/apply`).set(auth(driverToken)).send(application())).status).toBe(409);
  });

  it('admin approves; the account becomes a driver', async () => {
    const queue = await request(app).get(`${api}/drivers/admin`).query({ status: 'PENDING' }).set(auth(adminToken));
    expect(queue.body.data.map((d: { id: string }) => d.id)).toContain(driverId);
    expect((await request(app).get(`${api}/drivers/admin`).set(auth(driverToken))).status).toBe(403);
    const ok = await request(app).post(`${api}/drivers/admin/${driverId}/approve`).set(auth(adminToken)).send({});
    expect(ok.body.data.kycStatus).toBe('APPROVED');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: driverUserId } })).role).toBe('DRIVER');
    expect(lastSmsTo(driverPhone)).toContain('approved');
    driverToken = generateAccessToken({ sub: driverUserId, role: 'DRIVER', email: `dr_driver_${stamp}@kuwana.test` });
  });

  it('tops up the float by mobile money and goes online with a location', async () => {
    const dep = await request(app).post(`${api}/drivers/me/wallet/deposit`).set(auth(driverToken)).send({ amountUsd: 5, method: 'ECOCASH', phone: driverPhone });
    expect(dep.body.data.status).toBe('PAID'); // the dev gateway approves instantly
    expect((await wallet()).availableFloatUsd).toBe(5);
    expect((await request(app).post(`${api}/drivers/me/status`).set(auth(driverToken)).send({ isOnline: true })).status).toBe(400);
    const online = await request(app).post(`${api}/drivers/me/status`).set(auth(driverToken)).send({ isOnline: true, lat: -17.81, lng: 31.045 });
    expect(online.body.data).toMatchObject({ isOnline: true, location: { lat: -17.81 } });
  });
});

describe('Jobs: claim, pickup PIN, delivery OTP', () => {
  let job: Awaited<ReturnType<typeof readyOrder>>;

  it('a packed parcel is broadcast and shows in the feed; the float must cover it', async () => {
    job = await readyOrder();
    expect(testQueue.some((j) => j.name === 'delivery.broadcast' && (j.data as { jobId: string }).jobId === job.jobId)).toBe(true);
    const feed = await request(app).get(`${api}/drivers/jobs/available`).set(auth(driverToken));
    const offer = feed.body.data.find((j: { id: string }) => j.id === job.jobId);
    // $20 of goods needs $20 free float; the driver has $5
    expect(offer).toMatchObject({ earningsUsd: 1.8, collateralUsd: 20, canClaim: false, floatShortUsd: 15, dropoff: { type: 'ADDRESS' } });
    expect(offer.dropoff.recipientPhone).toBeUndefined(); // no customer details before claiming
    expect(offer.kmToStore).toBeLessThan(2);
    const claim = await request(app).post(`${api}/drivers/jobs/${job.jobId}/claim`).set(auth(driverToken));
    expect(claim.status).toBe(400);
    expect(claim.body.message).toContain('Top up your float');
  });

  it('cash left with an agent tops up the float; claiming locks the collateral', async () => {
    const adj = await request(app).post(`${api}/drivers/admin/${driverId}/wallet/adjust`).set(auth(adminToken)).send({ amountUsd: 50, reference: 'AGENT-778', memo: 'Cash at Avondale agent' });
    expect(adj.body.data.availableFloatUsd).toBe(55);
    const claim = await request(app).post(`${api}/drivers/jobs/${job.jobId}/claim`).set(auth(driverToken));
    expect(claim.status).toBe(200);
    expect(claim.body.data).toMatchObject({ status: 'CLAIMED', dropoff: { recipientPhone: buyerPhone, landmark: 'White wall' } });
    expect(await wallet()).toMatchObject({ availableFloatUsd: 35, lockedFloatUsd: 20 });
    // The store sees who is coming
    const store = await request(app).get(`${api}/store/orders/${job.shipmentId}`).set(auth(storeToken));
    expect(store.body.data.deliveryJob).toMatchObject({ status: 'CLAIMED', driver: { name: 'Farai Rider', vehicleReg: 'AEZ 1234' } });
  });

  it('collects with the store\'s 4-digit PIN only', async () => {
    expect((await request(app).post(`${api}/drivers/jobs/${job.jobId}/pickup`).set(auth(driverToken)).send({ pin: '0000' === pickupPinFor(job.jobId) ? '1111' : '0000' })).status).toBe(400);
    const ok = await request(app).post(`${api}/drivers/jobs/${job.jobId}/pickup`).set(auth(driverToken)).send({ pin: pickupPinFor(job.jobId) });
    expect(ok.body.data.status).toBe('IN_TRANSIT');
    expect((await prisma.shipment.findUniqueOrThrow({ where: { id: job.shipmentId } })).status).toBe('OUT_FOR_DELIVERY');
    expect(lastSmsTo(buyerPhone)).toContain('is on its way with Farai (AEZ 1234)');
  });

  it('hands over with the customer\'s 6-digit PIN: collateral back, fee earned, order complete', async () => {
    expect((await request(app).post(`${api}/drivers/jobs/${job.jobId}/deliver`).set(auth(driverToken)).send({ otp: '000000' })).status).toBe(400);
    const ok = await request(app).post(`${api}/drivers/jobs/${job.jobId}/deliver`).set(auth(driverToken)).send({ otp: job.customerPin });
    expect(ok.body.data.status).toBe('DELIVERED');
    expect(await wallet()).toMatchObject({ availableFloatUsd: 55, lockedFloatUsd: 0, withdrawableEarningsUsd: 1.8 });
    expect((await prisma.marketOrder.findUniqueOrThrow({ where: { id: job.orderId } })).status).toBe('COMPLETED');
    const types = (await prisma.driverWalletEntry.findMany({ where: { deliveryJobId: job.jobId }, orderBy: { createdAt: 'asc' } })).map((e) => e.type);
    expect(types).toEqual(['COLLATERAL_LOCK', 'COLLATERAL_RELEASE', 'DELIVERY_EARNING']);
  });

  it('a claimed job can be handed back before pickup', async () => {
    const j = await readyOrder({ quantity: 1 });
    await request(app).post(`${api}/drivers/jobs/${j.jobId}/claim`).set(auth(driverToken));
    expect((await wallet()).lockedFloatUsd).toBe(10);
    const rel = await request(app).post(`${api}/drivers/jobs/${j.jobId}/release`).set(auth(driverToken));
    expect(rel.body.data.status).toBe('OPEN');
    expect(await wallet()).toMatchObject({ availableFloatUsd: 55, lockedFloatUsd: 0 });
    await prisma.deliveryJob.update({ where: { id: j.jobId }, data: { status: 'CANCELLED' } });
  });
});

describe('Cash on delivery', () => {
  it('the driver keeps the cash and the same amount comes off their float', async () => {
    const j = await readyOrder({ paymentMethod: 'CASH', quantity: 1 });
    const job = await prisma.deliveryJob.findUniqueOrThrow({ where: { id: j.jobId } });
    // $10 goods + $2.50 delivery collected in cash: collateral covers the larger amount
    expect([job.codAmountUsd.toNumber(), job.collateralRequiredUsd.toNumber()]).toEqual([12.5, 12.5]);
    await request(app).post(`${api}/drivers/jobs/${j.jobId}/claim`).set(auth(driverToken));
    await request(app).post(`${api}/drivers/jobs/${j.jobId}/pickup`).set(auth(driverToken)).send({ pin: pickupPinFor(j.jobId) });
    const mine = await request(app).get(`${api}/drivers/jobs/mine`).set(auth(driverToken));
    expect(mine.body.data.active[0].cashOnDelivery).toEqual({ amountUsd: 12.5, collect: { amount: 12.5, currency: 'USD' } });
    expect((await request(app).post(`${api}/drivers/jobs/${j.jobId}/deliver`).set(auth(driverToken)).send({ otp: j.customerPin })).status).toBe(400);
    const ok = await request(app).post(`${api}/drivers/jobs/${j.jobId}/deliver`).set(auth(driverToken)).send({ otp: j.customerPin, cashCollected: 12.5 });
    expect(ok.status).toBe(200);
    // 55 − 12.50 cash kept; +1.80 earned
    expect(await wallet()).toMatchObject({ availableFloatUsd: 42.5, lockedFloatUsd: 0, withdrawableEarningsUsd: 3.6 });
    const remit = await prisma.codRemittance.findUniqueOrThrow({ where: { shipmentId: j.shipmentId } });
    expect([remit.status, remit.collectedAmount.toNumber()]).toEqual(['VERIFIED', 12.5]);
    expect(await prisma.ledgerEntry.count({ where: { orderId: j.orderId, type: 'COD_COLLECTED' } })).toBe(1);
    expect((await prisma.marketOrder.findUniqueOrThrow({ where: { id: j.orderId } })).paymentStatus).toBe('PAID');
  });
});

describe('Pickup points and failed deliveries', () => {
  it('dropping at a pickup point needs no customer PIN; the agent takes over', async () => {
    const j = await readyOrder({ quantity: 1, pickup: true });
    await request(app).post(`${api}/drivers/jobs/${j.jobId}/claim`).set(auth(driverToken));
    await request(app).post(`${api}/drivers/jobs/${j.jobId}/pickup`).set(auth(driverToken)).send({ pin: pickupPinFor(j.jobId) });
    expect((await prisma.shipment.findUniqueOrThrow({ where: { id: j.shipmentId } })).status).toBe('DISPATCHED');
    const ok = await request(app).post(`${api}/drivers/jobs/${j.jobId}/deliver`).set(auth(driverToken)).send({});
    expect(ok.body.data.status).toBe('DELIVERED');
    expect((await prisma.shipment.findUniqueOrThrow({ where: { id: j.shipmentId } })).status).toBe('READY_FOR_COLLECTION');
    expect(lastSmsTo(buyerPhone)).toContain('is ready at Dr Corner Shop');
  });

  it('not home: back to the store, which confirms; driver paid for the trip, buyer refunded, stock back', async () => {
    const j = await readyOrder({ quantity: 1 });
    const stockBefore = (await prisma.offer.findUniqueOrThrow({ where: { id: offerId } })).stockQty;
    const before = await wallet();
    await request(app).post(`${api}/drivers/jobs/${j.jobId}/claim`).set(auth(driverToken));
    await request(app).post(`${api}/drivers/jobs/${j.jobId}/pickup`).set(auth(driverToken)).send({ pin: pickupPinFor(j.jobId) });
    const failed = await request(app).post(`${api}/drivers/jobs/${j.jobId}/fail`).set(auth(driverToken)).send({ reason: 'NOT_HOME', note: 'Gate locked, phone off' });
    expect(failed.body.data.status).toBe('RETURNING');
    expect((await wallet()).lockedFloatUsd).toBe(10);

    const queue = await request(app).get(`${api}/store/orders`).query({ tab: 'ready' }).set(auth(storeToken));
    expect(queue.body.data.find((o: { id: string }) => o.id === j.shipmentId)).toMatchObject({ stage: 'RETURNING', deliveryJob: { failReason: 'NOT_HOME' } });
    const back = await request(app).post(`${api}/store/orders/${j.shipmentId}/received-back`).set(auth(storeToken));
    expect(back.status).toBe(200);
    expect(back.body.data.refundUsd).toBe(12.5);

    const after = await wallet();
    expect(after).toMatchObject({ lockedFloatUsd: 0, availableFloatUsd: before.availableFloatUsd });
    expect(after.withdrawableEarningsUsd).toBeCloseTo(before.withdrawableEarningsUsd + 1.8, 2);
    expect((await prisma.offer.findUniqueOrThrow({ where: { id: offerId } })).stockQty).toBe(stockBefore + 1);
    expect((await prisma.marketOrder.findUniqueOrThrow({ where: { id: j.orderId } })).status).toBe('CANCELLED');
    expect((await prisma.wallet.findUniqueOrThrow({ where: { userId: buyerId } })).balanceUsd.toNumber()).toBe(12.5);
    // Kuwana carries the driver's fee for the wasted trip
    const revenue = (await prisma.ledgerEntry.findMany({ where: { orderId: j.orderId } })).reduce((s, e) => s + e.platformRevenueUsd.toNumber(), 0);
    expect(revenue).toBeCloseTo(-1.8, 2);
  });
});

describe('Withdrawals', () => {
  it('earnings and free float can be withdrawn; locked float cannot; a rejection puts it back', async () => {
    const w = await wallet();
    const tooMuch = await request(app).post(`${api}/drivers/me/wallet/withdraw`).set(auth(driverToken)).send({ bucket: 'EARNINGS', amountUsd: w.withdrawableEarningsUsd + 1, method: 'ECOCASH', phone: driverPhone });
    expect(tooMuch.status).toBe(400);
    const earn = await request(app).post(`${api}/drivers/me/wallet/withdraw`).set(auth(driverToken)).send({ bucket: 'EARNINGS', amountUsd: 5, method: 'ECOCASH', phone: driverPhone });
    expect(earn.status).toBe(201);
    const flt = await request(app).post(`${api}/drivers/me/wallet/withdraw`).set(auth(driverToken)).send({ bucket: 'FLOAT', amountUsd: 20, method: 'INNBUCKS', phone: driverPhone });
    expect((await wallet()).availableFloatUsd).toBe(w.availableFloatUsd - 20);

    const list = await request(app).get(`${api}/drivers/admin/withdrawals/list`).set(auth(adminToken));
    expect(list.body.data.map((x: { id: string }) => x.id)).toEqual(expect.arrayContaining([earn.body.data.id, flt.body.data.id]));
    await request(app).post(`${api}/drivers/admin/withdrawals/${earn.body.data.id}/paid`).set(auth(adminToken)).send({ externalRef: 'EC-99881' });
    expect(lastSmsTo(driverPhone)).toContain('EC-99881');
    await request(app).post(`${api}/drivers/admin/withdrawals/${flt.body.data.id}/reject`).set(auth(adminToken)).send({ note: 'Wrong number' });
    expect((await wallet()).availableFloatUsd).toBe(w.availableFloatUsd);
    expect((await request(app).post(`${api}/drivers/admin/withdrawals/${flt.body.data.id}/paid`).set(auth(adminToken)).send({ externalRef: 'X1' })).status).toBe(400);
  });

  it('a driver with a parcel in hand cannot be suspended', async () => {
    const j = await readyOrder({ quantity: 1 });
    await request(app).post(`${api}/drivers/jobs/${j.jobId}/claim`).set(auth(driverToken));
    expect((await request(app).post(`${api}/drivers/admin/${driverId}/suspend`).set(auth(adminToken)).send({ note: 'Complaints' })).status).toBe(400);
    await request(app).post(`${api}/drivers/jobs/${j.jobId}/release`).set(auth(driverToken));
    await prisma.deliveryJob.update({ where: { id: j.jobId }, data: { status: 'CANCELLED' } });
    const s = await request(app).post(`${api}/drivers/admin/${driverId}/suspend`).set(auth(adminToken)).send({ note: 'Complaints' });
    expect(s.body.data).toMatchObject({ kycStatus: 'SUSPENDED', isOnline: false });
    expect((await request(app).get(`${api}/drivers/jobs/available`).set(auth(driverToken))).status).toBe(403);
  });
});

describe('Broadcast radius', () => {
  it('widens every 10 minutes a job waits, up to the delivery radius', () => {
    expect(effectiveRadiusKm(8, 40, 0)).toBe(8);
    expect(effectiveRadiusKm(8, 40, 10)).toBe(16);
    expect(effectiveRadiusKm(8, 40, 25)).toBe(24);
    expect(effectiveRadiusKm(8, 40, 90)).toBe(40);
  });
});
