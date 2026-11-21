import { z } from 'zod';

const zwPhone = z.string().regex(/^\+?[0-9 ]{9,16}$/, 'Enter a valid phone number');

const payoutDetails = z.record(z.string().max(40), z.string().max(120)).refine((v) => Object.keys(v).length <= 12);

export const onboardSellerSchema = z
  .object({
    businessName: z.string().trim().min(2).max(120),
    description: z.string().max(1000).optional(),
    kycTier: z.enum(['INFORMAL', 'REGISTERED']),
    /** ZIMRA BP number; required for REGISTERED sellers */
    taxNumber: z.string().trim().max(40).optional(),
    /** Required for INFORMAL traders */
    nationalId: z.string().trim().max(30).optional(),
    phone: zwPhone,
    cityId: z.string().uuid(),
    logoUrl: z.string().url().optional(),
  })
  .refine((v) => v.kycTier !== 'REGISTERED' || !!v.taxNumber, { message: 'ZIMRA BP number is required for registered businesses', path: ['taxNumber'] })
  .refine((v) => v.kycTier !== 'INFORMAL' || !!v.nationalId, { message: 'National ID is required for informal traders', path: ['nationalId'] });

export const updateSellerSchema = z.object({
  description: z.string().max(1000).optional(),
  phone: zwPhone.optional(),
  cityId: z.string().uuid().optional(),
  logoUrl: z.string().url().optional(),
  leadTimeDays: z.number().int().min(0).max(30).optional(),
  usdPayoutDetails: payoutDetails.optional(),
  zigPayoutDetails: payoutDetails.optional(),
});

export const sellerKycSchema = z.object({
  status: z.enum(['APPROVED', 'REJECTED', 'SUSPENDED']),
  note: z.string().max(500).optional(),
});

export const sellerListQuerySchema = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type OnboardSellerDto = z.infer<typeof onboardSellerSchema>;
export type UpdateSellerDto = z.infer<typeof updateSellerSchema>;
