import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../../lib/prisma';
import { authenticate } from '../../middleware/auth.middleware';
import { validate } from '../../middleware/validate.middleware';
import { auditLog } from '../../middleware/audit.middleware';
import { successResponse, createdResponse } from '../../lib/response';
import { storeContext, StoreContext } from './store.context';
import { storeOrdersService, StoreTab } from './store-orders.service';
import { storeStaffService, createStaffSchema, updateStaffSchema } from './store-staff.service';

/**
 * Store portal (/store/*): the order queue a store owner or their branch staff work from.
 * New order → accept → pack → "ready for pickup" (driver collects with the PIN). Declining or missing
 * the accept deadline moves the parcel to another store, or refunds the buyer.
 */
const router = Router();
router.use(authenticate);

declare global {
  namespace Express {
    interface Request {
      store?: StoreContext;
    }
  }
}

router.use(async (req: Request, _res: Response, next: NextFunction) => {
  req.store = await storeContext(req.user!);
  next();
});

const listSchema = z.object({
  tab: z.enum(['new', 'preparing', 'ready', 'history']).default('new'),
  branchId: z.string().uuid().optional(),
});
const declineSchema = z.object({ note: z.string().trim().max(300).optional() });

/** GET /store/me — who I am in the portal, my branches and today's queue sizes */
router.get('/me', async (req: Request, res: Response) => {
  const ctx = req.store!;
  const [branches, counts] = await Promise.all([
    prisma.storeBranch.findMany({ where: { id: { in: ctx.branchIds } }, select: { id: true, code: true, name: true, isActive: true, isPaused: true }, orderBy: { name: 'asc' } }),
    storeOrdersService.counts(ctx),
  ]);
  successResponse(res, { storeName: ctx.storeName, kycStatus: ctx.kycStatus, isOwner: ctx.isOwner, branches, counts });
});

router.get('/performance', async (req: Request, res: Response) => {
  successResponse(res, await storeOrdersService.performance(req.store!));
});

router.get('/orders', validate(listSchema, 'query'), async (req: Request, res: Response) => {
  const q = req.query as unknown as { tab: StoreTab; branchId?: string };
  successResponse(res, await storeOrdersService.list(req.store!, q.tab, q.branchId), 'Store orders');
});
router.get('/orders/:id', async (req: Request, res: Response) => {
  successResponse(res, await storeOrdersService.get(req.store!, req.params.id));
});
router.post('/orders/:id/accept', auditLog({ action: 'SHIPMENT_STATUS_CHANGED', targetType: 'Shipment', targetIdParam: 'id' }), async (req: Request, res: Response) => {
  successResponse(res, await storeOrdersService.accept(req.store!, req.params.id), 'Order accepted');
});
router.post('/orders/:id/ready', auditLog({ action: 'SHIPMENT_STATUS_CHANGED', targetType: 'Shipment', targetIdParam: 'id' }), async (req: Request, res: Response) => {
  successResponse(res, await storeOrdersService.ready(req.store!, req.params.id), 'Ready for pickup');
});
router.post('/orders/:id/received-back', auditLog({ action: 'SHIPMENT_STATUS_CHANGED', targetType: 'Shipment', targetIdParam: 'id' }), async (req: Request, res: Response) => {
  successResponse(res, await storeOrdersService.receivedBack(req.store!, req.params.id), 'Parcel back in stock');
});
router.post('/orders/:id/out-of-stock', validate(declineSchema), auditLog({ action: 'SHIPMENT_STATUS_CHANGED', targetType: 'Shipment', targetIdParam: 'id' }), async (req: Request, res: Response) => {
  const result = await storeOrdersService.outOfStock(req.store!, req.params.id, req.body.note);
  successResponse(res, result, result.outcome === 'REASSIGNED' ? 'Moved to another store' : 'Order cancelled and the buyer refunded');
});

// Staff (owner only)
router.get('/staff', async (req: Request, res: Response) => {
  successResponse(res, await storeStaffService.list(req.store!), 'Staff');
});
router.post('/staff', validate(createStaffSchema), auditLog({ action: 'STAFF_UPDATED', targetType: 'User' }), async (req: Request, res: Response) => {
  createdResponse(res, await storeStaffService.create(req.store!, req.body), 'Staff member added');
});
router.patch('/staff/:id', validate(updateStaffSchema), auditLog({ action: 'STAFF_UPDATED', targetType: 'User', targetIdParam: 'id' }), async (req: Request, res: Response) => {
  successResponse(res, await storeStaffService.update(req.store!, req.params.id, req.body), 'Staff member updated');
});

export default router;
