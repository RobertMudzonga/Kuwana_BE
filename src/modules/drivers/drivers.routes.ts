import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth.middleware';
import { requireAdmin } from '../../middleware/rbac.middleware';
import { validate } from '../../middleware/validate.middleware';
import { auditLog } from '../../middleware/audit.middleware';
import { successResponse, createdResponse } from '../../lib/response';
import {
  driversService, applySchema, statusSchema, depositSchema, withdrawSchema, decideSchema, rejectSchema, adjustSchema, paidSchema, capSchema,
} from './drivers.service';
import { driverJobsService, pickupSchema, deliverSchema, failSchema } from './driver-jobs.service';

/**
 * Gig drivers (/drivers/*): onboarding, online status and location, the collateral float wallet,
 * the nearby job feed and the store-PIN / customer-OTP handover chain. Admin routes under /drivers/admin.
 */
const router = Router();
router.use(authenticate);

// ── Admin ─────────────────────────────────────────────────
const admin = Router();
admin.use(requireAdmin);
admin.get('/', validate(z.object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED']).optional() }), 'query'), async (req: Request, res: Response) => {
  successResponse(res, await driversService.adminList((req.query as { status?: 'PENDING' }).status), 'Drivers');
});
admin.post('/:id/approve', validate(decideSchema), auditLog({ action: 'DRIVER_KYC_UPDATED', targetType: 'DriverProfile', targetIdParam: 'id' }), async (req: Request, res: Response) => {
  successResponse(res, await driversService.decide(req.user!.sub, req.params.id, 'APPROVED', req.body.note, req.body.maxParcelValueUsd), 'Driver approved');
});
admin.post('/:id/reject', validate(rejectSchema), auditLog({ action: 'DRIVER_KYC_UPDATED', targetType: 'DriverProfile', targetIdParam: 'id' }), async (req: Request, res: Response) => {
  successResponse(res, await driversService.decide(req.user!.sub, req.params.id, 'REJECTED', req.body.note), 'Application returned');
});
admin.post('/:id/suspend', validate(rejectSchema), auditLog({ action: 'DRIVER_KYC_UPDATED', targetType: 'DriverProfile', targetIdParam: 'id' }), async (req: Request, res: Response) => {
  successResponse(res, await driversService.decide(req.user!.sub, req.params.id, 'SUSPENDED', req.body.note), 'Driver suspended');
});
admin.post('/:id/wallet/adjust', validate(adjustSchema), auditLog({ action: 'DRIVER_WALLET_UPDATED', targetType: 'DriverProfile', targetIdParam: 'id' }), async (req: Request, res: Response) => {
  successResponse(res, await driversService.adjustFloat(req.user!.sub, req.params.id, req.body), 'Float updated');
});
admin.get('/withdrawals/list', validate(z.object({ status: z.enum(['REQUESTED', 'PAID', 'REJECTED']).default('REQUESTED') }), 'query'), async (req: Request, res: Response) => {
  successResponse(res, await driversService.adminWithdrawals((req.query as { status: 'REQUESTED' }).status), 'Withdrawals');
});
admin.post('/withdrawals/:id/paid', validate(paidSchema), auditLog({ action: 'DRIVER_WALLET_UPDATED', targetType: 'DriverWithdrawal', targetIdParam: 'id' }), async (req: Request, res: Response) => {
  successResponse(res, await driversService.markWithdrawalPaid(req.user!.sub, req.params.id, req.body.externalRef), 'Marked paid');
});
admin.post('/withdrawals/:id/reject', validate(rejectSchema), auditLog({ action: 'DRIVER_WALLET_UPDATED', targetType: 'DriverWithdrawal', targetIdParam: 'id' }), async (req: Request, res: Response) => {
  successResponse(res, await driversService.rejectWithdrawal(req.user!.sub, req.params.id, req.body.note), 'Withdrawal rejected');
});
admin.post('/:id/parcel-cap', validate(capSchema), auditLog({ action: 'DRIVER_KYC_UPDATED', targetType: 'DriverProfile', targetIdParam: 'id' }), async (req: Request, res: Response) => {
  successResponse(res, await driversService.setParcelCap(req.params.id, req.body.maxParcelValueUsd), 'Parcel limit updated');
});
router.use('/admin', admin);

// ── Driver ────────────────────────────────────────────────
router.get('/me', async (req: Request, res: Response) => {
  successResponse(res, await driversService.me(req.user!.sub));
});
router.post('/apply', validate(applySchema), auditLog({ action: 'DRIVER_KYC_UPDATED', targetType: 'DriverProfile' }), async (req: Request, res: Response) => {
  createdResponse(res, await driversService.apply(req.user!.sub, req.body), 'Application received');
});
router.post('/me/status', validate(statusSchema), async (req: Request, res: Response) => {
  successResponse(res, await driversService.setStatus(req.user!.sub, req.body));
});
router.get('/me/wallet', async (req: Request, res: Response) => {
  successResponse(res, await driversService.walletHistory(req.user!.sub));
});
router.post('/me/wallet/deposit', validate(depositSchema), async (req: Request, res: Response) => {
  successResponse(res, await driversService.startDeposit(req.user!.sub, req.body), 'Approve the payment on your phone');
});
router.post('/me/wallet/withdraw', validate(withdrawSchema), auditLog({ action: 'DRIVER_WALLET_UPDATED', targetType: 'DriverWithdrawal' }), async (req: Request, res: Response) => {
  createdResponse(res, await driversService.requestWithdrawal(req.user!.sub, req.body), 'Withdrawal requested');
});

router.get('/jobs/available', async (req: Request, res: Response) => {
  successResponse(res, await driverJobsService.available(req.user!.sub), 'Nearby jobs');
});
router.get('/jobs/mine', async (req: Request, res: Response) => {
  successResponse(res, await driverJobsService.mine(req.user!.sub), 'My jobs');
});
router.get('/jobs/:id', async (req: Request, res: Response) => {
  successResponse(res, await driverJobsService.get(req.user!.sub, req.params.id));
});
router.post('/jobs/:id/claim', async (req: Request, res: Response) => {
  successResponse(res, await driverJobsService.claim(req.user!.sub, req.params.id), 'Job is yours');
});
router.post('/jobs/:id/release', async (req: Request, res: Response) => {
  successResponse(res, await driverJobsService.release(req.user!.sub, req.params.id), 'Job handed back');
});
router.post('/jobs/:id/pickup', validate(pickupSchema), async (req: Request, res: Response) => {
  successResponse(res, await driverJobsService.pickup(req.user!.sub, req.params.id, req.body.pin), 'Collected');
});
router.post('/jobs/:id/deliver', validate(deliverSchema), async (req: Request, res: Response) => {
  successResponse(res, await driverJobsService.deliver(req.user!.sub, req.params.id, req.body), 'Delivered');
});
router.post('/jobs/:id/fail', validate(failSchema), async (req: Request, res: Response) => {
  successResponse(res, await driverJobsService.fail(req.user!.sub, req.params.id, req.body), 'Take the parcel back to the store');
});

export default router;
