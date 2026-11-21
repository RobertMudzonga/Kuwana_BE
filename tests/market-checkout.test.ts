import request from 'supertest';
import { Prisma } from '@prisma/client';
import { createApp } from '../src/app';
import prisma from '../src/lib/prisma';
import { pinFeeBands } from './helpers/fee-bands';
import { consoleOutbox } from '../src/lib/sms';
import { generateAccessToken } from '../src/middleware/auth.middleware';
import { currencyService } from '../src/modules/currency/currency.service';
import { setGatewayForTests, paymentsService } from '../src/modules/payments/payments.service';
import { IPaymentGateway } from '../src/modules/payments/payment.gateway.interface';
import { marketCheckoutService } from '../src/modules/market/checkout.service';
import { getMarketSettings, updateMarketSettings, settingsDto } from '../src/modules/market/market.settings';

const app = createApp();
const api = '/api/v1';
const stamp = Date.now();
const phone = `+26377${String(stamp).slice(-7)}`;
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

let buyerId: string;
let buyerToken: string;
let otherToken: string;
let adminToken: string;
let addressId: string;
let farPickupId: string;
let hubOfferId: string; // $10, platform-fulfilled at the local hub
let sellerOfferId: string; // $5 + $2 shipping, seller-fulfilled
let scarceOfferId: string; // 1 unit in stock
let rate: number;
let originalSettings: ReturnType<typeof settingsDto>;

/** Holds payments pending so tests decide the outcome */
const pendingGateway: IPaymentGateway = {
  name: 'MOCK',
  supports: (m) => !['CASH', 'WALLET'].includes(m),
  initiatePayment: async (input) => ({ gatewayRef: `pending_${input.paymentId}`, status: 'pending', instructions: 'Approve on your phone' }),
  refund: async () => ({ success: true }),
};

const items = (...pairs: [string, number][]) => pairs.map(([offerId, quantity]) => ({ offerId, quantity }));
const delivery = () => ({ mode: 'DELIVERY' as const, addressId });

async function quote(body: Record<string, unknown>, token = buyerToken) {
  const res = await request(app).post(`${api}/market/checkout/quote`).set(auth(token)).send(body);
  expect(res.status).toBe(200);
  return res.body.data;
}

async function place(body: Record<string, unknown>) {
  const q = await quote({ ...body, expectedTotalUsd: undefined });
  return request(app).post(`${api}/market/orders`).set(auth(buyerToken)).send({ ...body, expectedTotalUsd: q.totals.total.usd });
}

const stockOf = async (offerId: string) => (await prisma.offer.findUniqueOrThrow({ where: { id: offerId } })).stockQty;
const lastSmsTo = (to: string) => [...consoleOutbox].reverse().find((m) => m.to === to)?.body ?? '';

let restoreBands: () => Promise<void>;

beforeAll(async () => {
  restoreBands = await pinFeeBands();
  originalSettings = settingsDto(await getMarketSettings());
  // Pin the rules these tests assert on, whatever the dev database has
  // These tests cover the hub-and-courier flow, which runs only with hubs enabled
  await updateMarketSettings({
    hubsEnabled: true,
    // COD confirmed by SMS code here; the deposit flow is covered in store-checkout.test.ts
    codDepositRequired: false,
    freeDeliveryThresholdUsd: 50, metroNextDayFeeUsd: 3, intercityFeeUsd: 7, pickupFeeUsd: 1.5, intercityPickupFeeUsd: 4,
    heavyThresholdKg: 10, codEnabled: true, codMaxOrderUsd: 150, codMinTrustScore: 40, codFeeUsd: 1, sameDayCutoffHour: 12,
  });
  rate = (await currencyService.requireUsdToZwg()).rate.toNumber();

  const metro = await prisma.city.create({ data: { name: `Mkt Metro ${stamp}`, slug: `mkt-metro-${stamp}`, province: 'Test', zone: 'METRO', codEligible: true, lat: -17.8, lng: 31.04 } });
  const far = await prisma.city.create({ data: { name: `Mkt Far ${stamp}`, slug: `mkt-far-${stamp}`, province: 'Test', zone: 'INTERCITY' } });
  const hub = await prisma.hub.create({ data: { code: `MK-${stamp}`, name: 'Mkt Hub', cityId: metro.id, address: 'x' } });
  farPickupId = (await prisma.pickupPoint.create({ data: { code: `PPMK-${stamp}`, name: 'Far agent', type: 'PARTNER_SHOP', cityId: far.id, address: 'x' } })).id;

  const category = await prisma.category.create({ data: { name: 'Mkt Cat', slug: `mkt-cat-${stamp}`, commissionRate: 10, fulfilmentFeeUsd: 0.5 } });
  const sellerUser = await prisma.user.create({
    data: {
      email: `mkt_seller_${stamp}@kuwana.test`, passwordHash: 'x', role: 'SELLER',
      sellerProfile: { create: { businessName: `Mkt Seller ${stamp}`, slug: `mkt-seller-${stamp}`, kycStatus: 'APPROVED', cityId: metro.id } },
    },
    include: { sellerProfile: true },
  });
  const sellerId = sellerUser.sellerProfile!.id;
  const branch = await prisma.storeBranch.create({ data: { sellerId, code: `MKB-${stamp}`, name: 'Mkt Branch', cityId: metro.id, address: 'x', lat: -17.81, lng: 31.05 } });
  const product = (sku: string, title: string, weightKg = 1) =>
    prisma.product.create({ data: { sku: `M${stamp}-${sku}`, slug: `m${stamp}-${sku}`.toLowerCase(), title, categoryId: category.id, weightKg } });
  const [p1, p2, p3] = await Promise.all([product('A', 'Test Kettle'), product('B', 'Test Soap'), product('C', 'Test Rare Lamp')]);
  hubOfferId = (await prisma.offer.create({ data: { productId: p1.id, sellerId, priceUsd: 10, stockQty: 50, fulfilmentType: 'PLATFORM_FULFILLED', hubId: hub.id } })).id;
  sellerOfferId = (await prisma.offer.create({ data: { productId: p2.id, sellerId, priceUsd: 5, shippingFeeUsd: 2, stockQty: 50, fulfilmentType: 'SELLER_FULFILLED', storeBranchId: branch.id, dispatchCityId: metro.id, leadTimeDays: 2 } })).id;
  scarceOfferId = (await prisma.offer.create({ data: { productId: p3.id, sellerId, priceUsd: 20, stockQty: 1, fulfilmentType: 'PLATFORM_FULFILLED', hubId: hub.id } })).id;

  const buyer = await prisma.user.create({
    data: { email: `mkt_buyer_${stamp}@kuwana.test`, passwordHash: 'x', phone, phoneVerified: true, codTrustScore: 50, profile: { create: { fullName: 'Test Buyer' } } },
  });
  buyerId = buyer.id;
  buyerToken = generateAccessToken({ sub: buyer.id, role: 'USER', email: buyer.email });
  const other = await prisma.user.create({ data: { email: `mkt_other_${stamp}@kuwana.test`, passwordHash: 'x' } });
  otherToken = generateAccessToken({ sub: other.id, role: 'USER', email: other.email });
  const admin = await prisma.user.create({ data: { email: `mkt_admin_${stamp}@kuwana.test`, passwordHash: 'x', role: 'ADMIN' } });
  adminToken = generateAccessToken({ sub: admin.id, role: 'ADMIN', email: admin.email });

  const addr = await request(app).post(`${api}/addresses`).set(auth(buyerToken)).send({
    label: 'Home', line1: '12 Test Rd', cityId: metro.id, suburb: 'Avondale', landmark: 'Blue gate opposite the clinic',
  });
  expect(addr.status).toBe(201);
  addressId = addr.body.data.id;
});

afterAll(async () => {
  setGatewayForTests(null);
  await restoreBands();
  await updateMarketSettings(originalSettings);
  const users = await prisma.user.findMany({ where: { email: { endsWith: `${stamp}@kuwana.test` } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  const orders = await prisma.marketOrder.findMany({ where: { userId: { in: ids } }, select: { id: true } });
  const orderIds = orders.map((o) => o.id);
  // The ledger is append-only; tests clean up their rows under the maintenance flag
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('kuwana.ledger_maintenance', 'on', true)`;
    await tx.ledgerEntry.deleteMany({ where: { OR: [{ orderId: { in: orderIds } }, { userId: { in: ids } }] } });
  });
  await prisma.payment.deleteMany({ where: { checkoutRef: { in: orderIds } } });
  await prisma.marketOrder.deleteMany({ where: { id: { in: orderIds } } });
  await prisma.product.deleteMany({ where: { sku: { startsWith: `M${stamp}-` } } });
  await prisma.sellerProfile.deleteMany({ where: { userId: { in: ids } } });
  await prisma.address.deleteMany({ where: { userId: { in: ids } } });
  await prisma.pickupPoint.deleteMany({ where: { code: `PPMK-${stamp}` } });
  await prisma.hub.deleteMany({ where: { code: `MK-${stamp}` } });
  await prisma.city.deleteMany({ where: { slug: { in: [`mkt-metro-${stamp}`, `mkt-far-${stamp}`] } } });
  await prisma.category.deleteMany({ where: { slug: `mkt-cat-${stamp}` } });
  await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.$disconnect();
});

describe('Quote', () => {
  it('splits the cart and prices each parcel', async () => {
    const q = await quote({ items: items([hubOfferId, 1], [sellerOfferId, 2]), fulfilment: delivery() });
    expect(q.shipments).toHaveLength(2);
    expect(q.shipments[0]).toMatchObject({ sourceType: 'PLATFORM_FULFILLED', tier: 'METRO_NEXT_DAY', fee: { usd: 3 } });
    // The soap is store stock: a driver brings it from the branch (~1.5 km → $2.50 band)
    expect(q.shipments[1]).toMatchObject({ sourceType: 'SELLER_FULFILLED', tier: 'STORE_DELIVERY', fee: { usd: 2.5 }, vehicleClass: 'BIKE' });
    expect(q.totals.itemsSubtotal.usd).toBe(20);
    expect(q.totals.delivery.usd).toBe(5.5);
    expect(q.totals.total.usd).toBe(25.5);
    expect(q.freeDelivery).toMatchObject({ qualifies: false, remaining: { usd: 30 } });
    // Cash on delivery is allowed for store stock too
    expect(q.cod.eligible).toBe(true);
  });

  it('applies free delivery at $50', async () => {
    const q = await quote({ items: items([hubOfferId, 5]), fulfilment: delivery() });
    expect(q.totals.delivery.usd).toBe(0);
    expect(q.shipments[0].feeWaived).toBe(true);
  });

  it('prices intercity pickup', async () => {
    const q = await quote({ items: items([hubOfferId, 1]), fulfilment: { mode: 'PICKUP', pickupPointId: farPickupId } });
    expect(q.shipments[0]).toMatchObject({ tier: 'PICKUP_POINT', fee: { usd: 4 }, etaMinDays: 2, etaMaxDays: 5 });
    expect(q.cod.reasons).toContain('Cash on delivery is only available in Harare and Bulawayo');
  });

  it('caps quantities at available stock and reports it', async () => {
    const q = await quote({ items: items([scarceOfferId, 3]) });
    expect(q.lines[0].quantity).toBe(1);
    expect(q.issues).toEqual([expect.objectContaining({ offerId: scarceOfferId, type: 'INSUFFICIENT_STOCK', availableQty: 1 })]);
  });

  it("refuses another user's address", async () => {
    const res = await request(app).post(`${api}/market/checkout/quote`).set(auth(otherToken)).send({ items: items([hubOfferId, 1]), fulfilment: delivery() });
    expect(res.status).toBe(404);
  });
});

describe('Placing orders', () => {
  it('pays online, confirms, reserves stock and writes the ledger', async () => {
    const before = await stockOf(hubOfferId);
    const res = await place({ items: items([hubOfferId, 2], [sellerOfferId, 1]), fulfilment: delivery(), paymentCurrency: 'USD', paymentMethod: 'ECOCASH', paymentPhone: phone });
    expect(res.status).toBe(201);
    const order = res.body.data.order;
    // The dev gateway approves instantly
    expect(order).toMatchObject({ status: 'CONFIRMED', paymentStatus: 'PAID', paymentCurrency: 'USD' });
    expect(order.shipments.map((s: { status: string }) => s.status)).toEqual(['PROCESSING', 'PROCESSING']);
    expect(order.shipments[1].dispatchBy).not.toBeNull();
    expect(order.totals.total.usd).toBe(30.5); // 2 × $10 + $5 + $3 next-day + $2.50 store delivery
    expect(await stockOf(hubOfferId)).toBe(before - 2);
    expect(order.deliveryAddress).toMatchObject({ suburb: 'Avondale', landmark: 'Blue gate opposite the clinic' });

    const entries = await prisma.ledgerEntry.findMany({ where: { orderId: order.id }, orderBy: { type: 'asc' } });
    const sale = entries.find((e) => e.type === 'SALE' && e.grossUsd.equals(20))!;
    // $20 line: 10% commission $2, fulfilment fee 2 × $0.50, seller nets $17
    expect([sale.commissionUsd.toNumber(), sale.fulfilmentFeeUsd.toNumber(), sale.sellerNetUsd.toNumber()]).toEqual([2, 1, 17]);
    const shipping = entries.filter((e) => e.type === 'SHIPPING_FEE').map((e) => [e.platformRevenueUsd.toNumber(), e.sellerNetUsd.toNumber()]);
    // Store run: Kuwana keeps $2.50 − $1.80 driver fee
    expect(shipping).toEqual(expect.arrayContaining([[3, 0], [0.7, 0]]));
    // Everything the buyer paid goes to the platform, a seller or (later) the driver
    const accounted = entries.reduce((sum, e) => sum.plus(e.platformRevenueUsd).plus(e.sellerNetUsd), new Prisma.Decimal(0));
    expect(accounted.toNumber()).toBe(30.5 - 1.8);
    const job = await prisma.deliveryJob.findFirstOrThrow({ where: { shipment: { orderId: order.id } } });
    expect([job.status, job.driverFeeUsd.toNumber(), job.parcelValueUsd.toNumber(), job.codAmountUsd.toNumber()]).toEqual(['AWAITING_STORE', 1.8, 5, 0]);

    expect(lastSmsTo(phone)).toMatch(new RegExp(`${order.reference} is confirmed. Your collection PIN is \\d{6}`));
  });

  it('locks the exchange rate for ZiG orders', async () => {
    const res = await place({ items: items([hubOfferId, 1]), fulfilment: delivery(), paymentCurrency: 'ZWG', paymentMethod: 'ONEMONEY', paymentPhone: phone });
    expect(res.status).toBe(201);
    const order = res.body.data.order;
    expect(order.lockedExchangeRate).toBe(rate);
    expect(order.amountDue).toEqual({ amount: Number((13 * rate).toFixed(2)), currency: 'ZWG' });

    // A later rate change doesn't touch the order
    const newRate = await currencyService.setRate({ rate: rate + 5, adminId: buyerId, note: 'test' });
    const reread = await request(app).get(`${api}/market/orders/${order.id}`).set(auth(buyerToken));
    expect(reread.body.data.amountDue.amount).toBe(order.amountDue.amount);
    await prisma.exchangeRate.delete({ where: { id: newRate.id } });
    currencyService.invalidate();
  });

  it('refuses card payments in ZiG', async () => {
    const res = await place({ items: items([hubOfferId, 1]), fulfilment: delivery(), paymentCurrency: 'ZWG', paymentMethod: 'CARD' });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Cards are charged in USD');
  });

  it('refuses when the total changed since the quote', async () => {
    const res = await request(app).post(`${api}/market/orders`).set(auth(buyerToken)).send({
      items: items([hubOfferId, 1]), fulfilment: delivery(), paymentCurrency: 'USD', paymentMethod: 'CARD', expectedTotalUsd: 9.99,
    });
    expect(res.status).toBe(409);
    expect(res.body.errors).toMatchObject({ totalUsd: 13 });
  });

  it('refuses when an item no longer has enough stock', async () => {
    const res = await request(app).post(`${api}/market/orders`).set(auth(buyerToken)).send({
      items: items([scarceOfferId, 2]), fulfilment: delivery(), paymentCurrency: 'USD', paymentMethod: 'CARD', expectedTotalUsd: 43,
    });
    expect(res.status).toBe(409);
    expect(res.body.errors.issues[0]).toMatchObject({ offerId: scarceOfferId, type: 'INSUFFICIENT_STOCK' });
  });

  it('delivers gifts to a different recipient but not as cash on delivery', async () => {
    const recipient = { name: 'Gogo Moyo', phone: '+263712345678', idNumber: '63-111111-A-63' };
    const cod = await place({ items: items([hubOfferId, 1]), fulfilment: delivery(), paymentCurrency: 'USD', paymentMethod: 'CASH', recipient });
    expect(cod.status).toBe(400);
    expect(cod.body.message).toBe('Cash on delivery is only for orders you receive yourself');

    const paid = await place({ items: items([hubOfferId, 1]), fulfilment: delivery(), paymentCurrency: 'USD', paymentMethod: 'CARD', recipient });
    expect(paid.status).toBe(201);
    expect(paid.body.data.order.recipient).toMatchObject({ name: 'Gogo Moyo', isGift: true, phone: '+263 71 *** 5678' });
    expect(lastSmsTo(recipient.phone)).toMatch(/collection PIN is \d{6}/);
  });

  it("hides one buyer's order from another", async () => {
    const mine = await request(app).get(`${api}/market/orders`).set(auth(buyerToken));
    const res = await request(app).get(`${api}/market/orders/${mine.body.data[0].id}`).set(auth(otherToken));
    expect(res.status).toBe(404);
  });
});

describe('Cash on delivery', () => {
  let orderId: string;

  it('holds the order until the SMS code is entered', async () => {
    const res = await place({ items: items([hubOfferId, 1]), fulfilment: delivery(), paymentCurrency: 'USD', paymentMethod: 'CASH' });
    expect(res.status).toBe(201);
    const order = res.body.data.order;
    orderId = order.id;
    expect(order).toMatchObject({ status: 'AWAITING_COD_OTP', paymentStatus: 'UNPAID' });
    expect(order.totals.codFee.usd).toBe(1);
    expect(lastSmsTo(phone)).toMatch(new RegExp(`confirm order ${order.reference} is \\d{6}`));
  });

  it('rejects a wrong code and accepts the right one', async () => {
    const wrong = await request(app).post(`${api}/market/orders/${orderId}/cod/verify`).set(auth(buyerToken)).send({ code: '000000' });
    expect(wrong.status).toBe(400);
    const code = lastSmsTo(phone).match(/is (\d{6})/)![1];
    const ok = await request(app).post(`${api}/market/orders/${orderId}/cod/verify`).set(auth(buyerToken)).send({ code });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ status: 'CONFIRMED', paymentStatus: 'COD_PENDING' });

    const entries = await prisma.ledgerEntry.findMany({ where: { orderId } });
    expect(entries.every((e) => e.codStatus === 'PENDING')).toBe(true);
    expect(entries.some((e) => e.type === 'COD_FEE' && e.platformRevenueUsd.equals(1))).toBe(true);
  });

  it('can be cancelled before dispatch; stock returns and the ledger nets to zero', async () => {
    const before = await stockOf(hubOfferId);
    const res = await request(app).post(`${api}/market/orders/${orderId}/cancel`).set(auth(buyerToken)).send({ reason: 'Changed my mind' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('CANCELLED');
    expect(await stockOf(hubOfferId)).toBe(before + 1);
    const entries = await prisma.ledgerEntry.findMany({ where: { orderId } });
    const net = entries.reduce((s, e) => s.plus(e.sellerNetUsd).plus(e.platformRevenueUsd), new Prisma.Decimal(0));
    expect(net.toNumber()).toBe(0);
  });

  it('is refused above the cap', async () => {
    const res = await place({ items: items([hubOfferId, 15]), fulfilment: delivery(), paymentCurrency: 'USD', paymentMethod: 'CASH' });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Cash on delivery is limited to orders up to $150.00');
  });
});

describe('Pending payments, expiry and the wallet', () => {
  let orderId: string;

  beforeAll(() => setGatewayForTests(pendingGateway));
  afterAll(() => setGatewayForTests(null));

  it('waits for the gateway and shows the instructions', async () => {
    const res = await place({ items: items([hubOfferId, 1]), fulfilment: delivery(), paymentCurrency: 'USD', paymentMethod: 'ECOCASH', paymentPhone: phone });
    const order = res.body.data.order;
    orderId = order.id;
    expect(order).toMatchObject({ status: 'PENDING_PAYMENT', paymentStatus: 'UNPAID' });
    expect(order.payment).toMatchObject({ status: 'PROCESSING', instructions: 'Approve on your phone' });
  });

  it('a failed payment can be retried with the wallet', async () => {
    const payment = await prisma.payment.findFirstOrThrow({ where: { checkoutRef: orderId } });
    await paymentsService.markFailed(payment.id, 'cancelled');
    expect((await prisma.marketOrder.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus).toBe('FAILED');

    const noFunds = await request(app).post(`${api}/market/orders/${orderId}/pay`).set(auth(buyerToken)).send({ paymentMethod: 'WALLET' });
    expect(noFunds.status).toBe(400);

    const credit = await request(app).post(`${api}/wallet/credit`).set(auth(adminToken)).send({ userId: buyerId, amountUsd: 20, memo: 'Goodwill' });
    expect(credit.status).toBe(200);
    const paid = await request(app).post(`${api}/market/orders/${orderId}/pay`).set(auth(buyerToken)).send({ paymentMethod: 'WALLET' });
    expect(paid.status).toBe(200);
    expect(paid.body.data.order).toMatchObject({ status: 'CONFIRMED', paymentStatus: 'PAID', paymentMethod: 'WALLET' });

    const wallet = await request(app).get(`${api}/wallet`).set(auth(buyerToken));
    expect(wallet.body.data.balance.usd).toBe(7); // 20 − 13
    expect(wallet.body.data.history.map((h: { type: string }) => h.type)).toEqual(['WALLET_DEBIT', 'WALLET_CREDIT']);
  });

  it('expires unpaid orders, releasing stock; a late payment is flagged for refund', async () => {
    const res = await place({ items: items([scarceOfferId, 1]), fulfilment: delivery(), paymentCurrency: 'USD', paymentMethod: 'CARD' });
    const order = res.body.data.order;
    expect(await stockOf(scarceOfferId)).toBe(0);
    const soldOut = await quote({ items: items([scarceOfferId, 1]) });
    expect(soldOut.issues[0].type).toBe('UNAVAILABLE');

    await prisma.marketOrder.update({ where: { id: order.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await marketCheckoutService.expireOverdue()).toBeGreaterThanOrEqual(1);
    const expired = await prisma.marketOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect([expired.status, expired.cancelReason]).toEqual(['CANCELLED', 'Not paid in time']);
    expect(await stockOf(scarceOfferId)).toBe(1);

    const payment = await prisma.payment.findFirstOrThrow({ where: { checkoutRef: order.id } });
    await paymentsService.markPaid(payment.id, payment.amount.toNumber());
    const late = await prisma.marketOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(late.status).toBe('CANCELLED');
    expect(late.paymentStatus).toBe('PAID');
    expect(late.cancelReason).toContain('refund due');
  });

  it('refuses to confirm a payment for the wrong amount', async () => {
    const res = await place({ items: items([hubOfferId, 1]), fulfilment: delivery(), paymentCurrency: 'USD', paymentMethod: 'CARD' });
    const payment = await prisma.payment.findFirstOrThrow({ where: { checkoutRef: res.body.data.order.id } });
    await paymentsService.markPaid(payment.id, 1);
    const order = await prisma.marketOrder.findUniqueOrThrow({ where: { id: res.body.data.order.id } });
    expect(order.status).toBe('PENDING_PAYMENT');
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).failureCode).toBe('amount_mismatch');
  });

  it('a paid order cannot be cancelled by the buyer', async () => {
    const res = await request(app).post(`${api}/market/orders/${orderId}/cancel`).set(auth(buyerToken)).send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('This order is already paid. Contact support to cancel it and get a refund.');
  });
});

describe('Ledger', () => {
  it('is append-only', async () => {
    const entry = await prisma.ledgerEntry.findFirstOrThrow({ where: { userId: buyerId } });
    await expect(prisma.ledgerEntry.update({ where: { id: entry.id }, data: { memo: 'tampered' } })).rejects.toThrow(/append-only/);
    await expect(prisma.ledgerEntry.delete({ where: { id: entry.id } })).rejects.toThrow(/append-only/);
  });
});
