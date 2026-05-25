import { Router } from 'express';
import { adminController } from './admin.controller';
import { authenticate } from '../../middleware/auth.middleware';
import { requireAdmin } from '../../middleware/rbac.middleware';
import { validate } from '../../middleware/validate.middleware';
import { auditLog } from '../../middleware/audit.middleware';
import { approvalSchema } from '../providers/providers.schema';
import { z } from 'zod';
import {
  createAdminProviderSchema,
  createAdminServiceSchema,
  createAdminUserSchema,
} from './admin.schema';

const router = Router();

// All admin routes require authentication + ADMIN role
router.use(authenticate, requireAdmin);

/** GET /admin/dashboard */
router.get('/dashboard', adminController.getDashboard.bind(adminController));

/** GET /admin/audit-logs */
router.get('/audit-logs', adminController.getAuditLogs.bind(adminController));

/** GET /admin/users */
router.get('/users', adminController.listUsers.bind(adminController));

/** POST /admin/users */
router.post(
  '/users',
  validate(createAdminUserSchema),
  auditLog({ action: 'USER_CREATED', targetType: 'User' }),
  adminController.createUser.bind(adminController),
);

/** PATCH /admin/users/:id/status */
router.patch(
  '/users/:id/status',
  validate(z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']) })),
  auditLog({ action: 'USER_SUSPENDED', targetType: 'User', targetIdParam: 'id' }),
  adminController.setUserStatus.bind(adminController),
);

/** GET /admin/providers */
router.get('/providers', adminController.listProviders.bind(adminController));

/** POST /admin/providers */
router.post(
  '/providers',
  validate(createAdminProviderSchema),
  auditLog({ action: 'PROVIDER_ONBOARDED', targetType: 'Provider' }),
  adminController.createProvider.bind(adminController),
);

/** POST /admin/services */
router.post(
  '/services',
  validate(createAdminServiceSchema),
  auditLog({ action: 'SERVICE_CREATED', targetType: 'Service' }),
  adminController.createService.bind(adminController),
);

/** PATCH /admin/providers/:id/approval */
router.patch(
  '/providers/:id/approval',
  validate(approvalSchema),
  auditLog({ action: 'PROVIDER_APPROVED', targetType: 'Provider', targetIdParam: 'id' }),
  adminController.setProviderApproval.bind(adminController),
);

/** GET /admin/payments */
router.get('/payments', adminController.listPayments.bind(adminController));

export default router;
