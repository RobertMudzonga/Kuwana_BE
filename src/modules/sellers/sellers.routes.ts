import { Router, Request, Response } from 'express';
import { authenticate } from '../../middleware/auth.middleware';
import { requireAdmin } from '../../middleware/rbac.middleware';
import { validate } from '../../middleware/validate.middleware';
import { auditLog } from '../../middleware/audit.middleware';
import { successResponse, createdResponse, buildPaginationMeta } from '../../lib/response';
import { sellersService } from './sellers.service';
import { onboardSellerSchema, updateSellerSchema, sellerKycSchema, sellerListQuerySchema } from './sellers.schema';

const router = Router();

/**
 * @openapi
 * /sellers/onboard:
 *   post:
 *     tags: [Sellers]
 *     summary: Create a marketplace seller account (starts PENDING until an admin approves KYC)
 */
router.post(
  '/onboard',
  authenticate,
  validate(onboardSellerSchema),
  auditLog({ action: 'SELLER_ONBOARDED', targetType: 'SellerProfile' }),
  async (req: Request, res: Response) => {
    createdResponse(res, await sellersService.onboard(req.user!.sub, req.body), 'Seller account created — pending verification');
  },
);

router.get('/me', authenticate, async (req: Request, res: Response) => {
  successResponse(res, await sellersService.me(req.user!.sub));
});

router.patch('/me', authenticate, validate(updateSellerSchema), async (req: Request, res: Response) => {
  successResponse(res, await sellersService.updateMe(req.user!.sub, req.body), 'Seller account updated');
});

/** GET /sellers — Admin: list sellers, filter by KYC status */
router.get('/', authenticate, requireAdmin, validate(sellerListQuerySchema, 'query'), async (req: Request, res: Response) => {
  const q = req.query as unknown as { status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'SUSPENDED'; page: number; limit: number };
  const { data, total } = await sellersService.list(q.status, q.page, q.limit);
  successResponse(res, data, 'Sellers', 200, buildPaginationMeta(total, q.page, q.limit));
});

/** PATCH /sellers/:id/kyc — Admin: approve, reject or suspend a seller */
router.patch(
  '/:id/kyc',
  authenticate,
  requireAdmin,
  validate(sellerKycSchema),
  auditLog({ action: 'SELLER_KYC_UPDATED', targetType: 'SellerProfile', targetIdParam: 'id' }),
  async (req: Request, res: Response) => {
    const { status, note } = req.body;
    successResponse(res, await sellersService.setKycStatus(req.params.id, status, req.user!.sub, note), `Seller ${status.toLowerCase()}`);
  },
);

/** GET /sellers/:slug — Public storefront summary (approved sellers only) */
router.get('/:slug', async (req: Request, res: Response) => {
  successResponse(res, await sellersService.publicProfile(req.params.slug));
});

export default router;
