import { Router } from 'express';
import { providersController } from './providers.controller';
import { authenticate, optionalAuthenticate } from '../../middleware/auth.middleware';
import { requireAdmin, requireProvider } from '../../middleware/rbac.middleware';
import { validate } from '../../middleware/validate.middleware';
import {
  onboardProviderSchema,
  updateProviderSchema,
  nearbyQuerySchema,
  approvalSchema,
  providerListQuerySchema,
} from './providers.schema';
import { auditLog } from '../../middleware/audit.middleware';

const router = Router();

/** GET /providers/nearby — Public geospatial search */
router.get(
  '/nearby',
  optionalAuthenticate,
  validate(nearbyQuerySchema, 'query'),
  providersController.getNearby.bind(providersController),
);

/** POST /providers/onboard — Any authenticated user */
router.post(
  '/onboard',
  authenticate,
  validate(onboardProviderSchema),
  auditLog({ action: 'PROVIDER_ONBOARDED', targetType: 'Provider' }),
  providersController.onboard.bind(providersController),
);

/** GET /providers — Store directory (approved stores; admins may filter by approvalStatus) */
router.get(
  '/',
  optionalAuthenticate,
  validate(providerListQuerySchema, 'query'),
  providersController.listProviders.bind(providersController),
);

/** GET /providers/me — Provider own profile */
router.get('/me', authenticate, requireProvider, providersController.getMe.bind(providersController));

/** GET /providers/me/stats — Seller earnings summary */
router.get('/me/stats', authenticate, requireProvider, providersController.getMyStats.bind(providersController));

/** PUT|PATCH /providers/me — Provider updates own profile and store settings */
const updateMe = [
  authenticate,
  requireProvider,
  validate(updateProviderSchema),
  providersController.updateMe.bind(providersController),
];
router.put('/me', ...updateMe);
router.patch('/me', ...updateMe);

/** GET /providers/:id — Public provider profile */
router.get('/:id', optionalAuthenticate, providersController.getProvider.bind(providersController));

/** PATCH /providers/:id/approval — Admin only */
router.patch(
  '/:id/approval',
  authenticate,
  requireAdmin,
  validate(approvalSchema),
  auditLog({ action: 'PROVIDER_APPROVED', targetType: 'Provider', targetIdParam: 'id' }),
  providersController.setApproval.bind(providersController),
);

export default router;
