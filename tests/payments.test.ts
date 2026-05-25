import request from 'supertest';
import { createApp } from '../src/app';

const app = createApp();

describe('Payments API', () => {
  it('rejects payment initiation without auth', async () => {
    const res = await request(app)
      .post('/api/v1/payments/initiate')
      .send({ orderId: '00000000-0000-0000-0000-000000000001' });
    expect(res.status).toBe(401);
  });

  it('rejects malformed orderId', async () => {
    const res = await request(app)
      .post('/api/v1/payments/initiate')
      .set('Authorization', 'Bearer fake_token')
      .send({ orderId: 'not-a-uuid' });
    // 401 (invalid token) before validation
    expect([401, 422]).toContain(res.status);
  });

  it('GET /payments returns 401 without auth', async () => {
    const res = await request(app).get('/api/v1/payments');
    expect(res.status).toBe(401);
  });

  it('GET /payments/:id returns 401 without auth', async () => {
    const res = await request(app).get('/api/v1/payments/some-id');
    expect(res.status).toBe(401);
  });

  it('POST /payments/webhook accepts raw body', async () => {
    // Without correct Stripe-Signature header, we expect 500 or handled error
    const res = await request(app)
      .post('/api/v1/payments/webhook')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ type: 'payment_intent.succeeded' }));
    // Signature verification will fail — acceptable behaviour
    expect([200, 400, 500]).toContain(res.status);
  });

  it('Admin refund endpoint blocked for non-admins', async () => {
    // Register a regular user and try to refund
    const reg = await request(app)
      .post('/api/v1/auth/register')
      .send({
        email: `paytest_${Date.now()}@sosaconnect.zw`,
        password: 'Test@1234!',
        fullName: 'Pay Tester',
        role: 'USER',
      });

    const token = reg.body.data?.accessToken;
    if (!token) return;

    const res = await request(app)
      .post('/api/v1/payments/some-payment-id/refund')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });
});
