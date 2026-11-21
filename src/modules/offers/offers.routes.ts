import { Router, Request, Response } from 'express';
import { authenticate } from '../../middleware/auth.middleware';
import { validate } from '../../middleware/validate.middleware';
import { auditLog } from '../../middleware/audit.middleware';
import { successResponse, createdResponse } from '../../lib/response';
import { offersService } from './offers.service';
import { createOfferSchema, updateOfferSchema } from './offers.schema';

/**
 * Offers are a seller's price + stock for a catalog product.
 * Access is by ownership of a seller profile (checked in the service), not by role,
 * so service providers can also sell catalog goods.
 */
const router = Router();
router.use(authenticate);

/** GET /offers/mine — the signed-in seller's offers with Buy Box status */
router.get('/mine', async (req: Request, res: Response) => {
  successResponse(res, await offersService.listMine(req.user!), 'Your offers');
});

/**
 * @openapi
 * /offers:
 *   post:
 *     tags: [Offers]
 *     summary: List an offer against a catalog product (recomputes the Buy Box)
 */
router.post(
  '/',
  validate(createOfferSchema),
  auditLog({ action: 'OFFER_CREATED', targetType: 'Offer' }),
  async (req: Request, res: Response) => {
    createdResponse(res, await offersService.create(req.user!, req.body), 'Offer listed');
  },
);

router.patch(
  '/:id',
  validate(updateOfferSchema),
  auditLog({ action: 'OFFER_UPDATED', targetType: 'Offer', targetIdParam: 'id' }),
  async (req: Request, res: Response) => {
    successResponse(res, await offersService.update(req.user!, req.params.id, req.body), 'Offer updated');
  },
);

router.delete(
  '/:id',
  auditLog({ action: 'OFFER_DELETED', targetType: 'Offer', targetIdParam: 'id' }),
  async (req: Request, res: Response) => {
    await offersService.remove(req.user!, req.params.id);
    successResponse(res, null, 'Offer deactivated');
  },
);

export default router;
