import { z } from 'zod';

const usd = z.number().multipleOf(0.01, 'Use at most 2 decimal places');

export const createOfferSchema = z
  .object({
    productId: z.string().uuid(),
    /** Admin only: create the offer on behalf of a seller (e.g. the 1P retail account) */
    sellerId: z.string().uuid().optional(),
    sellerSku: z.string().trim().max(64).optional(),
    priceUsd: usd.positive().max(1_000_000),
    listPriceUsd: usd.positive().max(1_000_000).optional(),
    shippingFeeUsd: usd.min(0).max(10_000).default(0),
    stockQty: z.number().int().min(0).max(1_000_000).default(0),
    fulfilmentType: z.enum(['PLATFORM_FULFILLED', 'SELLER_FULFILLED']),
    hubId: z.string().uuid().optional(),
    dispatchCityId: z.string().uuid().optional(),
    leadTimeDays: z.number().int().min(0).max(30).optional(),
    /** Store branch holding the stock (required for SELLER_FULFILLED) */
    storeBranchId: z.string().uuid().optional(),
    /** Minutes to pick and pack; defaults to the branch's default */
    prepTimeMins: z.number().int().min(0).max(1440).optional(),
  })
  .refine((v) => v.fulfilmentType !== 'SELLER_FULFILLED' || !!v.storeBranchId, { message: 'Choose the store branch that holds this stock', path: ['storeBranchId'] })
  .refine((v) => v.fulfilmentType !== 'PLATFORM_FULFILLED' || !v.storeBranchId, { message: 'Hub-fulfilled offers are not held at a store branch', path: ['storeBranchId'] })
  .refine((v) => v.fulfilmentType !== 'PLATFORM_FULFILLED' || !!v.hubId, { message: 'Choose the hub that will hold this stock', path: ['hubId'] })
  .refine((v) => v.fulfilmentType !== 'SELLER_FULFILLED' || !v.hubId, { message: 'Seller-fulfilled offers are not stored at a hub', path: ['hubId'] })
  .refine((v) => v.listPriceUsd === undefined || v.listPriceUsd >= v.priceUsd, { message: '"Was" price must be at least the selling price', path: ['listPriceUsd'] });

/** Product, seller, fulfilment type and hub are fixed; list a new offer to change them. */
export const updateOfferSchema = z.object({
  sellerSku: z.string().trim().max(64).nullable().optional(),
  priceUsd: usd.positive().max(1_000_000).optional(),
  listPriceUsd: usd.positive().max(1_000_000).nullable().optional(),
  shippingFeeUsd: usd.min(0).max(10_000).optional(),
  stockQty: z.number().int().min(0).max(1_000_000).optional(),
  dispatchCityId: z.string().uuid().optional(),
  leadTimeDays: z.number().int().min(0).max(30).optional(),
  prepTimeMins: z.number().int().min(0).max(1440).optional(),
  isActive: z.boolean().optional(),
});

export type CreateOfferDto = z.infer<typeof createOfferSchema>;
export type UpdateOfferDto = z.infer<typeof updateOfferSchema>;
