import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../../middleware/auth.middleware';
import { requireAdmin, requireRoles } from '../../middleware/rbac.middleware';
import { validate } from '../../middleware/validate.middleware';
import { auditLog } from '../../middleware/audit.middleware';
import { successResponse } from '../../lib/response';
import { staffContext, StaffContext } from './staff';
import { hubService } from './hub.service';
import { handoverService } from './handover.service';
import { codService } from './cod.service';
import { returnsService } from './returns.service';
import { adminOpsService } from './admin.service';
import {
  hubQueueSchema, hubOnlySchema, dispatchSchema, binSchema, handoverSchema, failSchema, codListSchema, codVerifySchema,
  returnsListSchema, inspectSchema, analyticsSchema, staffSchema,
} from './ops.schema';

/**
 * Operations: hub (pick, pack, dispatch), drivers, pickup agents, COD cash-up, returns, and admin tools.
 * Every handler runs with the caller's staff context (role + assigned hub / pickup point).
 */
const router = Router();
router.use(authenticate, requireRoles('ADMIN', 'WAREHOUSE', 'DRIVER', 'PICKUP_AGENT'));

declare global {
  namespace Express {
    interface Request {
      staff?: StaffContext;
    }
  }
}
router.use(async (req: Request, _res: Response, next: NextFunction) => {
  req.staff = await staffContext(req.user!.sub);
  next();
});

const hubStaff = requireRoles('WAREHOUSE', 'ADMIN');
const audit = (targetType: string) => auditLog({ action: 'SHIPMENT_STATUS_CHANGED', targetType, targetIdParam: 'id' });

/** GET /ops/me — role, hub and pickup point, so the app can show the right tools */
router.get('/me', (req: Request, res: Response) => {
  successResponse(res, req.staff);
});

// ── Hub ───────────────────────────────────────────────────
router.get('/hub/shipments', hubStaff, validate(hubQueueSchema, 'query'), async (req: Request, res: Response) => {
  const q = req.query as unknown as { tab: 'to_pick'; hubId?: string };
  successResponse(res, await hubService.queue(req.staff!, q.tab, q.hubId), 'Hub parcels');
});
router.get('/hub/picklist', hubStaff, validate(hubOnlySchema, 'query'), async (req: Request, res: Response) => {
  successResponse(res, await hubService.pickList(req.staff!, (req.query as { hubId?: string }).hubId), 'Pick list');
});
router.get('/hub/drivers', hubStaff, validate(hubOnlySchema, 'query'), async (req: Request, res: Response) => {
  successResponse(res, await hubService.drivers(req.staff!, (req.query as { hubId?: string }).hubId), 'Drivers');
});
router.post('/hub/shipments/:id/pack', hubStaff, audit('Shipment'), async (req: Request, res: Response) => {
  successResponse(res, await hubService.pack(req.staff!, req.params.id), 'Packed');
});
router.post('/hub/shipments/:id/dispatch', hubStaff, validate(dispatchSchema), audit('Shipment'), async (req: Request, res: Response) => {
  successResponse(res, await hubService.dispatch(req.staff!, req.params.id, req.body), 'Dispatched');
});
router.patch('/hub/offers/:id/bin', hubStaff, validate(binSchema), async (req: Request, res: Response) => {
  successResponse(res, await hubService.setBin(req.staff!, req.params.id, req.body.bin), 'Bin updated');
});

// ── Handover (drivers, agents, hub staff for courier deliveries) ──
router.post('/shipments/:id/handover', validate(handoverSchema), audit('Shipment'), async (req: Request, res: Response) => {
  successResponse(res, await handoverService.handOver(req.staff!, req.params.id, req.body), 'Handed over');
});
router.post('/shipments/:id/fail', requireRoles('DRIVER', 'WAREHOUSE', 'ADMIN'), validate(failSchema), audit('Shipment'), async (req: Request, res: Response) => {
  successResponse(res, await handoverService.fail(req.staff!, req.params.id, req.body), 'Delivery attempt recorded');
});
router.get('/driver/shipments', requireRoles('DRIVER'), async (req: Request, res: Response) => {
  successResponse(res, await handoverService.driverShipments(req.staff!), 'My deliveries');
});
router.get('/pickup/shipments', requireRoles('PICKUP_AGENT'), async (req: Request, res: Response) => {
  successResponse(res, await handoverService.pickupShipments(req.staff!), 'Parcels for this pickup point');
});
router.post('/pickup/shipments/:id/arrived', requireRoles('PICKUP_AGENT', 'WAREHOUSE', 'ADMIN'), audit('Shipment'), async (req: Request, res: Response) => {
  successResponse(res, await handoverService.markArrived(req.staff!, req.params.id), 'Ready for collection');
});

// ── COD cash-up ───────────────────────────────────────────
router.get('/cod', hubStaff, validate(codListSchema, 'query'), async (req: Request, res: Response) => {
  successResponse(res, await codService.list(req.staff!, req.query as never), 'Cash collections');
});
router.post('/cod/verify', hubStaff, validate(codVerifySchema), auditLog({ action: 'COD_VERIFIED', targetType: 'CodRemittance' }), async (req: Request, res: Response) => {
  successResponse(res, await codService.verify(req.staff!, req.body), 'Cash-up recorded');
});

// ── Returns ───────────────────────────────────────────────
const returnAudit = auditLog({ action: 'RETURN_UPDATED', targetType: 'ReturnRequest', targetIdParam: 'id' });
router.get('/returns', requireRoles('PICKUP_AGENT', 'WAREHOUSE', 'ADMIN'), validate(returnsListSchema, 'query'), async (req: Request, res: Response) => {
  successResponse(res, await returnsService.listForStaff(req.staff!, (req.query as { status?: never }).status), 'Returns');
});
router.post('/returns/:id/dropped-off', requireRoles('PICKUP_AGENT', 'WAREHOUSE', 'ADMIN'), returnAudit, async (req: Request, res: Response) => {
  successResponse(res, await returnsService.markDroppedOff(req.staff!, req.params.id), 'Return dropped off');
});
router.post('/returns/:id/received', hubStaff, returnAudit, async (req: Request, res: Response) => {
  successResponse(res, await returnsService.markReceived(req.staff!, req.params.id), 'Return received at hub');
});
router.post('/returns/:id/inspect', hubStaff, validate(inspectSchema), returnAudit, async (req: Request, res: Response) => {
  successResponse(res, await returnsService.inspect(req.staff!, req.params.id, req.body), 'Inspection recorded');
});

// ── Admin ─────────────────────────────────────────────────
router.get('/admin/analytics', requireAdmin, validate(analyticsSchema, 'query'), async (req: Request, res: Response) => {
  successResponse(res, await adminOpsService.analytics((req.query as unknown as { days: number }).days), 'Analytics');
});
router.get('/admin/staff', requireAdmin, async (_req: Request, res: Response) => {
  successResponse(res, await adminOpsService.listStaff(), 'Staff');
});
router.post('/admin/staff', requireAdmin, validate(staffSchema), auditLog({ action: 'STAFF_UPDATED', targetType: 'User' }), async (req: Request, res: Response) => {
  successResponse(res, await adminOpsService.upsertStaff(req.body), 'Staff saved');
});

export default router;
