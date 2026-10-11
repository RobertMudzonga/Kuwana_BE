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
  refundSchema,
  settingsSchema,
  promoSchema,
} from './admin.schema';
import prisma from '../../lib/prisma';
import { OrderStatus } from '@prisma/client';
import { orderInclude, toOrderDto } from '../../lib/serializers';
import { successResponse, createdResponse, parsePagination, buildPaginationMeta } from '../../lib/response';
import { paymentsService } from '../payments/payments.service';
import { getSettings, updateSettings } from '../settings/settings.service';

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

// ── Orders ──────────────────────────────────────────────
router.get('/orders', async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>);
  const status = Object.values(OrderStatus).includes(req.query.status as OrderStatus) ? (req.query.status as OrderStatus) : undefined;
  const where = status ? { status } : {};
  const [orders, total] = await Promise.all([
    prisma.order.findMany({ where, include: orderInclude, orderBy: { createdAt: 'desc' }, skip, take: limit }),
    prisma.order.count({ where }),
  ]);
  successResponse(res, orders.map(toOrderDto), 'Orders', 200, buildPaginationMeta(total, page, limit));
});

router.post(
  '/orders/:id/refund',
  validate(refundSchema),
  auditLog({ action: 'PAYMENT_REFUNDED', targetType: 'Order', targetIdParam: 'id' }),
  async (req, res) => {
    const result = await paymentsService.refundOrder(req.params.id, {
      amount: req.body.amount,
      reason: req.body.reason,
      actorId: req.user!.sub,
      markRefundedStatus: true,
    });
    const order = await prisma.order.findUniqueOrThrow({ where: { id: req.params.id }, include: orderInclude });
    successResponse(
      res,
      toOrderDto(order),
      result.manual
        ? 'Refund recorded. Pay the customer back manually (Paynow merchant portal or cash).'
        : 'Refund issued',
    );
  },
);

// ── Platform settings ───────────────────────────────────
router.get('/settings', async (_req, res) => {
  successResponse(res, await getSettings());
});

router.patch(
  '/settings',
  validate(settingsSchema),
  auditLog({ action: 'SETTINGS_UPDATED', targetType: 'PlatformSetting' }),
  async (req, res) => {
    successResponse(res, await updateSettings(req.body), 'Settings updated');
  },
);

// ── Promo codes ─────────────────────────────────────────
router.get('/promo-codes', async (_req, res) => {
  successResponse(res, await prisma.promoCode.findMany({ orderBy: { createdAt: 'desc' } }));
});

router.post('/promo-codes', validate(promoSchema), async (req, res) => {
  const promo = await prisma.promoCode.create({
    data: { ...req.body, expiresAt: req.body.expiresAt ? new Date(req.body.expiresAt) : undefined },
  });
  createdResponse(res, promo, 'Promo code created');
});

router.patch('/promo-codes/:id', validate(z.object({ isActive: z.boolean() })), async (req, res) => {
  successResponse(res, await prisma.promoCode.update({ where: { id: req.params.id }, data: { isActive: req.body.isActive } }));
});

export default router;
