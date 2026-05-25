import request from 'supertest';
import { createApp } from '../src/app';

const app = createApp();

describe('GET /api/v1/providers/nearby', () => {
  it('requires lat and lng', async () => {
    const res = await request(app).get('/api/v1/providers/nearby');
    expect(res.status).toBe(422);
  });

  it('rejects out-of-range coordinates', async () => {
    const res = await request(app).get('/api/v1/providers/nearby?lat=999&lng=31.05');
    expect(res.status).toBe(422);
  });

  it('accepts valid coordinates and returns array', async () => {
    // Harare CBD
    const res = await request(app).get('/api/v1/providers/nearby?lat=-17.8292&lng=31.0522&radiusKm=20');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('accepts category filter', async () => {
    const res = await request(app).get(
      '/api/v1/providers/nearby?lat=-17.8292&lng=31.0522&radiusKm=20&category=FOOD',
    );
    expect(res.status).toBe(200);
  });

  it('rejects invalid category', async () => {
    const res = await request(app).get(
      '/api/v1/providers/nearby?lat=-17.8292&lng=31.0522&radiusKm=20&category=INVALID',
    );
    expect(res.status).toBe(422);
  });

  it('respects radius limit of 100km', async () => {
    const res = await request(app).get(
      '/api/v1/providers/nearby?lat=-17.8292&lng=31.0522&radiusKm=999',
    );
    expect(res.status).toBe(422);
  });
});

describe('GET /api/v1/services', () => {
  it('returns paginated services list', async () => {
    const res = await request(app).get('/api/v1/services');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.meta).toBeDefined();
    expect(res.body.meta.page).toBe(1);
  });

  it('supports category filter', async () => {
    const res = await request(app).get('/api/v1/services?category=FOOD');
    expect(res.status).toBe(200);
  });

  it('supports search filter', async () => {
    const res = await request(app).get('/api/v1/services?search=plumbing');
    expect(res.status).toBe(200);
  });
});

describe('GET /api/v1/emergency', () => {
  it('returns emergency contacts without authentication', async () => {
    const res = await request(app).get('/api/v1/emergency');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

describe('Provider onboarding requires auth', () => {
  it('rejects unauthenticated onboarding', async () => {
    const res = await request(app)
      .post('/api/v1/providers/onboard')
      .send({ businessName: 'Test Biz', category: 'GOODS' });
    expect(res.status).toBe(401);
  });
});
