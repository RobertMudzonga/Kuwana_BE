import { Router } from 'express';
import { emergencyController } from './emergency.controller';
import { authenticate } from '../../middleware/auth.middleware';
import { requireAdmin } from '../../middleware/rbac.middleware';
import { validate } from '../../middleware/validate.middleware';
import { createEmergencyContactSchema, updateEmergencyContactSchema } from './emergency.schema';

const router = Router();

/** GET /emergency — Public */
router.get('/', emergencyController.list.bind(emergencyController));

/** POST /emergency — Admin only */
router.post(
  '/',
  authenticate,
  requireAdmin,
  validate(createEmergencyContactSchema),
  emergencyController.create.bind(emergencyController),
);

/** PUT /emergency/:id — Admin only */
router.put(
  '/:id',
  authenticate,
  requireAdmin,
  validate(updateEmergencyContactSchema),
  emergencyController.update.bind(emergencyController),
);

/** DELETE /emergency/:id — Admin only (soft delete) */
router.delete('/:id', authenticate, requireAdmin, emergencyController.delete.bind(emergencyController));

export default router;
