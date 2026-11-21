import request from 'supertest';
import { Prisma } from '@prisma/client';
import { createApp } from '../src/app';
import prisma from '../src/lib/prisma';
import { consoleOutbox } from '../src/lib/sms';
import { testQueue } from '../src/lib/jobs';
import { verifySecret } from '../src/lib/secrets';
import { generateAccessToken } from '../src/middleware/auth.middleware';
import { getMarketSettings, updateMarketSettings, settingsDto } from '../src/modules/market/market.settings';
import { buyBoxService } from '../src/modules/catalog/buybox.service';
import { storeOrdersService } from '../src/modules/store/store-orders.service';
import { pinFeeBands } from './helpers/fee-bands';

/**
 * Store portal: the order queue, accept → ready (pickup PIN), branch staff, SLA timeouts,
 * out-of-stock reassignment to another store, and refunds when no store can fill a parcel.
 */

const app = createApp();
const api = '/api/v1';
const stamp = Date.now();
const buyerPhone = `+26377${String(stamp).slice(-7)}`;
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const ALL_DAY = Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((d) => [d, [['00:00', '24:00']]]));
const lastSmsTo = (to: string) => [...consoleOutbox].reverse().find((m) => m.to === to)?.body ?? '';

let restoreBands: () => Promise<void>;
let originalSettings: ReturnType<typeof settingsDto>;
let buyerId: string;
let buyerToken: string;
let addressId: string;
let productId: string;
type Store = { userId: string; token: string; sellerId: string; branchId: string; offerId: string; phone: string };
let A: Store; // wins the Buy Box: nearest, $10
let B: Store; // same price, a bit further: the fallback
let C: Store; // dearer ($12): never a fallback
let otherBranchId: string; // A's second branch

async function placeOrder(quantity = 1) {
  const body = { items: [{ offerId: A.offerId, quantity }], fulfilment: { mode: 'DELIVERY', addressId }, paymentCurrency: 'USD', paymentMethod: 'CARD' };
  const q = await request(app).post(`${api}/market/checkout/quote`).set(auth(buyerToken)).send(body);
  const res = await request(app).post(`${api}/market/orders`).set(auth(buyerToken)).send({ ...body, expectedTotalUsd: q.body.data.totals.total.usd });
  expect(res.status).toBe(201);
  const order = res.body.data.order;
  return { orderId: order.id as string, shipmentId: order.shipments[0].id as string, reference: order.shipments[0].reference as string };
}

const stockOf = async (offerId: string) => (await prisma.offer.findUniqueOrThrow({ where: { id: offerId } })).stockQty;
const sellerNet = async (orderId: string, sellerId: string) =>
  (await prisma.ledgerEntry.findMany({ where: { orderId, sellerId } })).reduce((s, e) => s.plus(e.sellerNetUsd), new Prisma.Decimal(0)).toNumber();

beforeAll(async () => {
  restoreBands = await pinFeeBands();
  originalSettings = settingsDto(await getMarketSettings());
  await updateMarketSettings({ hubsEnabled: false, storeAcceptSlaMinutes: 15, freeDeliveryThresholdUsd: 50, maxDeliveryRadiusKm: 40 });

  const city = await prisma.city.create({ data: { name: `Sp City ${stamp}`, slug: `sp-city-${stamp}`, province: 'Test', zone: 'METRO', lat: -17.8, lng: 31.04 } });
  const category = await prisma.category.create({ data: { name: 'Sp Cat', slug: `sp-cat-${stamp}`, commissionRate: 10 } });
  productId = (await prisma.product.create({ data: { sku: `P${stamp}-K`, slug: `p${stamp}-k`, title: 'Sp Kettle', categoryId: category.id } })).id;

  const store = async (key: string, lat: number, lng: number, price: number): Promise<Store> => {
    const phone = `+26371${key.charCodeAt(0)}${String(stamp).slice(-5)}`;
    const u = await prisma.user.create({ data: { email: `sp_${key}_${stamp}@kuwana.test`, passwordHash: 'x', role: 'SELLER', phone } });
    const seller = await prisma.sellerProfile.create({ data: { userId: u.id, businessName: `Sp Store ${key} ${stamp}`, slug: `sp-store-${key}-${stamp}`, kycStatus: 'APPROVED', phone } });
    const branch = await prisma.storeBranch.create({
      data: { sellerId: seller.id, code: `SP${key}-${stamp}`, name: `Branch ${key}`, cityId: city.id, address: 'x', lat, lng, operatingHours: ALL_DAY, defaultPrepTimeMins: 20, phone },
    });
    const offer = await prisma.offer.create({ data: { productId, sellerId: seller.id, storeBranchId: branch.id, priceUsd: price, stockQty: 20, fulfilmentType: 'SELLER_FULFILLED', prepTimeMins: 20 } });
    return { userId: u.id, token: generateAccessToken({ sub: u.id, role: 'SELLER', email: u.email }), sellerId: seller.id, branchId: branch.id, offerId: offer.id, phone };
  };
  A = await store('A', -17.8, 31.04, 10);
  B = await store('B', -17.83, 31.05, 10);
  C = await store('C', -17.81, 31.03, 12);
  otherBranchId = (await prisma.storeBranch.create({ data: { sellerId: A.sellerId, code: `SPA2-${stamp}`, name: 'Branch A2', cityId: city.id, address: 'y', lat: -17.9, lng: 31.1, operatingHours: ALL_DAY } })).id;
  await buyBoxService.recomputeProduct(productId);

  const buyer = await prisma.user.create({ data: { email: `sp_buyer_${stamp}@kuwana.test`, passwordHash: 'x', phone: buyerPhone, phoneVerified: true, profile: { create: { fullName: 'Rufaro Buyer' } } } });
  buyerId = buyer.id;
  buyerToken = generateAccessToken({ sub: buyer.id, role: 'USER', email: buyer.email });
  addressId = (await prisma.address.create({ data: { userId: buyer.id, label: 'Home', line1: '1 Sp Rd', city: city.name, cityId: city.id, landmark: 'Yellow gate' } })).id;
});

afterAll(async () => {
  await updateMarketSettings(originalSettings);
  await restoreBands();
  const users = await prisma.user.findMany({ where: { email: { endsWith: `${stamp}@kuwana.test` } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  const orders = await prisma.marketOrder.findMany({ where: { userId: { in: ids } }, select: { id: true } });
  const orderIds = orders.map((o) => o.id);
  const sellerIds = [A, B, C].filter(Boolean).map((s) => s.sellerId);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('kuwana.ledger_maintenance', 'on', true)`;
    await tx.ledgerEntry.deleteMany({ where: { OR: [{ orderId: { in: orderIds } }, { userId: { in: ids } }, { sellerId: { in: sellerIds } }] } });
  });
  await prisma.payment.deleteMany({ where: { checkoutRef: { in: orderIds } } });
  await prisma.marketOrder.deleteMany({ where: { id: { in: orderIds } } });
  await prisma.product.deleteMany({ where: { sku: { startsWith: `P${stamp}-` } } });
  await prisma.user.deleteMany({ where: { role: 'STORE_STAFF', email: { endsWith: `${stamp}@kuwana.test` } } });
  await prisma.sellerProfile.deleteMany({ where: { id: { in: sellerIds } } });
  await prisma.address.deleteMany({ where: { userId: { in: ids } } });
  await prisma.wallet.deleteMany({ where: { userId: { in: ids } } });
  await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
  await prisma.city.deleteMany({ where: { slug: `sp-city-${stamp}` } });
  await prisma.category.deleteMany({ where: { slug: `sp-cat-${stamp}` } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.$disconnect();
});

describe('Order queue', () => {
  let shipmentId: string;

  it('a paid order lands in the branch\'s New tab with an accept deadline, and the store is told', async () => {
    const before = Date.now();
    ({ shipmentId } = await placeOrder());
    const res = await request(app).get(`${api}/store/orders`).query({ tab: 'new' }).set(auth(A.token));
    const o = res.body.data.find((x: { id: string }) => x.id === shipmentId);
    expect(o).toMatchObject({ stage: 'NEW', branch: { id: A.branchId }, order: { recipientFirstName: 'Rufaro', deliveryMode: 'DELIVERY' }, earningsUsd: 9 });
    // Stores pack; they never see the buyer's phone or full address
    expect(JSON.stringify(o)).not.toContain(buyerPhone);
    expect(JSON.stringify(o)).not.toContain('Yellow gate');
    const acceptBy = new Date(o.acceptBy).getTime();
    expect(acceptBy - before).toBeGreaterThan(14 * 60_000);
    expect(acceptBy - before).toBeLessThan(16 * 60_000);
    expect(lastSmsTo(A.phone)).toMatch(/^NEW ORDER for Branch A: parcel .+ Accept by \d\d:\d\d/);
    expect(testQueue.some((j) => j.name === 'store.accept-timeout' && j.jobId === `accept-${shipmentId}-0`)).toBe(true);

    const me = await request(app).get(`${api}/store/me`).set(auth(A.token));
    expect(me.body.data).toMatchObject({ isOwner: true, counts: { new: 1, preparing: 0, ready: 0 } });
    // Other stores can't see or touch it
    expect((await request(app).get(`${api}/store/orders/${shipmentId}`).set(auth(B.token))).status).toBe(404);
  });

  it('accept → preparing; ready → driver queue with a 4-digit pickup PIN', async () => {
    const accepted = await request(app).post(`${api}/store/orders/${shipmentId}/accept`).set(auth(A.token));
    expect(accepted.body.data.stage).toBe('PREPARING');
    expect((await request(app).post(`${api}/store/orders/${shipmentId}/accept`).set(auth(A.token))).status).toBe(400);

    const ready = await request(app).post(`${api}/store/orders/${shipmentId}/ready`).set(auth(A.token));
    expect(ready.status).toBe(200);
    expect(ready.body.data).toMatchObject({ stage: 'READY', deliveryJob: { status: 'OPEN', pickupPin: expect.stringMatching(/^\d{4}$/) } });
    const job = await prisma.deliveryJob.findUniqueOrThrow({ where: { shipmentId } });
    expect(job.broadcastAt).not.toBeNull();
    // The driver app will check the PIN the store reads out against this hash
    expect(verifySecret(`pickup:${job.id}`, ready.body.data.deliveryJob.pickupPin, job.pickupPinHash)).toBe(true);
    const events = await prisma.storeOrderEvent.findMany({ where: { shipmentId }, orderBy: { createdAt: 'asc' } });
    expect(events.map((e) => [e.type, e.onTime])).toEqual([['ACCEPTED', true], ['READY', true]]);
    // Already packed: can't be declined any more
    expect((await request(app).post(`${api}/store/orders/${shipmentId}/out-of-stock`).set(auth(A.token)).send({})).status).toBe(400);
  });
});

describe('Branch staff', () => {
  let staffToken: string;
  let staffId: string;

  it('the owner adds staff to a branch; staff only see that branch and cannot manage staff', async () => {
    const created = await request(app).post(`${api}/store/staff`).set(auth(A.token)).send({
      fullName: 'Tino Counter', email: `sp_staff_${stamp}@kuwana.test`, password: 'Counter123', branchId: otherBranchId,
    });
    expect(created.status).toBe(201);
    staffId = created.body.data.id;
    expect(created.body.data).toMatchObject({ active: true, branch: { id: otherBranchId } });
    expect((await request(app).post(`${api}/store/staff`).set(auth(A.token)).send({ fullName: 'Xolani', email: `sp_x_${stamp}@kuwana.test`, password: 'Counter123', branchId: B.branchId })).status).toBe(400);

    staffToken = generateAccessToken({ sub: staffId, role: 'STORE_STAFF', email: `sp_staff_${stamp}@kuwana.test` });
    const me = await request(app).get(`${api}/store/me`).set(auth(staffToken));
    expect(me.body.data).toMatchObject({ isOwner: false, branches: [{ id: otherBranchId }] });
    // Branch A's orders are not theirs
    const all = await request(app).get(`${api}/store/orders`).query({ tab: 'history' }).set(auth(staffToken));
    expect(all.body.data).toEqual([]);
    expect((await request(app).get(`${api}/store/staff`).set(auth(staffToken))).status).toBe(403);
  });

  it('moving staff to branch A shows them its orders; suspending removes access', async () => {
    await request(app).patch(`${api}/store/staff/${staffId}`).set(auth(A.token)).send({ branchId: A.branchId });
    const ready = await request(app).get(`${api}/store/orders`).query({ tab: 'ready' }).set(auth(staffToken));
    expect(ready.body.data.length).toBeGreaterThanOrEqual(1);
    await request(app).patch(`${api}/store/staff/${staffId}`).set(auth(A.token)).send({ active: false });
    expect((await request(app).get(`${api}/store/me`).set(auth(staffToken))).status).toBe(403);
  });
});

describe('When a store cannot fill a parcel', () => {
  it('out of stock: the parcel moves to the next store at the same price; earnings move with it', async () => {
    const { orderId, shipmentId, reference } = await placeOrder(2);
    const bStockBefore = await stockOf(B.offerId);
    const res = await request(app).post(`${api}/store/orders/${shipmentId}/out-of-stock`).set(auth(A.token)).send({ note: 'Last two sold over the counter' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ outcome: 'REASSIGNED', refundUsd: null });

    const sh = await prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId }, include: { items: true, deliveryJob: true } });
    expect([sh.storeBranchId, sh.sellerId, sh.reassignCount, sh.acceptedAt]).toEqual([B.branchId, B.sellerId, 1, null]);
    expect(sh.items[0].offerId).toBe(B.offerId);
    expect(sh.deliveryJob).toMatchObject({ pickupBranchId: B.branchId, status: 'AWAITING_STORE' });
    // A said it has none: its stock is zeroed; B's is reserved
    expect(await stockOf(A.offerId)).toBe(0);
    expect(await stockOf(B.offerId)).toBe(bStockBefore - 2);
    // $20 less 10% commission moves from A to B
    expect(await sellerNet(orderId, A.sellerId)).toBe(0);
    expect(await sellerNet(orderId, B.sellerId)).toBe(18);
    expect(lastSmsTo(B.phone)).toContain(`NEW ORDER for Branch B: parcel ${reference}`);
    expect(lastSmsTo(buyerPhone)).toContain('another store nearby is preparing it now');
    expect(testQueue.some((j) => j.jobId === `accept-${shipmentId}-1`)).toBe(true);
    const bQueue = await request(app).get(`${api}/store/orders`).query({ tab: 'new' }).set(auth(B.token));
    expect(bQueue.body.data.find((o: { id: string }) => o.id === shipmentId)).toMatchObject({ reassigned: true });
    await prisma.offer.update({ where: { id: A.offerId }, data: { stockQty: 20 } });
    await buyBoxService.recomputeProduct(productId);
  });

  it('missed deadlines: reassigned once, then refunded to the wallet when no store is left at the price', async () => {
    const { orderId, shipmentId } = await placeOrder();
    const aStock = await stockOf(A.offerId);
    await prisma.shipment.update({ where: { id: shipmentId }, data: { acceptBy: new Date(Date.now() - 1000) } });
    expect(await storeOrdersService.sweepOverdue()).toBeGreaterThanOrEqual(1);
    let sh = await prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId } });
    expect(sh.storeBranchId).toBe(B.branchId);
    // A just didn't answer: its reserved unit goes back on sale
    expect(await stockOf(A.offerId)).toBe(aStock + 1);

    // B misses it too; C is dearer than what the buyer paid, so nobody can take it
    await prisma.shipment.update({ where: { id: shipmentId }, data: { acceptBy: new Date(Date.now() - 1000) } });
    const result = await storeOrdersService.timeoutIfUnaccepted(shipmentId);
    expect(result).toEqual({ outcome: 'REFUNDED', refundUsd: 12.5 }); // $10 + $2.50 delivery
    sh = await prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId } });
    const order = await prisma.marketOrder.findUniqueOrThrow({ where: { id: orderId } });
    expect([sh.status, order.status]).toEqual(['CANCELLED', 'CANCELLED']);
    expect((await prisma.deliveryJob.findUniqueOrThrow({ where: { shipmentId } })).status).toBe('CANCELLED');
    expect((await prisma.wallet.findUniqueOrThrow({ where: { userId: buyerId } })).balanceUsd.toNumber()).toBe(12.5);
    expect(lastSmsTo(buyerPhone)).toContain('$12.50 has been added to your Kuwana wallet');
    // Nobody keeps money for a parcel that never went out
    const entries = await prisma.ledgerEntry.findMany({ where: { orderId, type: { notIn: ['WALLET_CREDIT', 'WALLET_DEBIT'] } } });
    const net = entries.reduce((s, e) => s.plus(e.platformRevenueUsd).plus(e.sellerNetUsd), new Prisma.Decimal(0));
    expect(net.toNumber()).toBe(0);
    expect(await sellerNet(orderId, C.sellerId)).toBe(0);
  });

  it('an accepted parcel does not time out', async () => {
    const { shipmentId } = await placeOrder();
    await request(app).post(`${api}/store/orders/${shipmentId}/accept`).set(auth(A.token));
    await prisma.shipment.update({ where: { id: shipmentId }, data: { acceptBy: new Date(Date.now() - 1000) } });
    expect(await storeOrdersService.timeoutIfUnaccepted(shipmentId)).toBeNull();
  });
});

describe('Store SLA score', () => {
  it('counts on-time packing against timeouts, out-of-stock and late packing', async () => {
    await storeOrdersService.recomputeSla(A.sellerId);
    // A so far: 1 on-time READY, 1 OUT_OF_STOCK, 1 TIMED_OUT → too few to score (needs 5)
    expect((await prisma.sellerProfile.findUniqueOrThrow({ where: { id: A.sellerId } })).slaScore.toNumber()).toBe(100);
    const sh = await prisma.shipment.findFirstOrThrow({ where: { storeEvents: { some: { sellerId: A.sellerId } } } });
    await prisma.storeOrderEvent.createMany({
      data: [true, true, false].map((onTime) => ({ shipmentId: sh.id, sellerId: A.sellerId, branchId: A.branchId, type: 'READY' as const, onTime })),
    });
    await storeOrdersService.recomputeSla(A.sellerId);
    // 3 good of 6
    expect((await prisma.sellerProfile.findUniqueOrThrow({ where: { id: A.sellerId } })).slaScore.toNumber()).toBe(50);
    const perf = await request(app).get(`${api}/store/performance`).set(auth(A.token));
    expect(perf.body.data).toMatchObject({ slaScore: 50, last30Days: { timedOut: 1, outOfStock: 1, readyLate: 1 } });
  });
});
