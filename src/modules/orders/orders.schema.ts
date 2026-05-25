import { z } from 'zod';

export const createOrderSchema = z.object({
  serviceId: z.string().uuid(),
  quantity: z.number().int().min(1).max(100).default(1),
  notes: z.string().max(500).optional(),
  scheduledAt: z.string().datetime().optional(),
});

export const updateOrderStatusSchema = z.object({
  status: z.enum(['CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']),
});

export const orderQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  status: z.enum(['PENDING','CONFIRMED','IN_PROGRESS','COMPLETED','CANCELLED','DISPUTED']).optional(),
  role: z.enum(['buyer', 'seller']).default('buyer'),
});

export type CreateOrderDto = z.infer<typeof createOrderSchema>;
export type UpdateOrderStatusDto = z.infer<typeof updateOrderStatusSchema>;
