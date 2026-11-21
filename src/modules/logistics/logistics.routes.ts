import { Router, Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../../lib/prisma';
import { validate } from '../../middleware/validate.middleware';
import { successResponse } from '../../lib/response';
import { haversineDistanceKm } from '../../lib/geo';
import { buyBoxService } from '../catalog/buybox.service';
import { pickupLoadToday } from '../control/locations.service';

/** Read-only location reference data for address forms, filters and pickup selection */
const router = Router();

const pickupQuerySchema = z
  .object({
    city: z.string().max(80).optional(),
    /** Sort by distance from the buyer: suburb (id or name) or GPS pin */
    suburb: z.string().max(80).optional(),
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
  })
  .refine((v) => (v.lat === undefined) === (v.lng === undefined), { message: 'Send lat and lng together', path: ['lat'] });

/** GET /logistics/cities — cities (metro first) with their suburbs */
router.get('/cities', async (_req: Request, res: Response) => {
  const cities = await prisma.city.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    include: { suburbs: { where: { isActive: true }, orderBy: { name: 'asc' }, select: { id: true, name: true } } },
  });
  successResponse(
    res,
    cities.map((c) => ({ id: c.id, name: c.name, slug: c.slug, province: c.province, zone: c.zone, codEligible: c.codEligible, lat: c.lat, lng: c.lng, suburbs: c.suburbs })),
    'Cities',
  );
});

/** GET /logistics/hubs */
router.get('/hubs', async (_req: Request, res: Response) => {
  const hubs = await prisma.hub.findMany({
    where: { isActive: true },
    orderBy: { code: 'asc' },
    select: { id: true, code: true, name: true, suburb: true, address: true, lat: true, lng: true, operatingHours: true, city: { select: { id: true, name: true, slug: true } } },
  });
  successResponse(res, hubs, 'Hubs');
});

/** GET /logistics/pickup-points?city=&suburb=&lat=&lng= — nearest first when a location is given */
router.get('/pickup-points', validate(pickupQuerySchema, 'query'), async (req: Request, res: Response) => {
  const q = req.query as { city?: string; suburb?: string; lat?: number; lng?: number };
  const city = q.city;
  const points = await prisma.pickupPoint.findMany({
    where: { isActive: true, ...(city ? { city: { OR: [{ id: city }, { slug: city.toLowerCase() }] } } : {}) },
    orderBy: [{ city: { sortOrder: 'asc' } }, { name: 'asc' }],
    select: {
      id: true, code: true, name: true, type: true, suburb: true, address: true, landmark: true,
      lat: true, lng: true, phone: true, operatingHours: true, maxDailyParcels: true,
      city: { select: { id: true, name: true, slug: true } },
    },
  });
  const load = await pickupLoadToday(points.filter((p) => p.maxDailyParcels).map((p) => p.id));
  const here = city || q.lat !== undefined ? await buyBoxService.resolveLocation(q) : null;
  const withDistance = points.map(({ maxDailyParcels, ...p }) => ({
    ...p,
    /** No room left today (checkout refuses it) */
    isFull: !!maxDailyParcels && (load.get(p.id) ?? 0) >= maxDailyParcels,
    distanceKm: here?.lat != null && here.lng != null && p.lat != null && p.lng != null
      ? Math.round(haversineDistanceKm({ lat: here.lat, lng: here.lng }, { lat: p.lat, lng: p.lng }) * 10) / 10
      : null,
  }));
  if (here?.lat != null) withDistance.sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
  successResponse(res, withDistance, 'Pickup points');
});

export default router;
