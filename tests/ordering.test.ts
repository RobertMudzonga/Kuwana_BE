import crypto from 'crypto';
import request from 'supertest';
import { createApp } from '../src/app';
import prisma from '../src/lib/prisma';
import { env } from '../src/config/env';
import { PaynowGateway } from '../src/modules/payments/paynow.gateway';
import { paymentsService, setGatewayForTests } from '../src/modules/payments/payments.service';
import { ordersService } from '../src/modules/orders/orders.service';
import { IPaymentGateway } from '../src/modules/payments/payment.gateway.interface';

const app = createApp();
const api = '/api/v1';
const stamp = Date.now();

let buyerToken: string;
let serviceId: string;
let providerUserId: string;

/** A gateway that never confirms on its own, so tests control the outcome */
const pendingGateway: IPaymentGateway = {
  name: 'MOCK',
  supports: (m) => m !== 'CASH',
  initiatePayment: async (input) => ({ gatewayRef: `pending_${input.paymentId}`, status: 'pending', instructions: 'Approve on your phone' }),
  refund: async () => ({ success: true }),
};

const checkout = (quantity: number, paymentMethod = 'ECOCASH') =>
  request(app).post(`${api}/orders`).set('Authorization', `Bearer ${buyerToken}`).send({
    fulfilment: 'COLLECTION',
    paymentMethod,
    paymentPhone: '+263771112233',
    items: [{ serviceId, quantity, optionIds: [] }],
  });

beforeAll(async () => {
  // A dedicated approved store with one stock-tracked item
  const providerUser = await prisma.user.create({
    data: {
      email: `test_seller_${stamp}@kuwana.test`,
      passwordHash: 'x',
      role: 'PROVIDER',
      profile: { create: { fullName: 'Test Seller' } },
      provider: {
        create: {
          businessName: `Test Store ${stamp}`,
          category: 'FOOD',
          approvalStatus: 'APPROVED',
          offersCollection: true,
          services: { create: { title: 'Test Pie', price: 2.5, category: 'FOOD', stock: 3 } },
        },
      },
    },
    include: { provider: { include: { services: true } } },
  });
  providerUserId = providerUser.id;
  serviceId = providerUser.provider!.services[0].id;

  const res = await request(app).post(`${api}/auth/register`).send({
    email: `test_buyer_${stamp}@kuwana.test`,
    password: 'Buyer@1234',
    fullName: 'Test Buyer',
  });
  buyerToken = res.body.data.accessToken;
  await prisma.user.update({ where: { id: res.body.data.user.id }, data: { phone: `+26371${String(stamp).slice(-7)}`, phoneVerified: true } });
});

afterAll(async () => {
  setGatewayForTests(null);
  const users = await prisma.user.findMany({ where: { email: { endsWith: `${stamp}@kuwana.test` } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  const orders = await prisma.order.findMany({ where: { userId: { in: ids } }, select: { checkoutRef: true } });
  await prisma.payment.deleteMany({ where: { checkoutRef: { in: orders.map((o) => o.checkoutRef) } } });
  await prisma.order.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.$disconnect();
});

describe('Paynow gateway', () => {
  const gateway = new PaynowGateway();
  const sign = (fields: [string, string][]) =>
    crypto.createHash('sha512').update(fields.map(([, v]) => v).join('') + (env.PAYNOW_INTEGRATION_KEY ?? ''), 'utf8').digest('hex').toUpperCase();

  const callback = (status: string, amount = '10.00') => {
    const fields: [string, string][] = [
      ['reference', 'pay-123'],
      ['amount', amount],
      ['paynowreference', '987654'],
      ['pollurl', 'https://www.paynow.co.zw/Interface/CheckPayment/?guid=abc'],
      ['status', status],
    ];
    return Object.fromEntries([...fields, ['hash', sign(fields)]]);
  };

  it('accepts a correctly signed "Paid" result', () => {
    const result = gateway.handleResultCallback(callback('Paid'));
    expect(result).toMatchObject({ paymentId: 'pay-123', status: 'succeeded', amount: 10 });
  });

  it('maps Cancelled to failed and Sent to pending', () => {
    expect(gateway.handleResultCallback(callback('Cancelled'))?.status).toBe('failed');
    expect(gateway.handleResultCallback(callback('Sent'))?.status).toBe('pending');
  });

  it('rejects a tampered callback', () => {
    const forged = { ...callback('Paid'), amount: '0.01' };
    expect(gateway.handleResultCallback(forged)).toBeNull();
  });

  it('refunds are manual', async () => {
    await expect(gateway.refund({ gatewayRef: 'x' })).resolves.toEqual({ success: false, manual: true });
  });
});

describe('Checkout, payment and expiry', () => {
  beforeEach(() => setGatewayForTests(pendingGateway));

  it('reserves stock and waits for payment', async () => {
    const res = await checkout(2);
    expect(res.status).toBe(201);
    expect(res.body.data.payment.status).toBe('PENDING');
    expect(res.body.data.orders[0].status).toBe('PENDING_PAYMENT');
    const service = await prisma.service.findUniqueOrThrow({ where: { id: serviceId } });
    expect(service.stock).toBe(1);

    // Sellers don't see unpaid orders
    const seller = await prisma.provider.findUniqueOrThrow({ where: { userId: providerUserId } });
    const visible = await prisma.order.count({ where: { providerId: seller.id, status: { not: 'PENDING_PAYMENT' } } });
    expect(visible).toBe(0);
  });

  it('refuses to oversell the last units', async () => {
    const res = await checkout(2);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Only 1 × Test Pie left/);
  });

  it('confirms payment idempotently and releases the order', async () => {
    const order = await prisma.order.findFirstOrThrow({ where: { items: { some: { serviceId } } }, orderBy: { createdAt: 'desc' } });
    const payment = await prisma.payment.findFirstOrThrow({ where: { checkoutRef: order.checkoutRef } });
    await paymentsService.markPaid(payment.id, Number(payment.amount));
    await paymentsService.markPaid(payment.id, Number(payment.amount)); // duplicate callback
    const updated = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { statusHistory: true } });
    expect(updated.status).toBe('PLACED');
    expect(updated.paymentStatus).toBe('PAID');
    expect(updated.statusHistory.filter((h) => h.status === 'PLACED')).toHaveLength(1);
  });

  it('does not confirm a payment for the wrong amount', async () => {
    const res = await checkout(1);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: res.body.data.orders[0].id } });
    const payment = await prisma.payment.findFirstOrThrow({ where: { checkoutRef: order.checkoutRef } });
    await paymentsService.markPaid(payment.id, 0.01);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('PENDING_PAYMENT');
  });

  it('expires unpaid checkouts and releases their stock', async () => {
    const before = (await prisma.service.findUniqueOrThrow({ where: { id: serviceId } })).stock!;
    const pending = await prisma.order.findFirstOrThrow({ where: { items: { some: { serviceId } }, status: 'PENDING_PAYMENT' } });
    await prisma.order.update({ where: { id: pending.id }, data: { createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) } });

    await ordersService.expireUnpaidOrders();

    const expired = await prisma.order.findUniqueOrThrow({ where: { id: pending.id } });
    expect(expired.status).toBe('CANCELLED');
    expect(expired.cancelReason).toMatch(/not completed/);
    expect((await prisma.service.findUniqueOrThrow({ where: { id: serviceId } })).stock).toBe(before + 1);
  });

  it('only one of two concurrent checkouts gets the last unit', async () => {
    await prisma.service.update({ where: { id: serviceId }, data: { stock: 1 } });
    const results = await Promise.all([checkout(1, 'CASH'), checkout(1, 'CASH')]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409]);
    expect((await prisma.service.findUniqueOrThrow({ where: { id: serviceId } })).stock).toBe(0);
  });
});
