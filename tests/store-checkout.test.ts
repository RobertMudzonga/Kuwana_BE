import request from 'supertest';
import { Prisma } from '@prisma/client';
import { createApp } from '../src/app';
import prisma from '../src/lib/prisma';
import { consoleOutbox } from '../src/lib/sms';
import { generateAccessToken } from '../src/middleware/auth.middleware';
import { setGatewayForTests, paymentsService } from '../src/modules/payments/payments.service';
import { IPaymentGateway } from '../src/modules/payments/payment.gateway.interface';
import { marketCheckoutService } from '../src/modules/market/checkout.service';
import { codAmountsByShipment } from '../src/modules/market/handover';
import { getMarketSettings, updateMarketSettings, settingsDto } from '../src/modules/market/market.settings';
import { buyBoxService } from '../src/modules/catalog/buybox.service';
import { pinFeeBands } from './helpers/fee-bands';

/**
 * Zero-warehouse checkout: parcels split per store branch, priced by distance and vehicle,
 * COD with an upfront delivery-fee deposit, delivery jobs, pickup points and diaspora gifts.
 */

const app = createApp();
const api = '/api/v1';
const stamp = Date.now();
const phone = `+26378${String(stamp).slice(-7)}`;
const giftPhone = `+26371${String(stamp).slice(-7)}`;
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const ALL_DAY = Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((d) => [d, [['00:00', '24:00']]]));

let buyerToken: string;
let diasporaToken: string;
let cityId: string;
let suburbId: string;
let addressId: string;
let pickupPointId: string;
let kettleOffer: string; // $10, store A, ~0.1 km from the buyer
let soapOffer: string; // $5, store B, ~6.7 km away
let fridgeOffer: string; // $30, store A, needs a car
let farOffer: string; // $4, store C in another town
let restoreBands: () => Promise<void>;
let originalSettings: ReturnType<typeof settingsDto>;

/** Leaves payments pending so the test decides when the deposit arrives */
const pendingGateway: IPaymentGateway = {
  name: 'MOCK',
  supports: (m) => !['CASH', 'WALLET'].includes(m),
  initiatePayment: async (input) => ({ gatewayRef: `pending_${input.paymentId}`, status: 'pending', instructions: 'Approve on your phone' }),
  refund: async () => ({ success: true }),
};

const items = (...pairs: [string, number][]) => pairs.map(([offerId, quantity]) => ({ offerId, quantity }));
const delivery = () => ({ mode: 'DELIVERY' as const, addressId });
const lastSmsTo = (to: string) => [...consoleOutbox].reverse().find((m) => m.to === to)?.body ?? '';

async function quote(body: Record<string, unknown>, token = buyerToken) {
  const res = await request(app).post(`${api}/market/checkout/quote`).set(auth(token)).send(body);
  expect(res.status).toBe(200);
  return res.body.data;
}
async function place(body: Record<string, unknown>, token = buyerToken) {
  const q = await quote(body, token);
  return request(app).post(`${api}/market/orders`).set(auth(token)).send({ ...body, expectedTotalUsd: q.totals.total.usd });
}

beforeAll(async () => {
  restoreBands = await pinFeeBands();
  originalSettings = settingsDto(await getMarketSettings());
  await updateMarketSettings({
    hubsEnabled: false, codDepositRequired: true, codEnabled: true, codMaxOrderUsd: 150, codMinTrustScore: 40, codFeeUsd: 1,
    freeDeliveryThresholdUsd: 50, pickupPointDiscountPct: 40, maxDeliveryRadiusKm: 40, paymentTimeoutMinutes: 30,
  });

  const city = await prisma.city.create({ data: { name: `Sc City ${stamp}`, slug: `sc-city-${stamp}`, province: 'Test', zone: 'METRO', codEligible: true, lat: -17.8, lng: 31.04 } });
  const far = await prisma.city.create({ data: { name: `Sc Far ${stamp}`, slug: `sc-far-${stamp}`, province: 'Test', zone: 'INTERCITY', lat: -20.15, lng: 28.58 } });
  cityId = city.id;
  suburbId = (await prisma.suburb.create({ data: { cityId, name: `Testsub ${stamp}`, lat: -17.799, lng: 31.038 } })).id;
  pickupPointId = (await prisma.pickupPoint.create({ data: { code: `PPSC-${stamp}`, name: 'Sc Corner Shop', type: 'PARTNER_SHOP', cityId, address: 'x', lat: -17.8615, lng: 31.0365 } })).id;

  const category = await prisma.category.create({ data: { name: 'Sc Cat', slug: `sc-cat-${stamp}`, commissionRate: 10 } });
  const store = async (key: string, branchCity: string, lat: number, lng: number) => {
    const u = await prisma.user.create({ data: { email: `sc_${key}_${stamp}@kuwana.test`, passwordHash: 'x', role: 'SELLER' } });
    const seller = await prisma.sellerProfile.create({ data: { userId: u.id, businessName: `Sc Store ${key} ${stamp}`, slug: `sc-store-${key}-${stamp}`, kycStatus: 'APPROVED' } });
    const branch = await prisma.storeBranch.create({
      data: { sellerId: seller.id, code: `SC${key}-${stamp}`, name: `Branch ${key}`, cityId: branchCity, address: 'x', lat, lng, operatingHours: ALL_DAY, defaultPrepTimeMins: 20, phone: `+26377${key.charCodeAt(0)}${String(stamp).slice(-6)}` },
    });
    return { sellerId: seller.id, branchId: branch.id };
  };
  const a = await store('A', cityId, -17.7995, 31.0385);
  const b = await store('B', cityId, -17.86, 31.04);
  const c = await store('C', far.id, -20.15, 28.58);
  const product = (sku: string, title: string, extra: Partial<Prisma.ProductUncheckedCreateInput> = {}) =>
    prisma.product.create({ data: { sku: `S${stamp}-${sku}`, slug: `s${stamp}-${sku}`.toLowerCase(), title, categoryId: category.id, ...extra } });
  const [kettle, soap, fridge, far2] = await Promise.all([
    product('K', 'Sc Kettle'), product('S', 'Sc Soap'), product('F', 'Sc Bar Fridge', { requiredVehicleClass: 'CAR' }), product('X', 'Sc Far Thing'),
  ]);
  const offer = (productId: string, s: { sellerId: string; branchId: string }, priceUsd: number) =>
    prisma.offer.create({ data: { productId, sellerId: s.sellerId, storeBranchId: s.branchId, priceUsd, stockQty: 20, fulfilmentType: 'SELLER_FULFILLED', prepTimeMins: 20 } }).then((o) => o.id);
  kettleOffer = await offer(kettle.id, a, 10);
  soapOffer = await offer(soap.id, b, 5);
  fridgeOffer = await offer(fridge.id, a, 30);
  farOffer = await offer(far2.id, c, 4);
  await buyBoxService.recomputeProducts([kettle.id, soap.id, fridge.id, far2.id]);

  const buyer = await prisma.user.create({
    data: { email: `sc_buyer_${stamp}@kuwana.test`, passwordHash: 'x', phone, phoneVerified: true, codTrustScore: 50, profile: { create: { fullName: 'Sc Buyer' } } },
  });
  buyerToken = generateAccessToken({ sub: buyer.id, role: 'USER', email: buyer.email });
  addressId = (await prisma.address.create({ data: { userId: buyer.id, label: 'Home', line1: '5 Test Rd', city: city.name, cityId, suburb: `Testsub ${stamp}`, landmark: 'Green gate' } })).id;
  // A buyer in the UK with no Zimbabwean number
  const diaspora = await prisma.user.create({ data: { email: `sc_uk_${stamp}@kuwana.test`, passwordHash: 'x', profile: { create: { fullName: 'Tendai in Leeds' } } } });
  diasporaToken = generateAccessToken({ sub: diaspora.id, role: 'USER', email: diaspora.email });
});

afterAll(async () => {
  setGatewayForTests(null);
  await updateMarketSettings(originalSettings);
  await restoreBands();
  const users = await prisma.user.findMany({ where: { email: { endsWith: `${stamp}@kuwana.test` } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  const orders = await prisma.marketOrder.findMany({ where: { userId: { in: ids } }, select: { id: true } });
  const orderIds = orders.map((o) => o.id);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('kuwana.ledger_maintenance', 'on', true)`;
    await tx.ledgerEntry.deleteMany({ where: { OR: [{ orderId: { in: orderIds } }, { userId: { in: ids } }] } });
  });
  await prisma.payment.deleteMany({ where: { checkoutRef: { in: orderIds } } });
  await prisma.marketOrder.deleteMany({ where: { id: { in: orderIds } } });
  await prisma.product.deleteMany({ where: { sku: { startsWith: `S${stamp}-` } } });
  await prisma.sellerProfile.deleteMany({ where: { userId: { in: ids } } });
  await prisma.address.deleteMany({ where: { userId: { in: ids } } });
  await prisma.pickupPoint.deleteMany({ where: { code: `PPSC-${stamp}` } });
  await prisma.city.deleteMany({ where: { slug: { in: [`sc-city-${stamp}`, `sc-far-${stamp}`] } } });
  await prisma.category.deleteMany({ where: { slug: `sc-cat-${stamp}` } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.$disconnect();
});

describe('Store parcels', () => {
  it('splits the cart per store branch and prices each run by distance', async () => {
    const q = await quote({ items: items([kettleOffer, 1], [soapOffer, 2]), fulfilment: delivery() });
    expect(q.shipments.map((s: { tier: string; fee: { usd: number }; vehicleClass: string }) => [s.tier, s.fee.usd, s.vehicleClass])).toEqual([
      ['STORE_DELIVERY', 2.5, 'BIKE'],
      ['STORE_DELIVERY', 3.5, 'BIKE'],
    ]);
    const [near, far] = q.shipments;
    expect(near.distanceKm).toBeLessThan(1);
    expect(far.distanceKm).toBeGreaterThan(6);
    // 20 min packing + 15 + ~3 min/km
    expect(near.etaMinutes).toBe(35);
    expect(q.totals).toMatchObject({ itemsSubtotal: { usd: 20 }, delivery: { usd: 6 }, sellerShipping: { usd: 0 }, total: { usd: 26 } });
  });

  it('needs a car for the fridge, priced from the car band', async () => {
    const q = await quote({ items: items([kettleOffer, 1], [fridgeOffer, 1]), fulfilment: delivery() });
    expect(q.shipments).toHaveLength(1);
    expect(q.shipments[0]).toMatchObject({ vehicleClass: 'CAR', fee: { usd: 12 } });
  });

  it('a pickup point is cheaper (drivers batch them) and listed nearest first', async () => {
    const q = await quote({ items: items([kettleOffer, 1], [soapOffer, 1]), fulfilment: { mode: 'PICKUP', pickupPointId } });
    // 60% of the door fee: store A ~6.9 km → $3.50 × 0.6; store B ~0.4 km → $2.50 × 0.6
    expect(q.shipments.map((s: { tier: string; fee: { usd: number } }) => [s.tier, s.fee.usd])).toEqual([['PICKUP_POINT', 2.1], ['PICKUP_POINT', 1.5]]);

    const points = await request(app).get(`${api}/logistics/pickup-points`).query({ city: cityId, suburb: suburbId });
    expect(points.body.data[0]).toMatchObject({ id: pickupPointId });
    expect(points.body.data[0].distanceKm).toBeGreaterThan(6);
  });

  it('flags a store too far away and refuses the order until it is removed', async () => {
    const q = await quote({ items: items([kettleOffer, 1], [farOffer, 1]), fulfilment: delivery() });
    expect(q.issues).toEqual([expect.objectContaining({ offerId: farOffer, type: 'UNDELIVERABLE', message: expect.stringContaining('too far to deliver') })]);
    const res = await request(app).post(`${api}/market/orders`).set(auth(buyerToken)).send({
      items: items([kettleOffer, 1], [farOffer, 1]), fulfilment: delivery(), paymentCurrency: 'USD', paymentMethod: 'CARD', expectedTotalUsd: q.totals.total.usd,
    });
    expect(res.status).toBe(409);
  });

  it('a paid order creates a delivery job per store parcel and texts each branch', async () => {
    const res = await place({ items: items([kettleOffer, 1], [soapOffer, 2]), fulfilment: delivery(), paymentCurrency: 'USD', paymentMethod: 'CARD' });
    expect(res.status).toBe(201);
    const order = res.body.data.order;
    expect(order.status).toBe('CONFIRMED');
    expect(order.shipments[0]).toMatchObject({ tier: 'STORE_DELIVERY', vehicleClass: 'BIKE', etaMinutes: 35, deliveryJob: { status: 'AWAITING_STORE' } });
    expect(order.shipments[0].estimatedAt).not.toBeNull();

    const jobs = await prisma.deliveryJob.findMany({ where: { shipment: { orderId: order.id } }, orderBy: { reference: 'asc' } });
    expect(jobs.map((j) => [j.customerFeeUsd.toNumber(), j.driverFeeUsd.toNumber(), j.parcelValueUsd.toNumber(), j.codAmountUsd.toNumber(), j.collateralRequiredUsd.toNumber()]))
      .toEqual([[2.5, 1.8, 10, 0, 10], [3.5, 2.5, 10, 0, 10]]);
    expect(jobs[0]).toMatchObject({ dropoffType: 'ADDRESS', recipientPhone: phone, vehicleRequired: 'BIKE' });
    // The job carries the order's delivery OTP (same hash the recipient's SMS PIN checks against)
    const o = await prisma.marketOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(jobs[0].deliveryOtpHash).toBe(o.collectionPinHash);

    const branch = await prisma.storeBranch.findFirstOrThrow({ where: { code: `SCA-${stamp}` } });
    expect(lastSmsTo(branch.phone!)).toMatch(/^NEW ORDER for Branch A: parcel /);
  });
});

describe('Cash on delivery with an upfront deposit', () => {
  let orderId: string;
  const body = () => ({ items: items([kettleOffer, 1], [soapOffer, 2]), fulfilment: delivery(), paymentCurrency: 'USD', paymentMethod: 'CASH', paymentPhone: phone });

  beforeAll(() => setGatewayForTests(pendingGateway));
  afterAll(() => setGatewayForTests(null));

  it('quotes the deposit (delivery + COD fee) and the cash due at the door', async () => {
    const q = await quote({ ...body(), paymentPhone: undefined });
    expect(q.totals).toMatchObject({ total: { usd: 27 }, codFee: { usd: 1 }, codDeposit: { usd: 7 }, cashOnDelivery: { usd: 20 } });
  });

  it('needs EcoCash or InnBucks for the deposit', async () => {
    const res = await place(body());
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/EcoCash or InnBucks/);
  });

  it('waits for the deposit; nothing goes to the stores yet', async () => {
    const res = await place({ ...body(), depositMethod: 'INNBUCKS' });
    expect(res.status).toBe(201);
    const order = res.body.data.order;
    orderId = order.id;
    expect(order).toMatchObject({ status: 'AWAITING_DEPOSIT', amountDue: { amount: 7, currency: 'USD' }, totals: { codDeposit: { usd: 7 }, cashOnDelivery: { usd: 20 } } });
    expect(order.payment).toMatchObject({ method: 'INNBUCKS', amount: 7, status: 'PROCESSING' });
    expect(await prisma.deliveryJob.count({ where: { shipment: { orderId } } })).toBe(0);
    // Retrying with a card is not allowed for a deposit
    const card = await request(app).post(`${api}/market/orders/${orderId}/pay`).set(auth(buyerToken)).send({ paymentMethod: 'CARD' });
    expect(card.status).toBe(400);
  });

  it('once the deposit is in, the order is confirmed and drivers collect only the goods', async () => {
    const payment = await prisma.payment.findFirstOrThrow({ where: { checkoutRef: orderId }, orderBy: { createdAt: 'desc' } });
    await paymentsService.markPaid(payment.id, 7);
    const order = await prisma.marketOrder.findUniqueOrThrow({ where: { id: orderId } });
    expect([order.status, order.paymentStatus, !!order.depositPaidAt]).toEqual(['CONFIRMED', 'COD_PENDING', true]);

    const jobs = await prisma.deliveryJob.findMany({ where: { shipment: { orderId } }, orderBy: { reference: 'asc' } });
    expect(jobs.map((j) => j.codAmountUsd.toNumber())).toEqual([10, 10]);
    const cash = [...(await codAmountsByShipment(prisma, orderId)).values()].map((d) => d.toNumber());
    expect(cash).toEqual([10, 10]);

    // Fees were paid online; only the sales wait for cash
    const entries = await prisma.ledgerEntry.findMany({ where: { orderId } });
    expect(entries.filter((e) => e.type === 'SALE').every((e) => e.codStatus === 'PENDING')).toBe(true);
    expect(entries.filter((e) => e.type !== 'SALE').every((e) => e.codStatus === 'NOT_COD' && e.paymentId === payment.id)).toBe(true);
    expect(entries.find((e) => e.type === 'COD_FEE')?.platformRevenueUsd.toNumber()).toBe(1);
  });

  it('a buyer who cancels before dispatch keeps the stock released but not the deposit', async () => {
    const res = await request(app).post(`${api}/market/orders/${orderId}/cancel`).set(auth(buyerToken)).send({});
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('CANCELLED');
    const entries = await prisma.ledgerEntry.findMany({ where: { orderId } });
    const sales = entries.filter((e) => e.type === 'SALE' || (e.type === 'ADJUSTMENT' && e.orderItemId));
    expect(sales.reduce((s, e) => s.plus(e.sellerNetUsd), new Prisma.Decimal(0)).toNumber()).toBe(0);
    // Delivery margin and COD fee stay with Kuwana
    const kept = entries.filter((e) => e.type === 'SHIPPING_FEE' || e.type === 'COD_FEE').reduce((s, e) => s.plus(e.grossUsd), new Prisma.Decimal(0));
    expect(kept.toNumber()).toBe(7);
    const jobs = await prisma.deliveryJob.findMany({ where: { shipment: { orderId } } });
    expect(jobs.every((j) => j.status === 'CANCELLED')).toBe(true);
  });

  it('cancels the order if the deposit never arrives', async () => {
    const res = await place({ ...body(), depositMethod: 'ECOCASH' });
    const id = res.body.data.order.id;
    await prisma.marketOrder.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await marketCheckoutService.expireOverdue()).toBeGreaterThanOrEqual(1);
    const o = await prisma.marketOrder.findUniqueOrThrow({ where: { id } });
    expect([o.status, o.cancelReason]).toEqual(['CANCELLED', 'Delivery fee deposit not paid in time']);
  });
});

describe('Diaspora gifts', () => {
  const recipient = { name: 'Gogo Chiwenga', phone: giftPhone, idNumber: '63-222222-B-63' };
  const address = () => ({ cityId, suburbId, line1: '14 Mukuvisi Close', landmark: 'Opposite the blue church', lat: -17.8001, lng: 31.0402 });

  it('needs a saved address or a typed one, not both', async () => {
    const res = await request(app).post(`${api}/market/checkout/quote`).set(auth(diasporaToken)).send({ items: items([kettleOffer, 1]), fulfilment: { mode: 'DELIVERY', addressId, address: address() } });
    expect(res.status).toBe(422);
  });

  it('a buyer abroad pays by card in USD for a recipient at home, who gets the collection PIN', async () => {
    const body = { items: items([kettleOffer, 1]), fulfilment: { mode: 'DELIVERY', address: address() }, paymentCurrency: 'USD', paymentMethod: 'CARD', recipient };
    const q = await quote(body, diasporaToken);
    expect(q.isGift).toBe(true);
    expect(q.paymentMethods.find((m: { method: string }) => m.method === 'CASH').available).toBe(false);
    expect(q.cod.reasons).toContain('Cash on delivery is only for orders you receive yourself');

    const res = await place(body, diasporaToken);
    expect(res.status).toBe(201);
    const order = res.body.data.order;
    expect(order).toMatchObject({ status: 'CONFIRMED', recipient: { name: 'Gogo Chiwenga', isGift: true } });
    expect(order.deliveryAddress).toMatchObject({ line1: '14 Mukuvisi Close', landmark: 'Opposite the blue church', suburb: `Testsub ${stamp}`, pinned: true });
    const job = await prisma.deliveryJob.findFirstOrThrow({ where: { shipment: { orderId: order.id } } });
    expect([job.dropoffLat, job.dropoffLng, job.recipientPhone]).toEqual([-17.8001, 31.0402, giftPhone]);
    expect(lastSmsTo(giftPhone)).toMatch(new RegExp(`${order.reference} is confirmed. Your collection PIN is \\d{6}`));
    // Not saved to the buyer's address book
    expect((await prisma.marketOrder.findUniqueOrThrow({ where: { id: order.id } })).addressId).toBeNull();
  });
});
