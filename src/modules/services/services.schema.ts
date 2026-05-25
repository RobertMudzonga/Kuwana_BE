import { z } from 'zod';

const ServiceCategoryEnum = z.enum(['GOODS', 'FOOD', 'SERVICES', 'DELIVERY', 'EMERGENCY', 'OTHER']);

export const createServiceSchema = z.object({
  title: z.string().min(2).max(200),
  description: z.string().max(1000).optional(),
  price: z.number().positive('Price must be positive'),
  currency: z.string().length(3).default('USD'),
  unit: z.string().max(50).optional(),
  category: ServiceCategoryEnum,
  tags: z.array(z.string().max(30)).max(10).default([]),
  imageUrl: z.string().url().optional(),
});

export const updateServiceSchema = createServiceSchema.partial().extend({
  isActive: z.boolean().optional(),
});

export const serviceQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  category: ServiceCategoryEnum.optional(),
  providerId: z.string().uuid().optional(),
  search: z.string().max(100).optional(),
  minPrice: z.coerce.number().min(0).optional(),
  maxPrice: z.coerce.number().min(0).optional(),
});

export type CreateServiceDto = z.infer<typeof createServiceSchema>;
export type UpdateServiceDto = z.infer<typeof updateServiceSchema>;
