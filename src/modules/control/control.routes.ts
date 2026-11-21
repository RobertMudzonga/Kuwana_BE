import { Router, Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../../lib/prisma';
import { authenticate } from '../../middleware/auth.middleware';
import { requireAdmin } from '../../middleware/rbac.middleware';
import { validate } from '../../middleware/validate.middleware';
import { auditLog } from '../../middleware/audit.middleware';
import { successResponse, createdResponse } from '../../lib/response';
import { storeOrdersService } from '../store/store-orders.service';
import { driverJobsService } from '../drivers/driver-jobs.service';
import {
  locationsService, citySchema, cityUpdateSchema, suburbSchema, suburbUpdateSchema, zoneSchema, zoneUpdateSchema,
  assignZoneSchema, matrixSchema, pickupPointSchema, pickupPointUpdateSchema,
} from './locations.service';
import { dispatchService, reassignSchema, cancelSchema } from './dispatch.service';
import { disputesService, resolveSchema, holdSchema } from './disputes.service';
import { storesKycService } from './stores-kyc.service';

/**
 * Admin control tower (/control/*): locations and zone pricing, pickup points, store KYC review,
 * live dispatch overrides, disputes and payout holds. Admin only; every write is audited.
 */
const router = Router();
router.use(authenticate, requireAdmin);

const loc = auditLog({ action: 'LOCATION_UPDATED', targetType: 'City' });
const zonePricing = auditLog({ action: 'ZONE_PRICING_UPDATED', targetType: 'City', targetIdParam: 'id' });
const pickupAudit = auditLog({ action: 'PICKUP_POINT_UPDATED', targetType: 'PickupPoint' });
const dispatchAudit = auditLog({ action: 'DISPATCH_OVERRIDE', targetType: 'Shipment', targetIdParam: 'id' });

// ── Locations & zones ──
router.get('/cities', async (_req: Request, res: Response) => successResponse(res, await locationsService.listCities(), 'Towns'));
router.post('/cities', validate(citySchema), loc, async (req: Request, res: Response) => createdResponse(res, await locationsService.createCity(req.body), 'Town added'));
router.patch('/cities/:id', validate(cityUpdateSchema), loc, async (req: Request, res: Response) => successResponse(res, await locationsService.updateCity(req.params.id, req.body), 'Town updated'));
router.post('/cities/:id/suburbs', validate(suburbSchema), loc, async (req: Request, res: Response) => createdResponse(res, await locationsService.createSuburb(req.params.id, req.body), 'Suburb added'));
router.patch('/suburbs/:id', validate(suburbUpdateSchema), loc, async (req: Request, res: Response) => successResponse(res, await locationsService.updateSuburb(req.params.id, req.body), 'Suburb updated'));
router.post('/cities/:id/zones', validate(zoneSchema), loc, async (req: Request, res: Response) => createdResponse(res, await locationsService.createZone(req.params.id, req.body), 'Zone added'));
router.patch('/zones/:id', validate(zoneUpdateSchema), loc, async (req: Request, res: Response) => successResponse(res, await locationsService.updateZone(req.params.id, req.body), 'Zone updated'));
router.delete('/zones/:id', loc, async (req: Request, res: Response) => successResponse(res, await locationsService.deleteZone(req.params.id), 'Zone deleted'));
router.post('/cities/:id/assign-zone', validate(assignZoneSchema), loc, async (req: Request, res: Response) => successResponse(res, await locationsService.assignZone(req.params.id, req.body), 'Suburbs updated'));
router.get('/cities/:id/zone-pricing', async (req: Request, res: Response) => successResponse(res, await locationsService.getMatrix(req.params.id), 'Zone pricing'));
router.put('/cities/:id/zone-pricing', validate(matrixSchema), zonePricing, async (req: Request, res: Response) => successResponse(res, await locationsService.replaceMatrix(req.params.id, req.body), 'Zone pricing saved'));

// ── Pickup points ──
router.get('/pickup-points', async (_req: Request, res: Response) => successResponse(res, await locationsService.listPickupPoints(), 'Pickup points'));
router.post('/pickup-points', validate(pickupPointSchema), pickupAudit, async (req: Request, res: Response) => createdResponse(res, await locationsService.savePickupPoint(null, req.body), 'Pickup point added'));
router.patch('/pickup-points/:id', validate(pickupPointUpdateSchema), pickupAudit, async (req: Request, res: Response) => successResponse(res, await locationsService.savePickupPoint(req.params.id, req.body), 'Pickup point updated'));

// ── Store KYC ──
router.get('/stores/:id/kyc', async (req: Request, res: Response) => successResponse(res, await storesKycService.packet(req.params.id)));
router.post('/branches/:id/verify-location', validate(z.object({ verified: z.boolean() })), auditLog({ action: 'SELLER_KYC_UPDATED', targetType: 'StoreBranch', targetIdParam: 'id' }), async (req: Request, res: Response) => {
  successResponse(res, await storesKycService.verifyBranchLocation(req.params.id, req.body.verified), req.body.verified ? 'Pin verified' : 'Pin unverified');
});

// ── Live dispatch ──
router.get('/dispatch', async (_req: Request, res: Response) => successResponse(res, await dispatchService.board(), 'Dispatch'));
router.get('/dispatch/:id/candidates', async (req: Request, res: Response) => successResponse(res, await dispatchService.candidates(req.params.id)));
router.post('/dispatch/:id/reassign', validate(reassignSchema), dispatchAudit, async (req: Request, res: Response) => {
  successResponse(res, await storeOrdersService.adminReassign(req.params.id, req.user!.sub, req.body), 'Parcel moved');
});
router.post('/dispatch/:id/cancel', validate(cancelSchema), dispatchAudit, async (req: Request, res: Response) => {
  successResponse(res, await storeOrdersService.adminCancel(req.params.id, req.user!.sub, req.body.reason), 'Parcel cancelled');
});
router.post('/dispatch/:id/release-driver', validate(cancelSchema), dispatchAudit, async (req: Request, res: Response) => {
  const sh = await prisma.shipment.findUniqueOrThrow({ where: { id: req.params.id }, select: { deliveryJob: { select: { id: true } } } });
  if (!sh.deliveryJob) return successResponse(res, null, 'No delivery job on this parcel', 400);
  successResponse(res, await driverJobsService.adminRelease(sh.deliveryJob.id, req.body.reason), 'Driver released');
});

// ── Disputes & holds ──
router.get('/disputes', validate(z.object({ status: z.enum(['OPEN', 'APPROVED', 'DROPPED_OFF', 'RECEIVED', 'REFUNDED', 'REJECTED', 'CANCELLED']).optional() }), 'query'), async (req: Request, res: Response) => {
  successResponse(res, await disputesService.list((req.query as { status?: 'OPEN' }).status), 'Disputes');
});
router.post('/disputes/:id/resolve', validate(resolveSchema), auditLog({ action: 'DISPUTE_RESOLVED', targetType: 'ReturnRequest', targetIdParam: 'id' }), async (req: Request, res: Response) => {
  successResponse(res, await disputesService.resolve(req.user!.sub, req.params.id, req.body), 'Dispute settled');
});
router.post('/orders/:id/payout-hold', validate(holdSchema), auditLog({ action: 'PAYOUT_HOLD_UPDATED', targetType: 'MarketOrder', targetIdParam: 'id' }), async (req: Request, res: Response) => {
  successResponse(res, await disputesService.holdOrder(req.params.id, req.body.reason), req.body.reason ? 'Escrow frozen' : 'Escrow released');
});
router.post('/stores/:id/payout-hold', validate(holdSchema), auditLog({ action: 'PAYOUT_HOLD_UPDATED', targetType: 'SellerProfile', targetIdParam: 'id' }), async (req: Request, res: Response) => {
  successResponse(res, await disputesService.holdSeller(req.params.id, req.body.reason), req.body.reason ? 'Payouts frozen' : 'Payouts released');
});

// ── Catalog: likely duplicates of a product (title similarity) ──
router.get('/products/:id/similar', async (req: Request, res: Response) => {
  const rows = await prisma.$queryRaw<{ id: string; slug: string; title: string; status: string; offer_count: number; score: number }[]>`
    SELECT p.id, p.slug, p.title, p.status::text AS status, p.offer_count, similarity(p.title, src.title) AS score
    FROM products p, products src
    WHERE src.id = ${req.params.id} AND p.id <> src.id AND p.merged_into_id IS NULL AND p.status <> 'ARCHIVED'
      AND similarity(p.title, src.title) > 0.3
    ORDER BY score DESC LIMIT 10`;
  successResponse(res, rows.map((r) => ({ id: r.id, slug: r.slug, title: r.title, status: r.status, offerCount: r.offer_count, similarity: Math.round(Number(r.score) * 100) / 100 })));
});

export default router;
