import { z } from 'zod';

const ServiceCategoryEnum = z.enum(['GOODS', 'FOOD', 'SERVICES', 'DELIVERY', 'EMERGENCY', 'OTHER']);

const optionGroupSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(60),
  required: z.boolean().default(false),
  maxSelect: z.number().int().min(1).max(20).default(1),
  options: z.array(z.object({
    id: z.string().uuid().optional(),
    name: z.string().min(1).max(60),
    price: z.number().min(0).max(100000).default(0),
  })).min(1, 'Each option group needs at least one choice').max(30),
}).refine((g) => g.maxSelect <= g.options.length, {
  message: 'maxSelect cannot exceed the number of choices',
  path: ['maxSelect'],
});

const baseServiceSchema = z.object({
  title: z.string().min(2).max(200),
  description: z.string().max(1000).optional(),
  price: z.number().positive('Price must be positive'),
  currency: z.enum(['USD', 'ZWG']).default('USD'),
  unit: z.string().max(50).optional(),
  category: ServiceCategoryEnum,
  tags: z.array(z.string().max(30)).max(10).default([]),
  imageUrl: z.string().url().optional(),
  section: z.string().max(60).optional(),
  /** null = not stock-tracked */
  stock: z.number().int().min(0).max(1_000_000).nullable().optional(),
  isAvailable: z.boolean().optional(),
  optionGroups: z.array(optionGroupSchema).max(10).optional(),
});

export const createServiceSchema = baseServiceSchema;

export const updateServiceSchema = baseServiceSchema.partial().extend({
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
export type OptionGroupDto = z.infer<typeof optionGroupSchema>;
