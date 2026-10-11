import { Router } from 'express';
import { ordersController } from './orders.controller';
import { authenticate, requireActiveUser } from '../../middleware/auth.middleware';
import { validate } from '../../middleware/validate.middleware';
import { checkoutSchema, updateOrderStatusSchema, orderQuerySchema, cancelOrderSchema } from './orders.schema';
import { auditLog } from '../../middleware/audit.middleware';

const router = Router();

router.use(authenticate);

router.get('/', validate(orderQuerySchema, 'query'), ordersController.listOrders.bind(ordersController));

router.post('/quote', validate(checkoutSchema), ordersController.quote.bind(ordersController));

router.post(
  '/',
  requireActiveUser,
  validate(checkoutSchema),
  auditLog({ action: 'ORDER_CREATED', targetType: 'Order' }),
  ordersController.create.bind(ordersController),
);

router.get('/:id', ordersController.getOrder.bind(ordersController));

router.post(
  '/:id/cancel',
  validate(cancelOrderSchema),
  auditLog({ action: 'ORDER_CANCELLED', targetType: 'Order', targetIdParam: 'id' }),
  ordersController.cancel.bind(ordersController),
);

router.patch(
  '/:id/status',
  validate(updateOrderStatusSchema),
  auditLog({ action: 'ORDER_STATUS_CHANGED', targetType: 'Order', targetIdParam: 'id' }),
  ordersController.updateStatus.bind(ordersController),
);

export default router;
