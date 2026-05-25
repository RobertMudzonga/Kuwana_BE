import { Router } from 'express';
import { servicesController } from './services.controller';
import { authenticate, optionalAuthenticate } from '../../middleware/auth.middleware';
import { requireProvider } from '../../middleware/rbac.middleware';
import { validate } from '../../middleware/validate.middleware';
import { createServiceSchema, updateServiceSchema, serviceQuerySchema } from './services.schema';
import { auditLog } from '../../middleware/audit.middleware';

const router = Router();

/** GET /services — Public browsing with filters */
router.get(
  '/',
  optionalAuthenticate,
  validate(serviceQuerySchema, 'query'),
  servicesController.listServices.bind(servicesController),
);

/** GET /services/:id — Public */
router.get('/:id', optionalAuthenticate, servicesController.getService.bind(servicesController));

/** POST /services — Provider creates listing */
router.post(
  '/',
  authenticate,
  requireProvider,
  validate(createServiceSchema),
  auditLog({ action: 'SERVICE_CREATED', targetType: 'Service' }),
  servicesController.create.bind(servicesController),
);

/** PUT /services/:id — Provider updates own listing */
router.put(
  '/:id',
  authenticate,
  requireProvider,
  validate(updateServiceSchema),
  auditLog({ action: 'SERVICE_UPDATED', targetType: 'Service', targetIdParam: 'id' }),
  servicesController.updateService.bind(servicesController),
);

/** DELETE /services/:id — Provider deactivates own listing */
router.delete(
  '/:id',
  authenticate,
  requireProvider,
  auditLog({ action: 'SERVICE_DELETED', targetType: 'Service', targetIdParam: 'id' }),
  servicesController.deleteService.bind(servicesController),
);

export default router;
