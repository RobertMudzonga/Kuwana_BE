import { z } from 'zod';

const csv = z
  .union([z.string(), z.array(z.string())])
  .transform((v) => (Array.isArray(v) ? v : v.split(',')).map((s) => s.trim()).filter(Boolean))
  .pipe(z.array(z.string().max(80)).max(20));

const boolish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

/** Buyer location: city (id or slug), optional suburb (id or name) and optional GPS pin */
const locationFields = {
  city: z.string().max(80).optional(),
  suburb: z.string().max(80).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
};
const latLngTogether = (v: { lat?: number; lng?: number }) => (v.lat === undefined) === (v.lng === undefined);
const latLngMessage = { message: 'Send lat and lng together', path: ['lat'] };

export const productSearchSchema = z
  .object({
    q: z.string().trim().max(100).optional(),
    /** Category slug; includes all sub-categories */
    category: z.string().max(80).optional(),
    /** Brand slugs, comma-separated */
    brand: csv.optional(),
    /** Price bounds, in `currency` */
    minPrice: z.coerce.number().min(0).optional(),
    maxPrice: z.coerce.number().min(0).optional(),
    currency: z.enum(['USD', 'ZWG']).default('USD'),
    /** With a location: only products a store can deliver there, ranked for that buyer */
    ...locationFields,
    fulfilment: z.enum(['PLATFORM_FULFILLED', 'SELLER_FULFILLED']).optional(),
    inStock: boolish.optional(),
    sort: z.enum(['relevance', 'price_asc', 'price_desc', 'newest', 'rating']).default('relevance'),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(60).default(20),
  })
  .refine((v) => v.minPrice === undefined || v.maxPrice === undefined || v.minPrice <= v.maxPrice, {
    message: 'minPrice cannot exceed maxPrice',
    path: ['minPrice'],
  })
  .refine(latLngTogether, latLngMessage);

/** Admin catalog list: every status, simple text match on title / SKU */
export const adminProductListSchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

/** Buyer location; ranks store offers by open-now, distance and delivered price */
export const productDetailQuerySchema = z.object(locationFields).refine(latLngTogether, latLngMessage);

const imageSchema = z.object({
  url: z.string().url(),
  thumbUrl: z.string().url().optional(),
  alt: z.string().max(200).optional(),
});

const specificationsSchema = z
  .record(z.string().max(60), z.union([z.string().max(300), z.number(), z.boolean()]))
  .refine((v) => Object.keys(v).length <= 60, 'At most 60 specification rows');

const productBase = z.object({
  sku: z.string().trim().min(2).max(64).regex(/^[A-Za-z0-9._-]+$/, 'SKU may only contain letters, numbers, . _ -'),
  title: z.string().trim().min(2).max(200),
  description: z.string().max(5000).optional(),
  brandId: z.string().uuid().nullable().optional(),
  categoryId: z.string().uuid(),
  specifications: specificationsSchema.default({}),
  status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']).default('ACTIVE'),
  weightKg: z.number().positive().max(10_000).optional(),
  /** Overrides the category's vehicle class; null = inherit */
  requiredVehicleClass: z.enum(['BIKE', 'CAR', 'BAKKIE']).nullable().optional(),
  images: z.array(imageSchema).max(12).optional(),
});

export const createProductSchema = productBase;
export const updateProductSchema = productBase.partial();

export const createCategorySchema = z.object({
  name: z.string().trim().min(2).max(80),
  slug: z.string().trim().min(2).max(80).regex(/^[a-z0-9-]+$/).optional(),
  parentId: z.string().uuid().nullable().optional(),
  commissionRate: z.number().min(0).max(100).default(10),
  fulfilmentFeeUsd: z.number().min(0).max(10_000).default(0),
  /** Smallest vehicle that can carry this category's items */
  requiredVehicleClass: z.enum(['BIKE', 'CAR', 'BAKKIE']).default('BIKE'),
  /** Off: only wrong or damaged deliveries can be returned */
  isReturnable: z.boolean().default(true),
  icon: z.string().max(40).optional(),
  imageUrl: z.string().url().optional(),
  sortOrder: z.number().int().default(0),
  isActive: z.boolean().default(true),
});
export const updateCategorySchema = createCategorySchema.partial();

export const createBrandSchema = z.object({
  name: z.string().trim().min(1).max(80),
  logoUrl: z.string().url().optional(),
});

export type ProductSearchDto = z.infer<typeof productSearchSchema>;
export type CreateProductDto = z.infer<typeof createProductSchema>;
export type UpdateProductDto = z.infer<typeof updateProductSchema>;
export type CreateCategoryDto = z.infer<typeof createCategorySchema>;
export type UpdateCategoryDto = z.infer<typeof updateCategorySchema>;

// ── Seller product requests ─────────────────────────────

export const createProductRequestSchema = z.object({
  title: z.string().trim().min(3).max(200),
  brandName: z.string().trim().min(1).max(80).optional(),
  categoryId: z.string().uuid().optional(),
  description: z.string().trim().max(5000).optional(),
  barcode: z.string().trim().regex(/^[0-9]{8,14}$/, 'Barcode should be the 8–14 digits under the bars').optional(),
  referenceUrl: z.string().trim().url().max(500).optional(),
  images: z.array(z.object({ url: z.string().url(), alt: z.string().max(200).optional() })).min(1, 'Add at least one photo').max(8),
  specifications: specificationsSchema.default({}),
  weightKg: z.number().positive().max(10_000).optional(),
  note: z.string().trim().max(1000).optional(),
});

export const productRequestListSchema = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'DUPLICATE', 'REJECTED', 'CANCELLED']).optional(),
});

/** Approve = create the catalog product from the (admin-edited) request */
export const approveProductRequestSchema = productBase.extend({
  reviewNote: z.string().trim().max(1000).optional(),
});

export const linkProductRequestSchema = z.object({
  productId: z.string().uuid(),
  reviewNote: z.string().trim().max(1000).optional(),
});

export const rejectProductRequestSchema = z.object({
  reviewNote: z.string().trim().min(3, 'Tell the seller why').max(1000),
});

export type CreateProductRequestDto = z.infer<typeof createProductRequestSchema>;
export type ApproveProductRequestDto = z.infer<typeof approveProductRequestSchema>;

export const mergeProductSchema = z.object({ intoProductId: z.string().uuid(), note: z.string().trim().max(300).optional() });
