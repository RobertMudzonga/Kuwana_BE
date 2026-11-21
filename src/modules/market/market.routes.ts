import { Router, Request, Response } from 'express';
import { authenticate, optionalAuthenticate } from '../../middleware/auth.middleware';
import { requireAdmin } from '../../middleware/rbac.middleware';
import { validate } from '../../middleware/validate.middleware';
import { auditLog } from '../../middleware/audit.middleware';
import { successResponse, createdResponse, buildPaginationMeta, parsePagination } from '../../lib/response';
import { marketCheckoutService } from './checkout.service';
import { getMarketSettings, settingsDto, updateMarketSettings, updateMarketSettingsSchema } from './market.settings';
import { listFeeBands, replaceFeeBands, replaceFeeBandsSchema } from '../delivery/fee-bands.service';
import { quoteSchema, placeOrderSchema, payOrderSchema, codOtpSchema, cancelOrderSchema } from './market.schema';

const router = Router();

/** GET /market/settings — delivery fees, free-delivery threshold, COD limits */
router.get('/settings', async (_req: Request, res: Response) => {
  successResponse(res, settingsDto(await getMarketSettings()), 'Marketplace settings');
});

router.patch(
  '/settings',
  authenticate,
  requireAdmin,
  validate(updateMarketSettingsSchema),
  auditLog({ action: 'SETTINGS_UPDATED', targetType: 'MarketSettings' }),
  async (req: Request, res: Response) => {
    successResponse(res, settingsDto(await updateMarketSettings(req.body)), 'Marketplace settings updated');
  },
);

/** GET /market/delivery-fees — customer fee and driver payout per vehicle class and distance band */
router.get('/delivery-fees', async (_req: Request, res: Response) => {
  successResponse(res, await listFeeBands(), 'Delivery fee bands');
});

/** PUT /market/delivery-fees — admin replaces the whole band table */
router.put(
  '/delivery-fees',
  authenticate,
  requireAdmin,
  validate(replaceFeeBandsSchema),
  auditLog({ action: 'DELIVERY_FEES_UPDATED', targetType: 'DeliveryFeeBand' }),
  async (req: Request, res: Response) => {
    successResponse(res, await replaceFeeBands(req.body), 'Delivery fees updated');
  },
);

/**
 * @openapi
 * /market/checkout/quote:
 *   post:
 *     tags: [Marketplace checkout]
 *     summary: Price a cart — stock checks, shipment split, delivery fees, COD eligibility, payment methods
 *     security: []
 */
router.post('/checkout/quote', optionalAuthenticate, validate(quoteSchema), async (req: Request, res: Response) => {
  successResponse(res, await marketCheckoutService.quote(req.user?.sub ?? null, req.body), 'Quote');
});

/**
 * @openapi
 * /market/orders:
 *   post:
 *     tags: [Marketplace checkout]
 *     summary: Place an order (reserves stock, locks the exchange rate, starts payment or COD confirmation)
 */
router.post(
  '/orders',
  authenticate,
  validate(placeOrderSchema),
  auditLog({ action: 'ORDER_CREATED', targetType: 'MarketOrder' }),
  async (req: Request, res: Response) => {
    createdResponse(res, await marketCheckoutService.placeOrder(req.user!.sub, req.body), 'Order placed');
  },
);

router.get('/orders', authenticate, async (req: Request, res: Response) => {
  const { page, limit } = parsePagination(req.query as Record<string, unknown>, 50);
  const { data, total } = await marketCheckoutService.listOrders(req.user!.sub, page, limit);
  successResponse(res, data, 'Your orders', 200, buildPaginationMeta(total, page, limit));
});

router.get('/orders/:id', authenticate, async (req: Request, res: Response) => {
  successResponse(res, await marketCheckoutService.getOrder(req.user!.sub, req.params.id, req.user!.role));
});

/** POST /market/orders/:id/pay — retry or change the online payment method */
router.post(
  '/orders/:id/pay',
  authenticate,
  validate(payOrderSchema),
  auditLog({ action: 'PAYMENT_INITIATED', targetType: 'MarketOrder', targetIdParam: 'id' }),
  async (req: Request, res: Response) => {
    const { paymentMethod, paymentPhone } = req.body;
    successResponse(res, await marketCheckoutService.payOrder(req.user!.sub, req.params.id, paymentMethod, paymentPhone), 'Payment started');
  },
);

router.post('/orders/:id/cod/verify', authenticate, validate(codOtpSchema), async (req: Request, res: Response) => {
  successResponse(res, await marketCheckoutService.verifyCodOtp(req.user!.sub, req.params.id, req.body.code), 'Order confirmed');
});

router.post('/orders/:id/cod/resend', authenticate, async (req: Request, res: Response) => {
  successResponse(res, await marketCheckoutService.resendCodOtp(req.user!.sub, req.params.id), 'New code sent');
});

router.post(
  '/orders/:id/cancel',
  authenticate,
  validate(cancelOrderSchema),
  auditLog({ action: 'ORDER_CANCELLED', targetType: 'MarketOrder', targetIdParam: 'id' }),
  async (req: Request, res: Response) => {
    successResponse(res, await marketCheckoutService.cancelOrder(req.user!.sub, req.params.id, req.body.reason), 'Order cancelled');
  },
);

export default router;
