import { z } from 'zod';

export const createEmergencyContactSchema = z.object({
  label: z.string().min(2).max(50),
  phone: z.string().regex(/^\+?[0-9]{3,15}$/),
  category: z.enum(['medical', 'security', 'fire', 'towing', 'other']),
  description: z.string().max(300).optional(),
  city: z.string().max(100).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
});

export const updateEmergencyContactSchema = createEmergencyContactSchema.partial().extend({
  isActive: z.boolean().optional(),
});

export type CreateEmergencyContactDto = z.infer<typeof createEmergencyContactSchema>;
export type UpdateEmergencyContactDto = z.infer<typeof updateEmergencyContactSchema>;
