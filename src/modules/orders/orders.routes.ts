import { Router } from 'express';
import { ordersController } from './orders.controller';
import { authenticate } from '../../middleware/auth.middleware';
import { validate } from '../../middleware/validate.middleware';
import { createOrderSchema, updateOrderStatusSchema, orderQuerySchema } from './orders.schema';
import { auditLog } from '../../middleware/audit.middleware';

const router = Router();

router.use(authenticate);

router.get('/', validate(orderQuerySchema, 'query'), ordersController.listOrders.bind(ordersController));

router.post(
  '/',
  validate(createOrderSchema),
  auditLog({ action: 'ORDER_CREATED', targetType: 'Order' }),
  ordersController.create.bind(ordersController),
);

router.get('/:id', ordersController.getOrder.bind(ordersController));

router.patch(
  '/:id/status',
  validate(updateOrderStatusSchema),
  auditLog({ action: 'ORDER_STATUS_CHANGED', targetType: 'Order', targetIdParam: 'id' }),
  ordersController.updateStatus.bind(ordersController),
);

export default router;
