import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth.middleware';
import { requireAdmin } from '../../middleware/rbac.middleware';
import { validate } from '../../middleware/validate.middleware';
import { auditLog } from '../../middleware/audit.middleware';
import { successResponse, createdResponse, buildPaginationMeta, parsePagination } from '../../lib/response';
import { currencyService, ratePayload } from './currency.service';

const router = Router();

export const setRateSchema = z.object({
  /** ZiG per 1 USD */
  rate: z.number().positive().max(1_000_000),
  /** Omit to apply immediately; a future time schedules the change */
  effectiveFrom: z.coerce.date().optional(),
  note: z.string().max(200).optional(),
});

/**
 * @openapi
 * /currency/rate:
 *   get:
 *     tags: [Currency]
 *     summary: Current USD→ZiG exchange rate
 *     security: []
 */
router.get('/rate', async (_req: Request, res: Response) => {
  const rate = await currencyService.getUsdToZwg();
  successResponse(res, ratePayload(rate), rate ? 'Current rate' : 'No exchange rate configured');
});

/** GET /currency/rates — Admin: rate history, newest first, including scheduled rates */
router.get('/rates', authenticate, requireAdmin, async (req: Request, res: Response) => {
  const { page, limit } = parsePagination(req.query as Record<string, unknown>);
  const { data, total } = await currencyService.history(page, limit);
  successResponse(res, data, 'Exchange rate history', 200, buildPaginationMeta(total, page, limit));
});

/** POST /currency/rates — Admin: set a new USD→ZiG rate (immediate or scheduled). Rates are never edited. */
router.post(
  '/rates',
  authenticate,
  requireAdmin,
  validate(setRateSchema),
  auditLog({ action: 'EXCHANGE_RATE_SET', targetType: 'ExchangeRate' }),
  async (req: Request, res: Response) => {
    const body = req.body as z.infer<typeof setRateSchema>;
    const created = await currencyService.setRate({ ...body, adminId: req.user!.sub });
    createdResponse(
      res,
      { id: created.id, rate: created.rate.toNumber(), effectiveFrom: created.effectiveFrom, note: created.note },
      'Exchange rate saved',
    );
  },
);

export default router;
