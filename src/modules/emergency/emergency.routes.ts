import { Router } from 'express';
import { emergencyController } from './emergency.controller';
import { authenticate, optionalAuthenticate } from '../../middleware/auth.middleware';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import prisma from '../../lib/prisma';
import { successResponse, createdResponse } from '../../lib/response';
import { sendPushToRole } from '../../lib/push';
import { auditLog } from '../../middleware/audit.middleware';
import { logger } from '../../lib/logger';
import { requireAdmin } from '../../middleware/rbac.middleware';
import { validate } from '../../middleware/validate.middleware';
import { createEmergencyContactSchema, updateEmergencyContactSchema } from './emergency.schema';

const router = Router();

/** GET /emergency — Public */
router.get('/', emergencyController.list.bind(emergencyController));

const alertLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  message: { success: false, message: 'Too many SOS alerts. If you are in danger, call 999.' },
});

/**
 * SOS: records the alert and notifies Kuwana admins by push.
 * This does NOT contact public emergency services — the app tells the user to call them.
 */
router.post(
  '/alerts',
  alertLimiter,
  optionalAuthenticate,
  validate(z.object({
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    accuracy: z.number().min(0).max(100000).optional(),
  })),
  auditLog({ action: 'EMERGENCY_ALERT', targetType: 'EmergencyAlert' }),
  async (req, res) => {
    const alert = await prisma.emergencyAlert.create({
      data: { userId: req.user?.sub ?? null, lat: req.body.lat, lng: req.body.lng, accuracy: req.body.accuracy },
      include: { user: { select: { phone: true, profile: { select: { fullName: true } } } } },
    });
    logger.warn('🚨 SOS alert', { alertId: alert.id, userId: alert.userId, lat: alert.lat, lng: alert.lng });
    const who = alert.user?.profile?.fullName ?? 'A user';
    const where = alert.lat != null ? ` at ${alert.lat.toFixed(5)}, ${alert.lng?.toFixed(5)}` : '';
    sendPushToRole('ADMIN', {
      title: '🚨 SOS alert',
      body: `${who}${alert.user?.phone ? ` (${alert.user.phone})` : ''} triggered SOS${where}.`,
      data: { type: 'EMERGENCY_ALERT', alertId: alert.id },
    });
    createdResponse(res, { id: alert.id }, 'Alert received');
  },
);

router.get('/alerts', authenticate, requireAdmin, async (req, res) => {
  const status = req.query.status === 'RESOLVED' ? 'RESOLVED' : req.query.status === 'ALL' ? undefined : 'OPEN';
  const alerts = await prisma.emergencyAlert.findMany({
    where: status ? { status } : {},
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: { user: { select: { email: true, phone: true, profile: { select: { fullName: true } } } } },
  });
  successResponse(res, alerts);
});

router.patch('/alerts/:id/resolve', authenticate, requireAdmin, async (req, res) => {
  const alert = await prisma.emergencyAlert.update({
    where: { id: req.params.id },
    data: { status: 'RESOLVED', resolvedAt: new Date(), resolvedBy: req.user!.sub },
  });
  successResponse(res, alert, 'Alert resolved');
});

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
