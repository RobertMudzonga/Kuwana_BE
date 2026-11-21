import request from 'supertest';
import { createApp } from '../src/app';
import prisma from '../src/lib/prisma';
import { consoleOutbox } from '../src/lib/sms';
import { generateAccessToken } from '../src/middleware/auth.middleware';
import { getMarketSettings, updateMarketSettings, settingsDto } from '../src/modules/market/market.settings';

const app = createApp();
const api = '/api/v1';
const stamp = Date.now();
const buyerPhone = `+26377${String(stamp).slice(-7)}`;
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const lastSmsTo = (to: string) => [...consoleOutbox].reverse().find((m) => m.to === to)?.body ?? '';

let buyerId: string;
let buyer: string;
let warehouse: string;
let otherWarehouse: string;
let driver: string;
let driverId: string;
let agent: string;
let admin: string;
let hubId: string;
let pointId: string;
let addressId: string;
let offerId: string;
let originalSettings: ReturnType<typeof settingsDto>;

async function staff(label: string, role: 'USER' | 'WAREHOUSE' | 'DRIVER' | 'PICKUP_AGENT' | 'ADMIN', extra: Record<string, unknown> = {}) {
  const email = `ops_${label}_${stamp}@kuwana.test`;
  const u = await prisma.user.create({ data: { email, passwordHash: 'x', role, profile: { create: { fullName: `Ops ${label}` } }, ...extra } });
  return { id: u.id, token: generateAccessToken({ sub: u.id, role, email }) };
}

/** Place an order as the buyer; COD orders are confirmed with the texted code */
async function order(opts: { qty?: number; method?: string; pickup?: boolean } = {}) {
  const body = {
    items: [{ offerId, quantity: opts.qty ?? 1 }],
    fulfilment: opts.pickup ? { mode: 'PICKUP', pickupPointId: pointId } : { mode: 'DELIVERY', addressId },
    paymentCurrency: 'USD',
    paymentMethod: opts.method ?? 'CARD',
  };
  const q = await request(app).post(`${api}/market/checkout/quote`).set(auth(buyer)).send(body);
  const res = await request(app).post(`${api}/market/orders`).set(auth(buyer)).send({ ...body, expectedTotalUsd: q.body.data.totals.total.usd });
  expect(res.status).toBe(201);
  let o = res.body.data.order;
  if (o.status === 'AWAITING_COD_OTP') {
    const code = lastSmsTo(buyerPhone).match(/is (\d{6})/)![1];
    o = (await request(app).post(`${api}/market/orders/${o.id}/cod/verify`).set(auth(buyer)).send({ code })).body.data;
  }
  expect(o.status).toBe('CONFIRMED');
  return { id: o.id as string, reference: o.reference as string, shipmentId: o.shipments[0].id as string, pin: lastSmsTo(buyerPhone).match(/collection PIN is (\d{6})/)?.[1] as string };
}

const sendOut = async (shipmentId: string) => {
  await request(app).post(`${api}/ops/hub/shipments/${shipmentId}/pack`).set(auth(warehouse));
  const res = await request(app).post(`${api}/ops/hub/shipments/${shipmentId}/dispatch`).set(auth(warehouse)).send({ driverId });
  expect(res.body.data.status).toBe('OUT_FOR_DELIVERY');
};
const stock = async () => (await prisma.offer.findUniqueOrThrow({ where: { id: offerId } })).stockQty;
const trust = async () => (await prisma.user.findUniqueOrThrow({ where: { id: buyerId } })).codTrustScore;

beforeAll(async () => {
  originalSettings = settingsDto(await getMarketSettings());
  // Hub operations run only with hubs enabled
  await updateMarketSettings({ hubsEnabled: true, codDepositRequired: false, codEnabled: true, codMaxOrderUsd: 150, codMinTrustScore: 40, codFeeUsd: 1, metroNextDayFeeUsd: 3, pickupFeeUsd: 1.5, freeDeliveryThresholdUsd: 50, returnWindowDays: 7, maxDeliveryAttempts: 2 });

  const city = await prisma.city.create({ data: { name: `Ops City ${stamp}`, slug: `ops-city-${stamp}`, province: 'Test', zone: 'METRO', codEligible: true } });
  hubId = (await prisma.hub.create({ data: { code: `OPS-${stamp}`, name: 'Ops Hub', cityId: city.id, address: 'x' } })).id;
  const otherHub = await prisma.hub.create({ data: { code: `OPX-${stamp}`, name: 'Other Hub', cityId: city.id, address: 'y' } });
  pointId = (await prisma.pickupPoint.create({ data: { code: `PPO-${stamp}`, name: 'Ops Corner Shop', type: 'PARTNER_SHOP', cityId: city.id, address: 'z', hubId } })).id;
  const category = await prisma.category.create({ data: { name: 'Ops Cat', slug: `ops-cat-${stamp}`, commissionRate: 10, fulfilmentFeeUsd: 0.5 } });
  const sellerUser = await staff('seller', 'USER');
  const seller = await prisma.sellerProfile.create({ data: { userId: sellerUser.id, businessName: `Ops Seller ${stamp}`, slug: `ops-seller-${stamp}`, kycStatus: 'APPROVED' } });
  const product = await prisma.product.create({ data: { sku: `O${stamp}-A`, slug: `o${stamp}-a`, title: 'Ops Torch', categoryId: category.id } });
  offerId = (await prisma.offer.create({ data: { productId: product.id, sellerId: seller.id, priceUsd: 10, stockQty: 50, fulfilmentType: 'PLATFORM_FULFILLED', hubId } })).id;

  const b = await staff('buyer', 'USER', { phone: buyerPhone, phoneVerified: true, codTrustScore: 50 });
  buyerId = b.id;
  buyer = b.token;
  addressId = (await prisma.address.create({ data: { userId: b.id, label: 'Home', line1: '1 Ops Rd', city: city.name, cityId: city.id } })).id;
  warehouse = (await staff('wh', 'WAREHOUSE', { hubId })).token;
  otherWarehouse = (await staff('wh2', 'WAREHOUSE', { hubId: otherHub.id })).token;
  const d = await staff('driver', 'DRIVER', { hubId });
  driver = d.token;
  driverId = d.id;
  agent = (await staff('agent', 'PICKUP_AGENT', { pickupPointId: pointId })).token;
  admin = (await staff('admin', 'ADMIN')).token;
});

afterAll(async () => {
  await updateMarketSettings(originalSettings);
  const users = await prisma.user.findMany({ where: { email: { endsWith: `${stamp}@kuwana.test` } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  const orders = await prisma.marketOrder.findMany({ where: { userId: { in: ids } }, select: { id: true } });
  const orderIds = orders.map((o) => o.id);
  const sellers = await prisma.sellerProfile.findMany({ where: { userId: { in: ids } }, select: { id: true } });
  await prisma.codRemittance.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.returnRequest.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('kuwana.ledger_maintenance', 'on', true)`;
    await tx.ledgerEntry.deleteMany({ where: { OR: [{ orderId: { in: orderIds } }, { userId: { in: ids } }, { sellerId: { in: sellers.map((s) => s.id) } }] } });
  });
  await prisma.payment.deleteMany({ where: { checkoutRef: { in: orderIds } } });
  await prisma.marketOrder.deleteMany({ where: { id: { in: orderIds } } });
  await prisma.product.deleteMany({ where: { sku: { startsWith: `O${stamp}-` } } });
  await prisma.sellerProfile.deleteMany({ where: { userId: { in: ids } } });
  await prisma.address.deleteMany({ where: { userId: { in: ids } } });
  await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.pickupPoint.deleteMany({ where: { code: `PPO-${stamp}` } });
  await prisma.hub.deleteMany({ where: { code: { in: [`OPS-${stamp}`, `OPX-${stamp}`] } } });
  await prisma.city.deleteMany({ where: { slug: `ops-city-${stamp}` } });
  await prisma.category.deleteMany({ where: { slug: `ops-cat-${stamp}` } });
  await prisma.$disconnect();
});

describe('Staff access', () => {
  it('is for staff only, and says who you are', async () => {
    expect((await request(app).get(`${api}/ops/me`).set(auth(buyer))).status).toBe(403);
    const me = await request(app).get(`${api}/ops/me`).set(auth(warehouse));
    expect(me.body.data).toMatchObject({ role: 'WAREHOUSE', hub: { code: `OPS-${stamp}` } });
  });
});

describe('Hub to door: prepaid home delivery', () => {
  let o: Awaited<ReturnType<typeof order>>;

  it('shows up to pick with its shelf', async () => {
    o = await order({ qty: 2 });
    await request(app).patch(`${api}/ops/hub/offers/${offerId}/bin`).set(auth(warehouse)).send({ bin: 'A-03-2' });
    const queue = await request(app).get(`${api}/ops/hub/shipments`).set(auth(warehouse));
    expect(queue.body.data.map((s: { id: string }) => s.id)).toContain(o.shipmentId);
    const pick = await request(app).get(`${api}/ops/hub/picklist`).set(auth(warehouse));
    expect(pick.body.data.find((p: { offerId: string }) => p.offerId === offerId)).toMatchObject({ bin: 'A-03-2', quantity: 2 });
  });

  it('other hubs cannot touch it', async () => {
    expect((await request(app).post(`${api}/ops/hub/shipments/${o.shipmentId}/pack`).set(auth(otherWarehouse))).status).toBe(403);
  });

  it('packs, goes out with a driver, and is delivered with the PIN', async () => {
    await request(app).post(`${api}/ops/hub/shipments/${o.shipmentId}/pack`).set(auth(warehouse));
    const noDriver = await request(app).post(`${api}/ops/hub/shipments/${o.shipmentId}/dispatch`).set(auth(warehouse)).send({});
    expect(noDriver.body.message).toBe('Choose the driver taking this parcel');
    await request(app).post(`${api}/ops/hub/shipments/${o.shipmentId}/dispatch`).set(auth(warehouse)).send({ driverId });
    expect(lastSmsTo(buyerPhone)).toContain('out for delivery today');

    const mine = await request(app).get(`${api}/ops/driver/shipments`).set(auth(driver));
    expect(mine.body.data.map((s: { id: string }) => s.id)).toContain(o.shipmentId);
    expect((await request(app).post(`${api}/ops/shipments/${o.shipmentId}/handover`).set(auth(driver)).send({ pin: '000000' })).status).toBe(400);
    const done = await request(app).post(`${api}/ops/shipments/${o.shipmentId}/handover`).set(auth(driver)).send({ pin: o.pin });
    expect(done.body.data.status).toBe('DELIVERED');
    expect((await prisma.marketOrder.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('COMPLETED');
  });
});

describe('Cash on delivery', () => {
  let paid: Awaited<ReturnType<typeof order>>;

  it('the driver records the cash; the order becomes paid and trust goes up', async () => {
    paid = await order({ method: 'CASH' });
    await sendOut(paid.shipmentId);
    const list = await request(app).get(`${api}/ops/driver/shipments`).set(auth(driver));
    expect(list.body.data.find((s: { id: string }) => s.id === paid.shipmentId).cashToCollect).toEqual({ amount: 14, currency: 'USD' });

    const noCash = await request(app).post(`${api}/ops/shipments/${paid.shipmentId}/handover`).set(auth(driver)).send({ pin: paid.pin });
    expect(noCash.body.message).toBe('Enter the cash you collected');
    const before = await trust();
    const ok = await request(app).post(`${api}/ops/shipments/${paid.shipmentId}/handover`).set(auth(driver)).send({ pin: paid.pin, cashCollected: 14 });
    expect(ok.body.data).toMatchObject({ status: 'DELIVERED', cashCollected: 14 });
    expect(await prisma.marketOrder.findUniqueOrThrow({ where: { id: paid.id } })).toMatchObject({ status: 'COMPLETED', paymentStatus: 'PAID' });
    expect(await trust()).toBe(before + 5);
    expect(await prisma.ledgerEntry.count({ where: { orderId: paid.id, type: 'COD_COLLECTED', codStatus: 'COLLECTED' } })).toBe(1);
  });

  it('a refused parcel comes back: stock restored, money reversed, trust down', async () => {
    const o = await order({ method: 'CASH' });
    const stockAfterOrder = await stock();
    await sendOut(o.shipmentId);
    const first = await request(app).post(`${api}/ops/shipments/${o.shipmentId}/fail`).set(auth(driver)).send({ reason: 'NOT_HOME' });
    expect(first.body.data).toMatchObject({ status: 'PACKED', deliveryAttempts: 1, driver: null });

    await request(app).post(`${api}/ops/hub/shipments/${o.shipmentId}/dispatch`).set(auth(warehouse)).send({ driverId });
    const before = await trust();
    const refused = await request(app).post(`${api}/ops/shipments/${o.shipmentId}/fail`).set(auth(driver)).send({ reason: 'REFUSED', note: 'Changed mind' });
    expect(refused.body.data.status).toBe('RETURNED');
    expect(await stock()).toBe(stockAfterOrder + 1);
    expect(await trust()).toBe(before - 15);
    expect((await prisma.marketOrder.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('CANCELLED');
    const entries = await prisma.ledgerEntry.findMany({ where: { orderId: o.id } });
    const net = entries.reduce((s, e) => s + e.sellerNetUsd.toNumber() + e.platformRevenueUsd.toNumber(), 0);
    // Everything is reversed, including the COD fee that was never collected
    expect(Math.round(net * 100)).toBe(0);
  });

  it('cash-up: matching cash is verified; a short parcel is a discrepancy', async () => {
    const list = await request(app).get(`${api}/ops/cod`).set(auth(warehouse));
    const mine = list.body.data.items.filter((i: { shipmentReference: string }) => i.shipmentReference.startsWith(paid.reference));
    expect(list.body.data.collectors.find((c: { collector: { id: string } }) => c.collector.id === driverId).totals.USD).toBeGreaterThanOrEqual(14);
    const ok = await request(app).post(`${api}/ops/cod/verify`).set(auth(warehouse)).send({ ids: mine.map((i: { id: string }) => i.id), counted: { USD: 14 } });
    expect(ok.body.data.status).toBe('VERIFIED');
    expect((await request(app).post(`${api}/ops/cod/verify`).set(auth(warehouse)).send({ ids: [mine[0].id], counted: { USD: 14 } })).status).toBe(400);

    const short = await order({ method: 'CASH' });
    await sendOut(short.shipmentId);
    await request(app).post(`${api}/ops/shipments/${short.shipmentId}/handover`).set(auth(driver)).send({ pin: short.pin, cashCollected: 10 });
    const rem = await prisma.codRemittance.findUniqueOrThrow({ where: { shipmentId: short.shipmentId } });
    const bad = await request(app).post(`${api}/ops/cod/verify`).set(auth(warehouse)).send({ ids: [rem.id], counted: { USD: 10 } });
    expect(bad.body.data.status).toBe('DISCREPANCY');
    expect(bad.body.data.note).toContain('not paid in full');
  });
});

describe('Pickup points and failed prepaid deliveries', () => {
  it('goes to the pickup point, is marked arrived, and collected with the PIN', async () => {
    const o = await order({ pickup: true });
    await request(app).post(`${api}/ops/hub/shipments/${o.shipmentId}/pack`).set(auth(warehouse));
    const sent = await request(app).post(`${api}/ops/hub/shipments/${o.shipmentId}/dispatch`).set(auth(warehouse)).send({});
    expect(sent.body.data.status).toBe('DISPATCHED');

    const at = await request(app).get(`${api}/ops/pickup/shipments`).set(auth(agent));
    expect(at.body.data.map((s: { id: string }) => s.id)).toContain(o.shipmentId);
    const early = await request(app).post(`${api}/ops/shipments/${o.shipmentId}/handover`).set(auth(agent)).send({ pin: o.pin });
    expect(early.body.message).toBe('Mark the parcel as arrived before handing it over');
    await request(app).post(`${api}/ops/pickup/shipments/${o.shipmentId}/arrived`).set(auth(agent));
    expect(lastSmsTo(buyerPhone)).toContain('ready to collect at Ops Corner Shop');
    const collected = await request(app).post(`${api}/ops/shipments/${o.shipmentId}/handover`).set(auth(agent)).send({ pin: o.pin });
    expect(collected.body.data.status).toBe('COLLECTED');
  });

  it('a prepaid parcel that fails twice is refunded to the wallet', async () => {
    const o = await order();
    await sendOut(o.shipmentId);
    await request(app).post(`${api}/ops/shipments/${o.shipmentId}/fail`).set(auth(driver)).send({ reason: 'NOT_HOME' });
    await request(app).post(`${api}/ops/hub/shipments/${o.shipmentId}/dispatch`).set(auth(warehouse)).send({ driverId });
    const last = await request(app).post(`${api}/ops/shipments/${o.shipmentId}/fail`).set(auth(driver)).send({ reason: 'WRONG_ADDRESS' });
    expect(last.body.data.status).toBe('RETURNED');
    const wallet = await request(app).get(`${api}/wallet`).set(auth(buyer));
    expect(wallet.body.data.balance.usd).toBe(13); // $10 item + $3 delivery
  });
});

describe('Returns', () => {
  let delivered: Awaited<ReturnType<typeof order>>;
  let returnId: string;

  beforeAll(async () => {
    delivered = await order({ qty: 2 });
    await sendOut(delivered.shipmentId);
    await request(app).post(`${api}/ops/shipments/${delivered.shipmentId}/handover`).set(auth(driver)).send({ pin: delivered.pin });
  });

  it('lists what can be returned and refuses too many', async () => {
    const elig = await request(app).get(`${api}/returns/order/${delivered.id}`).set(auth(buyer));
    expect(elig.body.data.items[0]).toMatchObject({ returnableQuantity: 2, reason: null });
    const tooMany = await request(app).post(`${api}/returns`).set(auth(buyer)).send({
      orderId: delivered.id, items: [{ orderItemId: elig.body.data.items[0].orderItemId, quantity: 3 }], reason: 'DEFECTIVE', method: 'DROP_OFF', pickupPointId: pointId, refundDestination: 'WALLET',
    });
    expect(tooMany.status).toBe(400);
  });

  it('drop-off, hub receipt and inspection refund the wallet, restock and reverse the seller', async () => {
    const elig = await request(app).get(`${api}/returns/order/${delivered.id}`).set(auth(buyer));
    const created = await request(app).post(`${api}/returns`).set(auth(buyer)).send({
      orderId: delivered.id, items: [{ orderItemId: elig.body.data.items[0].orderItemId, quantity: 1 }], reason: 'DEFECTIVE',
      details: 'Does not switch on', method: 'DROP_OFF', pickupPointId: pointId, refundDestination: 'WALLET',
    });
    expect(created.status).toBe(201);
    returnId = created.body.data.id;
    expect(lastSmsTo(buyerPhone)).toContain(`${created.body.data.reference} approved`);

    const atPoint = await request(app).get(`${api}/ops/returns`).set(auth(agent));
    expect(atPoint.body.data.map((r: { id: string }) => r.id)).toContain(returnId);
    await request(app).post(`${api}/ops/returns/${returnId}/dropped-off`).set(auth(agent));
    expect((await request(app).post(`${api}/ops/returns/${returnId}/inspect`).set(auth(warehouse)).send({ approve: true, note: 'Faulty switch' })).status).toBe(400);
    await request(app).post(`${api}/ops/returns/${returnId}/received`).set(auth(warehouse));

    const walletBefore = (await request(app).get(`${api}/wallet`).set(auth(buyer))).body.data.balance.usd;
    const stockBefore = await stock();
    const itemId = created.body.data.items[0].id;
    const inspected = await request(app).post(`${api}/ops/returns/${returnId}/inspect`).set(auth(warehouse)).send({ approve: true, note: 'Faulty switch, repaired and resellable', resellableItemIds: [itemId] });
    expect(inspected.body.data).toMatchObject({ status: 'REFUNDED', refundUsd: 10 });
    expect((await request(app).get(`${api}/wallet`).set(auth(buyer))).body.data.balance.usd).toBe(walletBefore + 10);
    expect(await stock()).toBe(stockBefore + 1);
    const refund = await prisma.ledgerEntry.findFirstOrThrow({ where: { orderId: delivered.id, type: 'REFUND' } });
    // $10 refunded; the seller gets the $1 commission back, so their net drops by $9
    expect([refund.grossUsd.toNumber(), refund.sellerNetUsd.toNumber(), refund.platformRevenueUsd.toNumber()]).toEqual([-10, -9, -1]);
  });

  it('refunds to the card through the gateway', async () => {
    const elig = await request(app).get(`${api}/returns/order/${delivered.id}`).set(auth(buyer));
    expect(elig.body.data.items[0].returnableQuantity).toBe(1);
    const r = await request(app).post(`${api}/returns`).set(auth(buyer)).send({
      orderId: delivered.id, items: [{ orderItemId: elig.body.data.items[0].orderItemId, quantity: 1 }], reason: 'WRONG_ITEM',
      method: 'COURIER_COLLECTION', refundDestination: 'ORIGINAL',
    });
    await request(app).post(`${api}/ops/returns/${r.body.data.id}/received`).set(auth(warehouse));
    const done = await request(app).post(`${api}/ops/returns/${r.body.data.id}/inspect`).set(auth(warehouse)).send({ approve: true, note: 'Wrong colour sent' });
    expect(done.body.data).toMatchObject({ status: 'REFUNDED', refundDestination: 'ORIGINAL', refundManual: false });
  });

  it('closes after the return window', async () => {
    await updateMarketSettings({ returnWindowDays: 0 });
    const o = await order();
    await sendOut(o.shipmentId);
    await request(app).post(`${api}/ops/shipments/${o.shipmentId}/handover`).set(auth(driver)).send({ pin: o.pin });
    const elig = await request(app).get(`${api}/returns/order/${o.id}`).set(auth(buyer));
    expect(elig.body.data.items[0]).toMatchObject({ returnableQuantity: 0, reason: 'Return window has closed' });
    await updateMarketSettings({ returnWindowDays: 7 });
  });
});

describe('Admin', () => {
  it('reports GMV and revenue to admins only', async () => {
    expect((await request(app).get(`${api}/ops/admin/analytics`).set(auth(warehouse))).status).toBe(403);
    const res = await request(app).get(`${api}/ops/admin/analytics`).query({ days: 7 }).set(auth(admin));
    expect(res.status).toBe(200);
    expect(res.body.data.totals.orders).toBeGreaterThanOrEqual(5);
    expect(res.body.data.totals.gmvUsd).toBeGreaterThan(0);
    expect(res.body.data.byPaymentMethod.map((m: { key: string }) => m.key)).toEqual(expect.arrayContaining(['CARD', 'CASH']));
  });

  it('creates and assigns staff', async () => {
    const noPoint = await request(app).post(`${api}/ops/admin/staff`).set(auth(admin)).send({ email: `ops_new_${stamp}@kuwana.test`, fullName: 'New Agent', role: 'PICKUP_AGENT', password: 'Temp@12345' });
    expect(noPoint.status).toBe(400);
    const ok = await request(app).post(`${api}/ops/admin/staff`).set(auth(admin)).send({ email: `ops_new_${stamp}@kuwana.test`, fullName: 'New Driver', role: 'DRIVER', hubId, password: 'Temp@12345' });
    expect(ok.body.data).toMatchObject({ role: 'DRIVER', hub: { id: hubId } });
  });
});
