import { Router, Request, Response } from 'express';
import { authenticate } from '../../middleware/auth.middleware';
import { requireAdmin } from '../../middleware/rbac.middleware';
import { validate } from '../../middleware/validate.middleware';
import { auditLog } from '../../middleware/audit.middleware';
import { successResponse } from '../../lib/response';
import { walletService } from './wallet.service';
import { walletCreditSchema } from './market.schema';

const router = Router();
router.use(authenticate);

/** GET /wallet — the signed-in user's store credit and recent movements */
router.get('/', async (req: Request, res: Response) => {
  successResponse(res, await walletService.summary(req.user!.sub), 'Wallet');
});

/** POST /wallet/credit — Admin: add store credit (goodwill, manual refunds) */
router.post(
  '/credit',
  requireAdmin,
  validate(walletCreditSchema),
  auditLog({ action: 'WALLET_CREDITED', targetType: 'Wallet' }),
  async (req: Request, res: Response) => {
    const { userId, amountUsd, memo } = req.body;
    successResponse(res, await walletService.credit(userId, amountUsd, memo), 'Wallet credited');
  },
);

export default router;
