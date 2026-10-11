import { Router } from 'express';
import { paymentsController } from './payments.controller';
import { authenticate } from '../../middleware/auth.middleware';
import { requireAdmin } from '../../middleware/rbac.middleware';
import { validate } from '../../middleware/validate.middleware';
import { auditLog } from '../../middleware/audit.middleware';
import { z } from 'zod';
import express from 'express';
import { zwMobile } from '../auth/auth.schema';

const router = Router();

const initiateSchema = z.object({
  orderId: z.string().uuid(),
  paymentMethod: z.enum(['ECOCASH', 'ONEMONEY', 'CARD', 'CASH']).optional(),
  paymentPhone: zwMobile.optional(),
});

// Stripe webhook — needs the raw body for signature verification
router.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  paymentsController.webhook.bind(paymentsController),
);

// Paynow result URL — form-encoded, verified by hash
router.post(
  '/paynow/result',
  express.urlencoded({ extended: false, limit: '20kb' }),
  paymentsController.paynowResult.bind(paymentsController),
);

router.get('/return', paymentsController.returnPage.bind(paymentsController));

// All routes below require authentication (JSON bodies)
router.use(express.json({ limit: '100kb' }), authenticate);

router.post(
  '/initiate',
  validate(initiateSchema),
  auditLog({ action: 'PAYMENT_INITIATED', targetType: 'Payment' }),
  paymentsController.initiate.bind(paymentsController),
);

router.get('/', paymentsController.listTransactions.bind(paymentsController));

router.get('/:id', paymentsController.getTransaction.bind(paymentsController));

router.post(
  '/:id/refund',
  requireAdmin,
  auditLog({ action: 'PAYMENT_REFUNDED', targetType: 'Payment', targetIdParam: 'id' }),
  paymentsController.refund.bind(paymentsController),
);

export default router;
