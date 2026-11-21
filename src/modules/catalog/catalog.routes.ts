import { Router, Request, Response } from 'express';
import { authenticate, optionalAuthenticate } from '../../middleware/auth.middleware';
import { requireAdmin } from '../../middleware/rbac.middleware';
import { validate } from '../../middleware/validate.middleware';
import { auditLog } from '../../middleware/audit.middleware';
import { successResponse, createdResponse, buildPaginationMeta } from '../../lib/response';
import { catalogService } from './catalog.service';
import {
  productSearchSchema,
  productDetailQuerySchema,
  createProductSchema,
  updateProductSchema,
  createCategorySchema,
  updateCategorySchema,
  mergeProductSchema,
  createBrandSchema,
  adminProductListSchema,
  productRequestListSchema,
  approveProductRequestSchema,
  linkProductRequestSchema,
  rejectProductRequestSchema,
  ProductSearchDto,
} from './catalog.schema';
import { productRequestsService } from './requests.service';

const router = Router();

/**
 * @openapi
 * /catalog/categories:
 *   get:
 *     tags: [Catalog]
 *     summary: Category tree with active product counts
 *     security: []
 */
router.get('/categories', async (_req: Request, res: Response) => {
  successResponse(res, await catalogService.categoryTree(), 'Categories');
});

/** GET /catalog/categories/:slug — one category with breadcrumb and sub-categories */
router.get('/categories/:slug', async (req: Request, res: Response) => {
  successResponse(res, await catalogService.getCategory(req.params.slug));
});

/** GET /catalog/brands */
router.get('/brands', async (_req: Request, res: Response) => {
  successResponse(res, await catalogService.brands(), 'Brands');
});

/**
 * @openapi
 * /catalog/products:
 *   get:
 *     tags: [Catalog]
 *     summary: Search products (full-text, filters, facets). Prices come back in USD and ZiG.
 *     security: []
 *     parameters:
 *       - { in: query, name: q, schema: { type: string } }
 *       - { in: query, name: category, schema: { type: string }, description: Category slug (includes sub-categories) }
 *       - { in: query, name: brand, schema: { type: string }, description: Comma-separated brand slugs }
 *       - { in: query, name: minPrice, schema: { type: number } }
 *       - { in: query, name: maxPrice, schema: { type: number } }
 *       - { in: query, name: currency, schema: { type: string, enum: [USD, ZWG] }, description: Currency of minPrice/maxPrice }
 *       - { in: query, name: city, schema: { type: string }, description: Buyer city id or slug }
 *       - { in: query, name: suburb, schema: { type: string }, description: Buyer suburb id or name (within city) }
 *       - { in: query, name: lat, schema: { type: number }, description: Buyer GPS latitude (with lng) }
 *       - { in: query, name: lng, schema: { type: number }, description: Buyer GPS longitude (with lat) }
 *       - { in: query, name: fulfilment, schema: { type: string, enum: [PLATFORM_FULFILLED, SELLER_FULFILLED] } }
 *       - { in: query, name: inStock, schema: { type: boolean } }
 *       - { in: query, name: sort, schema: { type: string, enum: [relevance, price_asc, price_desc, newest, rating] } }
 */
router.get('/products', validate(productSearchSchema, 'query'), async (req: Request, res: Response) => {
  const dto = req.query as unknown as ProductSearchDto;
  const { data, total, facets, exchangeRate, buyerLocation } = await catalogService.search(dto);
  res.status(200).json({
    success: true,
    message: 'Products',
    data,
    meta: buildPaginationMeta(total, dto.page, dto.limit),
    facets,
    exchangeRate,
    buyerLocation,
  });
});

/** GET /catalog/products/:idOrSlug?city=&suburb=&lat=&lng= — detail with Buy Box and other stores */
router.get(
  '/products/:idOrSlug',
  optionalAuthenticate,
  validate(productDetailQuerySchema, 'query'),
  async (req: Request, res: Response) => {
    const q = req.query as { city?: string; suburb?: string; lat?: number; lng?: number };
    const product = await catalogService.getProduct(req.params.idOrSlug, {
      city: q.city,
      suburb: q.suburb,
      lat: q.lat,
      lng: q.lng,
      viewerRole: req.user?.role,
    });
    successResponse(res, product);
  },
);

// ── Admin: catalog management ─────────────────────────────

/** GET /catalog/admin/products — every product (any status) for the catalog editor */
router.get('/admin/products', authenticate, requireAdmin, validate(adminProductListSchema, 'query'), async (req: Request, res: Response) => {
  const q = req.query as unknown as { q?: string; status?: 'DRAFT' | 'ACTIVE' | 'ARCHIVED'; page: number; limit: number };
  const { data, total } = await catalogService.adminList(q);
  successResponse(res, data, 'Products', 200, buildPaginationMeta(total, q.page, q.limit));
});

router.post(
  '/products',
  authenticate,
  requireAdmin,
  validate(createProductSchema),
  auditLog({ action: 'PRODUCT_CREATED', targetType: 'Product' }),
  async (req: Request, res: Response) => {
    createdResponse(res, await catalogService.createProduct(req.body, req.user!.sub), 'Product created');
  },
);

router.patch(
  '/products/:id',
  authenticate,
  requireAdmin,
  validate(updateProductSchema),
  auditLog({ action: 'PRODUCT_UPDATED', targetType: 'Product', targetIdParam: 'id' }),
  async (req: Request, res: Response) => {
    successResponse(res, await catalogService.updateProduct(req.params.id, req.body), 'Product updated');
  },
);

router.delete(
  '/products/:id',
  authenticate,
  requireAdmin,
  auditLog({ action: 'PRODUCT_UPDATED', targetType: 'Product', targetIdParam: 'id' }),
  async (req: Request, res: Response) => {
    successResponse(res, await catalogService.archiveProduct(req.params.id), 'Product archived');
  },
);

// ── Admin: seller product requests ────────────────────────

const reviewAudit = auditLog({ action: 'PRODUCT_REQUEST_REVIEWED', targetType: 'ProductRequest', targetIdParam: 'id' });

/** GET /catalog/admin/requests?status= — sellers' requests for new products */
router.get('/admin/requests', authenticate, requireAdmin, validate(productRequestListSchema, 'query'), async (req: Request, res: Response) => {
  const status = (req.query as { status?: never }).status;
  const [data, counts] = await Promise.all([productRequestsService.list(status), productRequestsService.counts()]);
  res.status(200).json({ success: true, message: 'Product requests', data, counts });
});

/** GET /catalog/admin/requests/:id — one request with catalog products it may duplicate */
router.get('/admin/requests/:id', authenticate, requireAdmin, async (req: Request, res: Response) => {
  successResponse(res, await productRequestsService.get(req.params.id));
});

/** POST /catalog/admin/requests/:id/approve — create the catalog product from the request */
router.post('/admin/requests/:id/approve', authenticate, requireAdmin, validate(approveProductRequestSchema), reviewAudit, async (req: Request, res: Response) => {
  successResponse(res, await productRequestsService.approve(req.params.id, req.user!.sub, req.body), 'Product created from request');
});

/** POST /catalog/admin/requests/:id/link — the product already exists; point the seller to it */
router.post('/admin/requests/:id/link', authenticate, requireAdmin, validate(linkProductRequestSchema), reviewAudit, async (req: Request, res: Response) => {
  successResponse(res, await productRequestsService.link(req.params.id, req.user!.sub, req.body.productId, req.body.reviewNote), 'Linked to existing product');
});

router.post('/admin/requests/:id/reject', authenticate, requireAdmin, validate(rejectProductRequestSchema), reviewAudit, async (req: Request, res: Response) => {
  successResponse(res, await productRequestsService.reject(req.params.id, req.user!.sub, req.body.reviewNote), 'Request declined');
});

router.post(
  '/admin/products/:id/merge',
  authenticate,
  requireAdmin,
  validate(mergeProductSchema),
  auditLog({ action: 'PRODUCT_MERGED', targetType: 'Product', targetIdParam: 'id' }),
  async (req: Request, res: Response) => {
    successResponse(res, await catalogService.mergeProducts(req.params.id, req.body.intoProductId), 'Products merged');
  },
);
router.post('/categories', authenticate, requireAdmin, validate(createCategorySchema), auditLog({ action: 'CATEGORY_UPDATED', targetType: 'Category' }), async (req: Request, res: Response) => {
  createdResponse(res, await catalogService.createCategory(req.body), 'Category created');
});

router.patch('/categories/:id', authenticate, requireAdmin, validate(updateCategorySchema), auditLog({ action: 'CATEGORY_UPDATED', targetType: 'Category', targetIdParam: 'id' }), async (req: Request, res: Response) => {
  successResponse(res, await catalogService.updateCategory(req.params.id, req.body), 'Category updated');
});

router.post('/brands', authenticate, requireAdmin, validate(createBrandSchema), async (req: Request, res: Response) => {
  createdResponse(res, await catalogService.createBrand(req.body.name, req.body.logoUrl), 'Brand created');
});

export default router;
