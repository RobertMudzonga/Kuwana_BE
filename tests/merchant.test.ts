import request from 'supertest';
import { createApp } from '../src/app';
import prisma from '../src/lib/prisma';
import { consoleOutbox } from '../src/lib/sms';
import { generateAccessToken } from '../src/middleware/auth.middleware';
import { currencyService } from '../src/modules/currency/currency.service';
import { fulfilmentService } from '../src/modules/merchant/fulfilment.service';
import { getMarketSettings, updateMarketSettings, settingsDto } from '../src/modules/market/market.settings';

const app = createApp();
const api = '/api/v1';
const stamp = Date.now();
const buyerPhone = `+26377${String(stamp).slice(-7)}`;
const sellerPhone = `+26371${String(stamp).slice(-7)}`;
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const lastSmsTo = (to: string) => [...consoleOutbox].reverse().find((m) => m.to === to)?.body ?? '';

let sellerToken: string;
let otherSellerToken: string;
let buyerToken: string;
let warehouseToken: string;
let adminToken: string;
let sellerId: string;
let hubId: string;
let addressId: string;
let hubOfferId: string;
let hubProductId: string;
let ownOfferId: string;
let shipmentId: string;
let orderId: string;
let originalSettings: ReturnType<typeof settingsDto>;

async function token(email: string, role: 'USER' | 'SELLER' | 'WAREHOUSE' | 'ADMIN', extra: Record<string, unknown> = {}) {
  const u = await prisma.user.create({ data: { email, passwordHash: 'x', role, ...extra } });
  return { id: u.id, token: generateAccessToken({ sub: u.id, role, email }) };
}

beforeAll(async () => {
  originalSettings = settingsDto(await getMarketSettings());
  // Inbound stock and courier dispatch belong to the hub model, which runs only with hubs enabled
  await updateMarketSettings({ hubsEnabled: true, codDepositRequired: false, escrowHoldHours: 168, minPayoutUsd: 10, freeDeliveryThresholdUsd: 50 });

  const city = await prisma.city.create({ data: { name: `Mer City ${stamp}`, slug: `mer-city-${stamp}`, province: 'Test', zone: 'METRO', codEligible: true, lat: -17.8, lng: 31.04 } });
  hubId = (await prisma.hub.create({ data: { code: `MER-${stamp}`, name: 'Mer Hub', cityId: city.id, address: '1 Depot Rd' } })).id;
  const category = await prisma.category.create({ data: { name: 'Mer Cat', slug: `mer-cat-${stamp}`, commissionRate: 10, fulfilmentFeeUsd: 1 } });

  const s = await token(`mer_seller_${stamp}@kuwana.test`, 'SELLER');
  sellerToken = s.token;
  sellerId = (await prisma.sellerProfile.create({
    data: {
      userId: s.id, businessName: `Mer Seller ${stamp}`, slug: `mer-seller-${stamp}`, kycStatus: 'APPROVED', kycTier: 'REGISTERED',
      cityId: city.id, phone: sellerPhone, leadTimeDays: 2,
      usdPayoutDetails: { bank: 'Test Bank', accountName: 'Mer Seller', accountNumber: '0011223344' },
    },
  })).id;
  const o = await token(`mer_other_${stamp}@kuwana.test`, 'SELLER');
  otherSellerToken = o.token;
  await prisma.sellerProfile.create({ data: { userId: o.id, businessName: `Mer Other ${stamp}`, slug: `mer-other-${stamp}`, kycStatus: 'APPROVED' } });

  const [p1, p2] = await Promise.all([
    prisma.product.create({ data: { sku: `R${stamp}-HUB`, slug: `r${stamp}-hub`, title: 'Mer Hub Kettle', categoryId: category.id } }),
    prisma.product.create({ data: { sku: `R${stamp}-OWN`, slug: `r${stamp}-own`, title: 'Mer Own Lamp', categoryId: category.id } }),
  ]);
  hubProductId = p1.id;
  const branch = await prisma.storeBranch.create({ data: { sellerId, code: `MERB-${stamp}`, name: 'Mer Branch', cityId: city.id, address: 'x', lat: -17.81, lng: 31.05, phone: sellerPhone } });
  hubOfferId = (await prisma.offer.create({ data: { productId: p1.id, sellerId, priceUsd: 15, stockQty: 0, fulfilmentType: 'PLATFORM_FULFILLED', hubId } })).id;
  ownOfferId = (await prisma.offer.create({ data: { productId: p2.id, sellerId, priceUsd: 20, stockQty: 10, fulfilmentType: 'SELLER_FULFILLED', storeBranchId: branch.id, dispatchCityId: city.id, leadTimeDays: 2 } })).id;

  const b = await token(`mer_buyer_${stamp}@kuwana.test`, 'USER', { phone: buyerPhone, phoneVerified: true, profile: { create: { fullName: 'Mer Buyer' } } });
  buyerToken = b.token;
  addressId = (await prisma.address.create({ data: { userId: b.id, label: 'Home', line1: '9 Test St', city: city.name, cityId: city.id, landmark: 'Red gate' } })).id;
  warehouseToken = (await token(`mer_wh_${stamp}@kuwana.test`, 'WAREHOUSE', { hubId })).token;
  adminToken = (await token(`mer_admin_${stamp}@kuwana.test`, 'ADMIN')).token;
});

afterAll(async () => {
  await updateMarketSettings(originalSettings);
  const users = await prisma.user.findMany({ where: { email: { endsWith: `${stamp}@kuwana.test` } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  const sellers = await prisma.sellerProfile.findMany({ where: { userId: { in: ids } }, select: { id: true } });
  const sellerIds = sellers.map((x) => x.id);
  const orders = await prisma.marketOrder.findMany({ where: { userId: { in: ids } }, select: { id: true } });
  const orderIds = orders.map((x) => x.id);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('kuwana.ledger_maintenance', 'on', true)`;
    await tx.ledgerEntry.deleteMany({ where: { OR: [{ orderId: { in: orderIds } }, { sellerId: { in: sellerIds } }, { userId: { in: ids } }] } });
  });
  await prisma.payout.deleteMany({ where: { sellerId: { in: sellerIds } } });
  await prisma.payment.deleteMany({ where: { checkoutRef: { in: orderIds } } });
  await prisma.marketOrder.deleteMany({ where: { id: { in: orderIds } } });
  await prisma.inboundShipment.deleteMany({ where: { sellerId: { in: sellerIds } } });
  await prisma.product.deleteMany({ where: { sku: { startsWith: `R${stamp}-` } } });
  await prisma.sellerProfile.deleteMany({ where: { id: { in: sellerIds } } });
  await prisma.address.deleteMany({ where: { userId: { in: ids } } });
  await prisma.hub.deleteMany({ where: { code: `MER-${stamp}` } });
  await prisma.city.deleteMany({ where: { slug: `mer-city-${stamp}` } });
  await prisma.category.deleteMany({ where: { slug: `mer-cat-${stamp}` } });
  await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.$disconnect();
});

describe('Seller portal access', () => {
  it('needs a seller account', async () => {
    const res = await request(app).get(`${api}/merchant/dashboard`).set(auth(buyerToken));
    expect(res.status).toBe(403);
  });

  it('starts with an empty dashboard', async () => {
    const res = await request(app).get(`${api}/merchant/dashboard`).set(auth(sellerToken));
    expect(res.status).toBe(200);
    expect(res.body.data.balances.available.usd).toBe(0);
    expect(res.body.data.offers).toMatchObject({ active: 2, outOfStock: 1 });
  });
});

describe('Inbound stock (ASN)', () => {
  let inboundId: string;

  it('only accepts hub offers at the chosen hub', async () => {
    const res = await request(app).post(`${api}/merchant/inbound`).set(auth(sellerToken)).send({ hubId, items: [{ offerId: ownOfferId, quantity: 5 }] });
    expect(res.status).toBe(400);
  });

  it('creates, edits and submits a notice', async () => {
    const created = await request(app).post(`${api}/merchant/inbound`).set(auth(sellerToken)).send({ hubId, carrier: 'Own truck', items: [{ offerId: hubOfferId, quantity: 10 }] });
    expect(created.status).toBe(201);
    expect(created.body.data.reference).toMatch(/^ASN-/);
    inboundId = created.body.data.id;

    const edited = await request(app).patch(`${api}/merchant/inbound/${inboundId}`).set(auth(sellerToken)).send({ items: [{ offerId: hubOfferId, quantity: 20 }] });
    expect(edited.body.data.totals.expected).toBe(20);

    const submitted = await request(app).post(`${api}/merchant/inbound/${inboundId}/submit`).set(auth(sellerToken));
    expect(submitted.body.data.status).toBe('SUBMITTED');
    const again = await request(app).patch(`${api}/merchant/inbound/${inboundId}`).set(auth(sellerToken)).send({ notes: 'late edit' });
    expect(again.status).toBe(400);
  });

  it('hub staff receive it; good units become stock and the product goes on sale', async () => {
    expect((await request(app).get(`${api}/merchant/hub/inbound`).set(auth(sellerToken))).status).toBe(403);
    const queue = await request(app).get(`${api}/merchant/hub/inbound`).query({ hubId }).set(auth(warehouseToken));
    const notice = queue.body.data.find((i: { id: string }) => i.id === inboundId);
    expect(notice).toBeTruthy();

    const res = await request(app).post(`${api}/merchant/hub/inbound/${inboundId}/receive`).set(auth(warehouseToken)).send({
      items: [{ itemId: notice.items[0].id, received: 18, damaged: 1 }], notes: 'One box crushed',
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'RECEIVED', totals: { expected: 20, received: 18, damaged: 1, shortfall: 1 } });
    expect((await prisma.offer.findUniqueOrThrow({ where: { id: hubOfferId } })).stockQty).toBe(18);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: hubProductId } })).buyBoxOfferId).toBe(hubOfferId);

    const twice = await request(app).post(`${api}/merchant/hub/inbound/${inboundId}/receive`).set(auth(warehouseToken)).send({ items: [{ itemId: notice.items[0].id, received: 1 }] });
    expect(twice.status).toBe(400);
  });
});

describe('Dispatching seller-fulfilled orders', () => {
  it('a confirmed order appears to dispatch, with full delivery details, and the seller is texted', async () => {
    const body = { items: [{ offerId: ownOfferId, quantity: 2 }], fulfilment: { mode: 'DELIVERY', addressId }, paymentCurrency: 'USD', paymentMethod: 'CARD' };
    const q = await request(app).post(`${api}/market/checkout/quote`).set(auth(buyerToken)).send(body);
    const placed = await request(app).post(`${api}/market/orders`).set(auth(buyerToken)).send({ ...body, expectedTotalUsd: q.body.data.totals.total.usd });
    expect(placed.status).toBe(201);
    orderId = placed.body.data.order.id;
    expect(placed.body.data.order.status).toBe('CONFIRMED');
    const storeSms = lastSmsTo(sellerPhone);
    // Store-branch parcels live in the store portal; turn this one into a legacy courier parcel
    // (pre-zero-warehouse) so the courier dispatch flow keeps its coverage
    expect((await request(app).get(`${api}/merchant/shipments`).set(auth(sellerToken))).body.data.find((sh: { order: { id: string } }) => sh.order.id === orderId)).toBeUndefined();
    await prisma.shipment.updateMany({ where: { orderId }, data: { storeBranchId: null, tier: 'SELLER_COURIER' } });

    const list = await request(app).get(`${api}/merchant/shipments`).set(auth(sellerToken));
    const parcel = list.body.data.find((sh: { order: { id: string } }) => sh.order.id === orderId);
    shipmentId = parcel.id;
    expect(parcel).toMatchObject({ status: 'PROCESSING', overdue: false, order: { recipientPhone: buyerPhone, address: { landmark: 'Red gate' } } });
    expect(parcel.items[0]).toMatchObject({ quantity: 2, sellerNetUsd: 36 });
    expect(storeSms).toContain(`NEW ORDER for Mer Branch: parcel ${parcel.reference}`);
  });

  it("is hidden from other sellers", async () => {
    expect((await request(app).get(`${api}/merchant/shipments/${shipmentId}`).set(auth(otherSellerToken))).status).toBe(404);
    expect((await request(app).post(`${api}/merchant/shipments/${shipmentId}/pack`).set(auth(otherSellerToken))).status).toBe(404);
  });

  it('packs, dispatches on time, and delivers with the recipient PIN', async () => {
    expect((await request(app).post(`${api}/merchant/shipments/${shipmentId}/deliver`).set(auth(sellerToken)).send({ pin: '123456' })).status).toBe(400);
    const packed = await request(app).post(`${api}/merchant/shipments/${shipmentId}/pack`).set(auth(sellerToken));
    expect(packed.body.data.status).toBe('PACKED');
    const sent = await request(app).post(`${api}/merchant/shipments/${shipmentId}/dispatch`).set(auth(sellerToken)).send({ courierName: 'Swift Couriers', trackingNumber: 'SW123' });
    expect(sent.body.data).toMatchObject({ status: 'DISPATCHED', dispatchedOnTime: true, trackingNumber: 'SW123' });

    const wrong = await request(app).post(`${api}/merchant/shipments/${shipmentId}/deliver`).set(auth(sellerToken)).send({ pin: '000000' });
    expect(wrong.status).toBe(400);
    const order = await prisma.marketOrder.findUniqueOrThrow({ where: { id: orderId } });
    const pin = lastSmsTo(buyerPhone).match(new RegExp(`${order.reference} is confirmed. Your collection PIN is (\\d{6})`))![1];
    const ok = await request(app).post(`${api}/merchant/shipments/${shipmentId}/deliver`).set(auth(sellerToken)).send({ pin });
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe('DELIVERED');
    expect((await prisma.marketOrder.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('COMPLETED');
  });

  it('late dispatches pull the SLA score down', async () => {
    // Five more parcels on the same order, all dispatched late
    for (let i = 0; i < 5; i++) {
      await prisma.shipment.create({
        data: {
          orderId, reference: `R${stamp}-LATE-${i}`, sequence: 10 + i, sourceType: 'SELLER_FULFILLED', sellerId, tier: 'SELLER_COURIER',
          status: 'DISPATCHED', etaMinDays: 1, etaMaxDays: 2, dispatchedAt: new Date(Date.now() - i * 1000), dispatchedOnTime: false,
        },
      });
    }
    await fulfilmentService.recomputeSla(sellerId);
    // 1 on time out of 6
    expect((await prisma.sellerProfile.findUniqueOrThrow({ where: { id: sellerId } })).slaScore.toNumber()).toBe(16.67);
  });
});

describe('Earnings and payouts', () => {
  it('holds earnings for the return window, then releases them', async () => {
    const held = await request(app).get(`${api}/merchant/balances`).set(auth(sellerToken));
    // 2 × $20 = $40, less 10% commission (delivery is Kuwana's: the store charges no shipping)
    expect(held.body.data).toMatchObject({ available: { usd: 0 }, pending: { usd: 36 } });
    expect(held.body.data.lifetime).toMatchObject({ sales: { usd: 40 }, commission: { usd: 4 }, shipping: { usd: 0 } });

    await updateMarketSettings({ escrowHoldHours: 0 });
    const released = await request(app).get(`${api}/merchant/balances`).set(auth(sellerToken));
    expect(released.body.data).toMatchObject({ available: { usd: 36 }, pending: { usd: 0 } });
  });

  it('checks payout amount and destination', async () => {
    const small = await request(app).post(`${api}/merchant/payouts`).set(auth(sellerToken)).send({ currency: 'USD', amountUsd: 5 });
    expect(small.body.message).toBe('The minimum payout is $10.00');
    const tooMuch = await request(app).post(`${api}/merchant/payouts`).set(auth(sellerToken)).send({ currency: 'USD', amountUsd: 50 });
    expect(tooMuch.body.message).toBe('You can withdraw up to $36.00 right now');
    const noZig = await request(app).post(`${api}/merchant/payouts`).set(auth(sellerToken)).send({ currency: 'ZWG' });
    expect(noZig.status).toBe(400);
  });

  it('reserves funds on request and returns them on rejection', async () => {
    const all = await request(app).post(`${api}/merchant/payouts`).set(auth(sellerToken)).send({ currency: 'USD' });
    expect(all.status).toBe(201);
    expect(all.body.data).toMatchObject({ amountUsd: 36, amount: 36, method: 'USD_BANK', status: 'REQUESTED', destination: { bank: 'Test Bank' } });
    const after = await request(app).get(`${api}/merchant/balances`).set(auth(sellerToken));
    expect(after.body.data).toMatchObject({ available: { usd: 0 }, inPayout: { usd: 36 } });
    expect((await request(app).post(`${api}/merchant/payouts`).set(auth(sellerToken)).send({ currency: 'USD', amountUsd: 10 })).status).toBe(400);

    expect((await request(app).post(`${api}/merchant/admin/payouts/${all.body.data.id}/reject`).set(auth(sellerToken)).send({ note: 'nope' })).status).toBe(403);
    const rejected = await request(app).post(`${api}/merchant/admin/payouts/${all.body.data.id}/reject`).set(auth(adminToken)).send({ note: 'Bank details unclear' });
    expect(rejected.body.data.status).toBe('REJECTED');
    expect((await request(app).get(`${api}/merchant/balances`).set(auth(sellerToken))).body.data.available.usd).toBe(36);
  });

  it('pays out in USD and in ZiG at the current rate', async () => {
    const usd = await request(app).post(`${api}/merchant/payouts`).set(auth(sellerToken)).send({ currency: 'USD', amountUsd: 15 });
    await request(app).patch(`${api}/sellers/me`).set(auth(sellerToken)).send({ zigPayoutDetails: { method: 'ECOCASH_MERCHANT', merchantCode: '123456' } });
    const zig = await request(app).post(`${api}/merchant/payouts`).set(auth(sellerToken)).send({ currency: 'ZWG' });
    const rate = (await currencyService.requireUsdToZwg()).rate.toNumber();
    expect(zig.body.data).toMatchObject({ amountUsd: 21, method: 'ECOCASH_MERCHANT', amount: Number((21 * rate).toFixed(2)) });

    const approved = await request(app).post(`${api}/merchant/admin/payouts/${usd.body.data.id}/approve`).set(auth(adminToken));
    expect(approved.body.data.status).toBe('APPROVED');
    const paid = await request(app).post(`${api}/merchant/admin/payouts/${usd.body.data.id}/paid`).set(auth(adminToken)).send({ externalRef: 'FT2611210001' });
    expect(paid.body.data).toMatchObject({ status: 'PAID', externalRef: 'FT2611210001' });
    expect(lastSmsTo(sellerPhone)).toContain('payout');

    const b = (await request(app).get(`${api}/merchant/balances`).set(auth(sellerToken))).body.data;
    expect(b).toMatchObject({ available: { usd: 0 }, inPayout: { usd: 21 }, lifetime: { paidOut: { usd: 15 } } });
  });

  it('produces a statement that balances, and a CSV', async () => {
    const st = await request(app).get(`${api}/merchant/statement`).set(auth(sellerToken));
    expect(st.status).toBe(200);
    const types = st.body.data.entries.map((e: { type: string }) => e.type);
    // Delivery is Kuwana's revenue, so a store's statement has no shipping lines
    expect(types).toEqual(expect.arrayContaining(['SALE', 'PAYOUT', 'ADJUSTMENT']));
    expect(types).not.toContain('SHIPPING_FEE');
    expect(st.body.data.closingBalanceUsd).toBe(0); // everything earned is paid out or reserved
    const zigPayout = st.body.data.entries.find((e: { type: string; currency: string }) => e.type === 'PAYOUT' && e.currency === 'ZWG');
    expect(zigPayout.grossUsd).toBe(21);

    const csv = await request(app).get(`${api}/merchant/statement.csv`).set(auth(sellerToken));
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('Net to you (USD)');
    expect(csv.text).toContain('Closing balance (USD),0.00');
  });

  it('lists every sale, including hub-shipped ones', async () => {
    const res = await request(app).get(`${api}/merchant/sales`).set(auth(sellerToken));
    expect(res.body.data[0]).toMatchObject({ title: 'Mer Own Lamp', quantity: 2, sellerNetUsd: 36, shipmentStatus: 'DELIVERED' });
  });
});
