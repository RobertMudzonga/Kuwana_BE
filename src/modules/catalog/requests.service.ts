import { Prisma, ProductRequestStatus } from '@prisma/client';
import prisma from '../../lib/prisma';
import { sendPushToUsers } from '../../lib/push';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../middleware/error.middleware';
import { catalogService } from './catalog.service';
import { ApproveProductRequestDto, CreateProductRequestDto } from './catalog.schema';

/** Open requests a seller may have at once, so the review queue stays manageable */
export const MAX_PENDING_PER_SELLER = 10;

const include = {
  seller: { select: { id: true, businessName: true, userId: true, kycStatus: true } },
  category: { select: { id: true, name: true } },
  product: { select: { id: true, slug: true, sku: true, title: true, status: true } },
} satisfies Prisma.ProductRequestInclude;

type RequestRow = Prisma.ProductRequestGetPayload<{ include: typeof include }>;

function toDto(r: RequestRow, opts: { admin: boolean }) {
  return {
    id: r.id,
    status: r.status,
    title: r.title,
    brandName: r.brandName,
    category: r.category,
    description: r.description,
    barcode: r.barcode,
    referenceUrl: r.referenceUrl,
    images: r.images as { url: string; alt?: string }[],
    specifications: r.specifications as Record<string, string | number | boolean>,
    weightKg: r.weightKg?.toNumber() ?? null,
    note: r.note,
    product: r.product,
    reviewNote: r.reviewNote,
    reviewedAt: r.reviewedAt,
    createdAt: r.createdAt,
    ...(opts.admin ? { seller: { id: r.seller.id, businessName: r.seller.businessName, kycStatus: r.seller.kycStatus } } : {}),
  };
}

export class ProductRequestsService {
  // ── Seller ─────────────────────────────────────────────

  async create(sellerId: string, dto: CreateProductRequestDto) {
    const seller = await prisma.sellerProfile.findUniqueOrThrow({ where: { id: sellerId }, select: { kycStatus: true } });
    if (seller.kycStatus === 'REJECTED' || seller.kycStatus === 'SUSPENDED') {
      throw new ForbiddenError('Your seller account cannot request products right now');
    }
    const pending = await prisma.productRequest.count({ where: { sellerId, status: 'PENDING' } });
    if (pending >= MAX_PENDING_PER_SELLER) {
      throw new BadRequestError(`You already have ${pending} requests waiting for review. Please wait for some to be reviewed.`);
    }
    if (dto.categoryId) {
      const cat = await prisma.category.findUnique({ where: { id: dto.categoryId }, select: { isActive: true } });
      if (!cat?.isActive) throw new BadRequestError('Category not found');
    }
    const created = await prisma.productRequest.create({ data: { ...dto, sellerId }, include });
    return toDto(created, { admin: false });
  }

  async listForSeller(sellerId: string) {
    const rows = await prisma.productRequest.findMany({ where: { sellerId }, include, orderBy: { createdAt: 'desc' }, take: 100 });
    return rows.map((r) => toDto(r, { admin: false }));
  }

  async cancel(sellerId: string, id: string) {
    const res = await prisma.productRequest.updateMany({ where: { id, sellerId, status: 'PENDING' }, data: { status: 'CANCELLED' } });
    if (!res.count) {
      const exists = await prisma.productRequest.findFirst({ where: { id, sellerId }, select: { id: true } });
      if (!exists) throw new NotFoundError('Request');
      throw new ConflictError('Only requests waiting for review can be cancelled');
    }
    return toDto(await prisma.productRequest.findUniqueOrThrow({ where: { id }, include }), { admin: false });
  }

  // ── Admin ──────────────────────────────────────────────

  async list(status?: ProductRequestStatus) {
    const rows = await prisma.productRequest.findMany({
      where: status ? { status } : {},
      include,
      // Oldest first while waiting (a queue); newest first once decided
      orderBy: { createdAt: status === 'PENDING' ? 'asc' : 'desc' },
      take: 200,
    });
    return rows.map((r) => toDto(r, { admin: true }));
  }

  async counts() {
    const rows = await prisma.productRequest.groupBy({ by: ['status'], _count: true });
    return Object.fromEntries(rows.map((r) => [r.status, r._count])) as Partial<Record<ProductRequestStatus, number>>;
  }

  async get(id: string) {
    const r = await prisma.productRequest.findUnique({ where: { id }, include });
    if (!r) throw new NotFoundError('Request');
    return { ...toDto(r, { admin: true }), possibleMatches: await this.possibleMatches(r.title, r.barcode) };
  }

  /** Catalog products that may already be what the seller asked for: same barcode, or a similar title */
  private async possibleMatches(title: string, barcode: string | null) {
    return prisma.$queryRaw<{ id: string; slug: string; sku: string; title: string; status: string; image: string | null; barcodeMatch: boolean }[]>`
      SELECT p.id, p.slug, p.sku, p.title, p.status::text AS status,
        (SELECT COALESCE(i.thumb_url, i.url) FROM product_images i WHERE i.product_id = p.id ORDER BY i.sort_order LIMIT 1) AS image,
        (${barcode}::text IS NOT NULL AND p.specifications->>'Barcode' = ${barcode}::text) AS "barcodeMatch"
      FROM products p
      WHERE p.status <> 'ARCHIVED'
        AND ((${barcode}::text IS NOT NULL AND p.specifications->>'Barcode' = ${barcode}::text)
          OR p.title % ${title} OR ${title} <% p.title)
      ORDER BY "barcodeMatch" DESC, similarity(p.title, ${title}) DESC
      LIMIT 5`;
  }

  private async claim(id: string, adminId: string, data: Prisma.ProductRequestUncheckedUpdateManyInput, tx: Prisma.TransactionClient = prisma) {
    const res = await tx.productRequest.updateMany({
      where: { id, status: 'PENDING' },
      data: { ...data, reviewedBy: adminId, reviewedAt: new Date() },
    });
    if (!res.count) {
      if (!(await tx.productRequest.findUnique({ where: { id }, select: { id: true } }))) throw new NotFoundError('Request');
      throw new ConflictError('This request has already been dealt with');
    }
  }

  /** Create the catalog product (the admin may have corrected the seller's details) */
  async approve(id: string, adminId: string, dto: ApproveProductRequestDto) {
    const { reviewNote, ...productDto } = dto;
    await catalogService.assertNewProduct(productDto);
    const updated = await prisma.$transaction(async (tx) => {
      await this.claim(id, adminId, { status: 'APPROVED', reviewNote: reviewNote ?? null }, tx);
      const product = await tx.product.create({ data: catalogService.productCreateData(productDto) });
      return tx.productRequest.update({ where: { id }, data: { productId: product.id }, include });
    });
    void this.notify(updated);
    return toDto(updated, { admin: true });
  }

  /** The product is already in the catalog: point the seller at it */
  async link(id: string, adminId: string, productId: string, reviewNote?: string) {
    const product = await prisma.product.findUnique({ where: { id: productId }, select: { status: true } });
    if (!product || product.status === 'ARCHIVED') throw new BadRequestError('Choose a product that is in the catalog');
    await this.claim(id, adminId, { status: 'DUPLICATE', productId, reviewNote: reviewNote ?? null });
    const updated = await prisma.productRequest.findUniqueOrThrow({ where: { id }, include });
    void this.notify(updated);
    return toDto(updated, { admin: true });
  }

  async reject(id: string, adminId: string, reviewNote: string) {
    await this.claim(id, adminId, { status: 'REJECTED', reviewNote });
    const updated = await prisma.productRequest.findUniqueOrThrow({ where: { id }, include });
    void this.notify(updated);
    return toDto(updated, { admin: true });
  }

  private async notify(r: RequestRow) {
    const live = r.product?.status === 'ACTIVE';
    const body =
      r.status === 'REJECTED' ? `“${r.title}” was not added: ${r.reviewNote}`
      : r.status === 'DUPLICATE' ? `“${r.title}” is already in the catalog as “${r.product?.title}”. Add your offer to it.`
      : live ? `“${r.title}” is now in the catalog. Add your price and stock.`
      : `“${r.title}” was approved and will go live soon.`;
    await sendPushToUsers([r.seller.userId], {
      title: r.status === 'REJECTED' ? 'Product request declined' : 'Product request approved',
      body,
      data: { type: 'PRODUCT_REQUEST', requestId: r.id },
    });
  }
}

export const productRequestsService = new ProductRequestsService();
