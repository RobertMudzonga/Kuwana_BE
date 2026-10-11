import { z } from 'zod';
import { createServiceSchema } from '../services/services.schema';

export const createAdminUserSchema = z.object({
  email: z.string().email('Invalid email address'),
  phone: z.string().regex(/^\+?[0-9]{7,15}$/, 'Invalid phone number').optional(),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .regex(/[A-Z]/, 'Must contain an uppercase letter')
    .regex(/[0-9]/, 'Must contain a number'),
  fullName: z.string().min(2, 'Full name is required').max(100),
  role: z.enum(['USER', 'PROVIDER', 'DRIVER']).default('USER'),
});

export const refundSchema = z.object({
  amount: z.number().positive().optional(),
  reason: z.string().min(3).max(300),
});

export const settingsSchema = z.object({
  commissionPercent: z.number().min(0).max(100).optional(),
  serviceFee: z.number().min(0).max(1000).optional(),
  taxPercent: z.number().min(0).max(100).optional(),
  currency: z.enum(['USD', 'ZWG']).optional(),
});

export const promoSchema = z.object({
  code: z.string().min(3).max(30).transform((c) => c.toUpperCase()),
  type: z.enum(['PERCENT', 'FIXED']),
  value: z.number().positive(),
  minSubtotal: z.number().min(0).default(0),
  maxUses: z.number().int().positive().optional(),
  expiresAt: z.string().datetime().optional(),
  isActive: z.boolean().default(true),
}).refine((p) => p.type !== 'PERCENT' || p.value <= 100, { message: 'A percentage cannot exceed 100', path: ['value'] });

export const createAdminProviderSchema = z.object({
  email: z.string().email('Invalid email address'),
  phone: z.string().regex(/^\+?[0-9]{7,15}$/, 'Invalid phone number').optional(),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .regex(/[A-Z]/, 'Must contain an uppercase letter')
    .regex(/[0-9]/, 'Must contain a number'),
  fullName: z.string().min(2, 'Full name is required').max(100),
  businessName: z.string().min(2, 'Business name is required'),
  description: z.string().max(1000).optional(),
  category: z.enum(['GOODS', 'FOOD', 'SERVICES', 'DELIVERY', 'EMERGENCY', 'OTHER']),
  address: z.string().optional(),
  city: z.string().optional(),
  website: z.string().url('Invalid website URL').optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
});

export const createAdminServiceSchema = createServiceSchema.extend({
  providerId: z.string().uuid('Invalid provider ID'),
});
