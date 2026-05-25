import { Router } from 'express';
import { paymentsController } from './payments.controller';
import { authenticate } from '../../middleware/auth.middleware';
import { requireAdmin } from '../../middleware/rbac.middleware';
import { validate } from '../../middleware/validate.middleware';
import { auditLog } from '../../middleware/audit.middleware';
import { z } from 'zod';
import express from 'express';

const router = Router();

const initiateSchema = z.object({
  orderId: z.string().uuid(),
});

/**
 * POST /payments/webhook
 * Must use raw body parser — registered BEFORE express.json() in app.ts.
 * Stripe webhook signature verification requires the raw Buffer.
 */
router.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  paymentsController.webhook.bind(paymentsController),
);

// All routes below require authentication
router.use(authenticate);

/** POST /payments/initiate */
router.post(
  '/initiate',
  validate(initiateSchema),
  auditLog({ action: 'PAYMENT_INITIATED', targetType: 'Payment' }),
  paymentsController.initiate.bind(paymentsController),
);

/** GET /payments — own transactions (admin sees all) */
router.get('/', paymentsController.listTransactions.bind(paymentsController));

/** GET /payments/:id */
router.get('/:id', paymentsController.getTransaction.bind(paymentsController));

/** POST /payments/:id/refund — Admin only */
router.post(
  '/:id/refund',
  requireAdmin,
  auditLog({ action: 'PAYMENT_REFUNDED', targetType: 'Payment', targetIdParam: 'id' }),
  paymentsController.refund.bind(paymentsController),
);

export default router;
