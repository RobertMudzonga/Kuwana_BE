import { Router, Request, Response } from 'express';
import { authenticate } from '../../middleware/auth.middleware';
import { validate } from '../../middleware/validate.middleware';
import { auditLog } from '../../middleware/audit.middleware';
import { successResponse, createdResponse } from '../../lib/response';
import { returnsService } from './returns.service';
import { createReturnSchema } from './ops.schema';

/** Buyer side of returns */
const router = Router();
router.use(authenticate);

router.get('/', async (req: Request, res: Response) => {
  successResponse(res, await returnsService.listMine(req.user!.sub), 'Your returns');
});

/** GET /returns/order/:orderId — what can still be returned, and existing returns */
router.get('/order/:orderId', async (req: Request, res: Response) => {
  successResponse(res, await returnsService.forOrder(req.user!.sub, req.params.orderId));
});

router.post('/', validate(createReturnSchema), auditLog({ action: 'RETURN_UPDATED', targetType: 'ReturnRequest' }), async (req: Request, res: Response) => {
  createdResponse(res, await returnsService.create(req.user!.sub, req.body), 'Return approved');
});

router.post('/:id/cancel', async (req: Request, res: Response) => {
  successResponse(res, await returnsService.cancelByBuyer(req.user!.sub, req.params.id), 'Return cancelled');
});

export default router;
