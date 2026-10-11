import { z } from 'zod';

const ServiceCategoryEnum = z.enum(['GOODS', 'FOOD', 'SERVICES', 'DELIVERY', 'EMERGENCY', 'OTHER']);

export const onboardProviderSchema = z.object({
  businessName: z.string().min(2).max(150),
  description: z.string().max(1000).optional(),
  category: ServiceCategoryEnum,
  address: z.string().max(200).optional(),
  city: z.string().max(100).optional(),
  phone: z.string().regex(/^\+?[0-9]{7,15}$/).optional(),
  website: z.string().url().optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
});

export const updateProviderSchema = onboardProviderSchema.partial().extend({
  // Store settings
  isOpen: z.boolean().optional(),
  openingHours: z.string().max(200).optional(),
  deliveryFee: z.number().min(0).max(10000).optional(),
  minOrder: z.number().min(0).max(100000).optional(),
  deliveryRadiusKm: z.number().min(0).max(500).optional(),
  estimatedPrepMinutes: z.number().int().min(0).max(1440).optional(),
  offersDelivery: z.boolean().optional(),
  offersCollection: z.boolean().optional(),
}).refine((d) => d.offersDelivery !== false || d.offersCollection !== false, {
  message: 'Offer delivery, collection, or both',
  path: ['offersDelivery'],
});

export const providerListQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  approvalStatus: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED']).optional(),
  category: ServiceCategoryEnum.optional(),
  search: z.string().max(100).optional(),
});

export const nearbyQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radiusKm: z.coerce.number().min(0.5).max(100).default(10),
  category: ServiceCategoryEnum.optional(),
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(50).default(20),
});

export const approvalSchema = z.object({
  status: z.enum(['APPROVED', 'REJECTED', 'SUSPENDED']),
  rejectionNote: z.string().max(500).optional(),
});

export type OnboardProviderDto = z.infer<typeof onboardProviderSchema>;
export type UpdateProviderDto = z.infer<typeof updateProviderSchema>;
export type NearbyQueryDto = z.infer<typeof nearbyQuerySchema>;
export type ApprovalDto = z.infer<typeof approvalSchema>;
