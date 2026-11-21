import { z } from 'zod';
import { operatingHoursSchema } from '../../lib/opening-hours';

const phone = z.string().trim().regex(/^\+?[0-9 ]{9,16}$/, 'Enter a valid phone number');

export const createBranchSchema = z.object({
  name: z.string().trim().min(2).max(80),
  cityId: z.string().uuid(),
  suburbId: z.string().uuid().optional(),
  address: z.string().trim().min(3).max(200),
  landmark: z.string().trim().max(200).optional(),
  /** GPS pin dropped by the store owner — drivers navigate to it */
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  phone: phone.optional(),
  operatingHours: operatingHoursSchema.optional(),
  defaultPrepTimeMins: z.number().int().min(5).max(1440).optional(),
});

export const updateBranchSchema = createBranchSchema
  .partial()
  .extend({
    /** Temporarily stop taking orders */
    isPaused: z.boolean().optional(),
    /** Close the branch; its offers drop out of the Buy Box */
    isActive: z.boolean().optional(),
    suburbId: z.string().uuid().nullable().optional(),
    landmark: z.string().trim().max(200).nullable().optional(),
    phone: phone.nullable().optional(),
  })
  .refine((v) => (v.lat === undefined) === (v.lng === undefined), { message: 'Send lat and lng together', path: ['lat'] });

export type CreateBranchDto = z.infer<typeof createBranchSchema>;
export type UpdateBranchDto = z.infer<typeof updateBranchSchema>;
