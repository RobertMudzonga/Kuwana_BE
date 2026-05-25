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
  role: z.enum(['USER', 'PROVIDER']).default('USER'),
});

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
