import { z } from 'zod';
import { zwMobile } from '../auth/auth.schema';

export const checkoutSchema = z.object({
  items: z.array(z.object({
    serviceId: z.string().uuid(),
    quantity: z.number().int().min(1).max(50),
    optionIds: z.array(z.string().uuid()).max(30).default([]),
    notes: z.string().max(200).optional(),
  })).min(1, 'Your cart is empty').max(50),
  fulfilment: z.enum(['DELIVERY', 'COLLECTION']),
  addressId: z.string().uuid().optional(),
  paymentMethod: z.enum(['ECOCASH', 'ONEMONEY', 'CARD', 'CASH']),
  paymentPhone: zwMobile.optional(),
  scheduledFor: z.string().datetime().nullable().optional(),
  promoCode: z.string().max(30).optional(),
  notes: z.string().max(300).optional(),
});

const OrderStatusEnum = z.enum([
  'PENDING_PAYMENT', 'PLACED', 'ACCEPTED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY',
  'DELIVERED', 'COLLECTED', 'CANCELLED', 'REJECTED', 'REFUNDED',
]);

export const updateOrderStatusSchema = z.object({
  status: OrderStatusEnum,
  reason: z.string().max(300).optional(),
});

export const cancelOrderSchema = z.object({
  reason: z.string().max(300).optional(),
});

export const orderQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(50),
  /** Comma-separated statuses */
  status: z.string().optional().transform((s) => s ? s.split(',').map((v) => OrderStatusEnum.parse(v.trim())) : undefined),
  as: z.enum(['buyer', 'seller']).default('buyer'),
});

export type CheckoutDto = z.infer<typeof checkoutSchema>;
export type UpdateOrderStatusDto = z.infer<typeof updateOrderStatusSchema>;
