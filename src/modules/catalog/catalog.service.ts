import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { BadRequestError, ConflictError, NotFoundError } from '../../middleware/error.middleware';
import { currencyService, money, ratePayload, RateSnapshot, toUsd } from '../currency/currency.service';
import { getMarketSettings } from '../market/market.settings';
import { rankOffers, RankedOffer } from './buybox';
import { buyBoxOfferInclude, buyBoxService, LocationQuery, OfferWithBuyBoxData, productVehicle, ResolvedLocation, toCandidate } from './buybox.service';
import { City, toOfferDto } from './catalog.serializers';
import {
  CreateCategoryDto,
  CreateProductDto,
  ProductSearchDto,
  UpdateCategoryDto,
  UpdateProductDto,
} from './catalog.schema';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CATEGORY_CACHE_MS = 60_000;

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** "sams gal" → "sams:* & gal:*" — prefix matching so results appear while typing */
export function toPrefixTsQuery(q: string): string | null {
  const tokens = q.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.slice(0, 8) ?? [];
  return tokens.length ? tokens.map((t) => `${t}:*`).join(' & ') : null;
}

type CategoryRow = { id: string; name: string; slug: string; parentId: string | null; icon: string | null; imageUrl: string | null; sortOrder: number; isActive: boolean; commissionRate: Prisma.Decimal; fulfilmentFeeUsd: Prisma.Decimal; requiredVehicleClass: string; isReturnable: boolean };
type Dim = 'q' | 'category' | 'brand' | 'price' | 'city' | 'fulfilment' | 'inStock';

const listInclude = {
  brand: { select: { name: true, slug: true } },
  category: { select: { id: true, name: true, slug: true, requiredVehicleClass: true } },
  images: { orderBy: { sortOrder: 'asc' }, take: 1 },
} satisfies Prisma.ProductInclude;

/** Offer `o` can be bought: active, in stock, approved seller, and held by an open-for-business branch (or an enabled hub) */
function offerSellable(hubsEnabled: boolean) {
  return Prisma.sql`o.is_active AND o.stock_qty > 0 AND s.kyc_status = 'APPROVED'
      AND ((o.fulfilment_type = 'SELLER_FULFILLED' AND sb.is_active AND NOT sb.is_paused)
        OR (${hubsEnabled} AND o.fulfilment_type = 'PLATFORM_FULFILLED' AND h.id IS NOT NULL))`;
}

const offerJoins = Prisma.sql`
    JOIN seller_profiles s ON s.id = o.seller_id
    LEFT JOIN hubs h ON h.id = o.hub_id
    LEFT JOIN store_branches sb ON sb.id = o.store_branch_id`;

/** A product's sellable offer matches `extra` */
function eligibleOfferExists(hubsEnabled: boolean, extra: Prisma.Sql) {
  return Prisma.sql`EXISTS (
    SELECT 1 FROM offers o ${offerJoins}
    WHERE o.product_id = p.id AND ${offerSellable(hubsEnabled)} AND ${extra})`;
}

/** Buyer-location query params, shared by search and product detail */
function locationQuery(dto: { city?: string; suburb?: string; lat?: number; lng?: number }): LocationQuery {
  return { city: dto.city, suburb: dto.suburb, lat: dto.lat, lng: dto.lng };
}

function locationDto(loc: ResolvedLocation | null) {
  if (!loc || (!loc.city && loc.precision === 'NONE')) return null;
  return { city: loc.city, suburb: loc.suburb, precision: loc.precision };
}

export class CatalogService {
  private categoryCache: { rows: CategoryRow[]; expiresAt: number } | null = null;

  // ── Reference data ─────────────────────────────────────

  private async categories(): Promise<CategoryRow[]> {
    if (this.categoryCache && this.categoryCache.expiresAt > Date.now()) return this.categoryCache.rows;
    const rows = await prisma.category.findMany({
      select: { id: true, name: true, slug: true, parentId: true, icon: true, imageUrl: true, sortOrder: true, isActive: true, commissionRate: true, fulfilmentFeeUsd: true, requiredVehicleClass: true, isReturnable: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    this.categoryCache = { rows, expiresAt: Date.now() + CATEGORY_CACHE_MS };
    return rows;
  }

  private invalidateCategories() {
    this.categoryCache = null;
  }

  private descendantIds(rows: CategoryRow[], rootId: string): string[] {
    const ids = [rootId];
    for (let i = 0; i < ids.length; i++) {
      for (const c of rows) if (c.parentId === ids[i]) ids.push(c.id);
    }
    return ids;
  }

  private breadcrumb(rows: CategoryRow[], categoryId: string) {
    const byId = new Map(rows.map((c) => [c.id, c]));
    const path: { id: string; name: string; slug: string }[] = [];
    for (let c = byId.get(categoryId); c && path.length < 10; c = c.parentId ? byId.get(c.parentId) : undefined) {
      path.unshift({ id: c.id, name: c.name, slug: c.slug });
    }
    return path;
  }

  async resolveCity(idOrSlug?: string): Promise<City | null> {
    if (!idOrSlug) return null;
    const city = await prisma.city.findFirst({
      where: UUID_RE.test(idOrSlug) ? { id: idOrSlug } : { slug: idOrSlug.toLowerCase() },
      select: { id: true, name: true, slug: true, zone: true },
    });
    if (!city) throw new BadRequestError(`Unknown city "${idOrSlug}"`);
    return city;
  }

  async categoryTree() {
    const rows = (await this.categories()).filter((c) => c.isActive);
    const counts = await prisma.product.groupBy({ by: ['categoryId'], where: { status: 'ACTIVE' }, _count: true });
    const direct = new Map(counts.map((c) => [c.categoryId, c._count]));

    type Node = Omit<CategoryRow, 'isActive' | 'parentId' | 'commissionRate' | 'fulfilmentFeeUsd' | 'requiredVehicleClass'> & { productCount: number; commissionRate: number; fulfilmentFeeUsd: number; requiredVehicleClass: string; children: Node[] };
    const build = (parentId: string | null): Node[] =>
      rows
        .filter((c) => c.parentId === parentId)
        .map((c) => {
          const children = build(c.id);
          const productCount = (direct.get(c.id) ?? 0) + children.reduce((n, ch) => n + ch.productCount, 0);
          return { id: c.id, name: c.name, slug: c.slug, icon: c.icon, imageUrl: c.imageUrl, sortOrder: c.sortOrder, productCount, commissionRate: c.commissionRate.toNumber(), fulfilmentFeeUsd: c.fulfilmentFeeUsd.toNumber(), requiredVehicleClass: c.requiredVehicleClass, isReturnable: c.isReturnable, children };
        });
    return build(null);
  }

  async getCategory(slug: string) {
    const rows = await this.categories();
    const cat = rows.find((c) => c.slug === slug && c.isActive);
    if (!cat) throw new NotFoundError('Category');
    return {
      id: cat.id,
      name: cat.name,
      slug: cat.slug,
      icon: cat.icon,
      imageUrl: cat.imageUrl,
      breadcrumb: this.breadcrumb(rows, cat.id),
      children: rows.filter((c) => c.parentId === cat.id && c.isActive).map((c) => ({ id: c.id, name: c.name, slug: c.slug, icon: c.icon })),
    };
  }

  async brands() {
    return prisma.brand.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true, slug: true, logoUrl: true } });
  }

  // ── Search ─────────────────────────────────────────────

  async search(dto: ProductSearchDto) {
    const [rate, categories, location, settings] = await Promise.all([
      currencyService.getUsdToZwg(),
      this.categories(),
      buyBoxService.resolveLocation(locationQuery(dto)),
      getMarketSettings(),
    ]);
    const hubsEnabled = settings.hubsEnabled;
    const city = location.city;

    const where: Partial<Record<Dim, Prisma.Sql>> = {};
    const tsq = dto.q ? toPrefixTsQuery(dto.q) : null;
    if (dto.q) {
      where.q = tsq
        ? Prisma.sql`(p.search_vector @@ to_tsquery('simple', ${tsq}) OR ${dto.q} <% p.title)`
        : Prisma.sql`${dto.q} <% p.title`;
    }
    if (dto.category) {
      const cat = categories.find((c) => c.slug === dto.category && c.isActive);
      if (!cat) throw new BadRequestError(`Unknown category "${dto.category}"`);
      where.category = Prisma.sql`p.category_id = ANY(${this.descendantIds(categories, cat.id)}::text[])`;
    }
    if (dto.brand?.length) {
      where.brand = Prisma.sql`p.brand_id IN (SELECT id FROM brands WHERE slug = ANY(${dto.brand}::text[]))`;
    }
    if (dto.minPrice !== undefined || dto.maxPrice !== undefined) {
      // Decimal can't be sent as a raw parameter next to arrays; pass text and cast
      const parts: Prisma.Sql[] = [];
      if (dto.minPrice !== undefined) parts.push(Prisma.sql`p.buy_box_price_usd >= ${toUsd(dto.minPrice, dto.currency, rate).toString()}::numeric`);
      if (dto.maxPrice !== undefined) parts.push(Prisma.sql`p.buy_box_price_usd <= ${toUsd(dto.maxPrice, dto.currency, rate).toString()}::numeric`);
      where.price = Prisma.join(parts, ' AND ');
    }
    if (location.lat != null && location.lng != null) {
      // Deliverable to the buyer: a branch within the delivery radius (PostGIS, GiST-indexed)
      const radiusM = settings.maxDeliveryRadiusKm.toNumber() * 1000;
      where.city = eligibleOfferExists(
        hubsEnabled,
        Prisma.sql`(ST_DWithin(sb.geom, ST_SetSRID(ST_MakePoint(${location.lng}, ${location.lat}), 4326)::geography, ${radiusM})
          OR (h.id IS NOT NULL AND h.city_id = ${city?.id ?? ''}))`,
      );
    } else if (city) {
      where.city = eligibleOfferExists(hubsEnabled, Prisma.sql`COALESCE(sb.city_id, h.city_id) = ${city.id}`);
    }
    if (dto.fulfilment && hubsEnabled) {
      where.fulfilment = eligibleOfferExists(hubsEnabled, Prisma.sql`o.fulfilment_type = ${dto.fulfilment}::"FulfilmentMethod"`);
    }
    if (dto.inStock) where.inStock = Prisma.sql`p.in_stock`;

    /** All active filters, optionally leaving one out (so a facet counts its own alternatives) */
    const whereSql = (exclude?: Dim) =>
      Prisma.join(
        [Prisma.sql`p.status = 'ACTIVE'`, ...Object.entries(where).filter(([k]) => k !== exclude).map(([, v]) => v!)],
        ' AND ',
      );

    const rank = tsq
      ? Prisma.sql`ts_rank(p.search_vector, to_tsquery('simple', ${tsq})) + word_similarity(${dto.q!}, p.title)`
      : dto.q
        ? Prisma.sql`word_similarity(${dto.q}, p.title)`
        : null;
    const orderBy = {
      relevance: rank
        ? Prisma.sql`${rank} DESC, p.in_stock DESC, p.id`
        : Prisma.sql`p.in_stock DESC, p.rating_count DESC, p.created_at DESC, p.id`,
      price_asc: Prisma.sql`p.in_stock DESC, p.buy_box_price_usd ASC NULLS LAST, p.id`,
      price_desc: Prisma.sql`p.in_stock DESC, p.buy_box_price_usd DESC NULLS LAST, p.id`,
      newest: Prisma.sql`p.created_at DESC, p.id`,
      rating: Prisma.sql`p.rating_avg DESC, p.rating_count DESC, p.id`,
    }[dto.sort];

    const offset = (dto.page - 1) * dto.limit;
    const [idRows, countRows, brandFacet, categoryFacet, fulfilmentFacet, cityFacet, priceFacet] = await Promise.all([
      prisma.$queryRaw<{ id: string }[]>`
        SELECT p.id FROM products p WHERE ${whereSql()} ORDER BY ${orderBy} LIMIT ${dto.limit} OFFSET ${offset}`,
      prisma.$queryRaw<{ total: number }[]>`SELECT COUNT(*)::int AS total FROM products p WHERE ${whereSql()}`,
      prisma.$queryRaw<{ id: string; name: string; slug: string; count: number }[]>`
        SELECT b.id, b.name, b.slug, COUNT(*)::int AS count
        FROM products p JOIN brands b ON b.id = p.brand_id
        WHERE ${whereSql('brand')} GROUP BY b.id ORDER BY count DESC, b.name LIMIT 30`,
      prisma.$queryRaw<{ id: string; count: number }[]>`
        SELECT p.category_id AS id, COUNT(*)::int AS count FROM products p
        WHERE ${whereSql('category')} GROUP BY p.category_id`,
      prisma.$queryRaw<{ platform: number; seller: number }[]>`
        SELECT
          COUNT(*) FILTER (WHERE ${eligibleOfferExists(hubsEnabled, Prisma.sql`o.fulfilment_type = 'PLATFORM_FULFILLED'`)})::int AS platform,
          COUNT(*) FILTER (WHERE ${eligibleOfferExists(hubsEnabled, Prisma.sql`o.fulfilment_type = 'SELLER_FULFILLED'`)})::int AS seller
        FROM products p WHERE ${whereSql('fulfilment')}`,
      prisma.$queryRaw<{ id: string; name: string; slug: string; count: number }[]>`
        SELECT c.id, c.name, c.slug, COUNT(DISTINCT p.id)::int AS count
        FROM products p
        JOIN offers o ON o.product_id = p.id ${offerJoins}
        JOIN cities c ON c.id = COALESCE(sb.city_id, h.city_id)
        WHERE ${whereSql('city')} AND ${offerSellable(hubsEnabled)} GROUP BY c.id ORDER BY count DESC, c.name`,
      prisma.$queryRaw<{ min: Prisma.Decimal | null; max: Prisma.Decimal | null }[]>`
        SELECT MIN(p.buy_box_price_usd) AS min, MAX(p.buy_box_price_usd) AS max FROM products p WHERE ${whereSql('price')}`,
    ]);

    const ids = idRows.map((r) => r.id);
    const items = await this.hydrateList(ids, rate, location);

    return {
      data: items,
      total: countRows[0]?.total ?? 0,
      exchangeRate: ratePayload(rate),
      buyerLocation: locationDto(location),
      facets: {
        brands: brandFacet,
        categories: this.rollUpCategoryFacet(categories, categoryFacet, dto.category),
        // Only meaningful while platform hubs hold stock
        fulfilment: hubsEnabled
          ? [
              { value: 'PLATFORM_FULFILLED', label: 'Fulfilled by Kuwana', count: fulfilmentFacet[0]?.platform ?? 0 },
              { value: 'SELLER_FULFILLED', label: 'From local stores', count: fulfilmentFacet[0]?.seller ?? 0 },
            ]
          : [],
        cities: cityFacet,
        price: {
          min: priceFacet[0]?.min ? money(priceFacet[0].min, rate) : null,
          max: priceFacet[0]?.max ? money(priceFacet[0].max, rate) : null,
        },
      },
    };
  }

  /**
   * Counts per category, rolled up to the children of the selected category
   * (or to top-level departments when none is selected).
   */
  private rollUpCategoryFacet(rows: CategoryRow[], counts: { id: string; count: number }[], selectedSlug?: string) {
    const byId = new Map(rows.map((c) => [c.id, c]));
    const selected = selectedSlug ? rows.find((c) => c.slug === selectedSlug) : undefined;
    const parentId = selected?.id ?? null;
    const totals = new Map<string, number>();
    for (const { id, count } of counts) {
      // Walk up until we reach a direct child of the selected level
      let c = byId.get(id);
      while (c && c.parentId !== parentId) c = c.parentId ? byId.get(c.parentId) : undefined;
      if (c) totals.set(c.id, (totals.get(c.id) ?? 0) + count);
    }
    return [...totals.entries()]
      .map(([id, count]) => ({ id, name: byId.get(id)!.name, slug: byId.get(id)!.slug, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  /**
   * Load list cards in the given order. With a buyer location, each product's Buy Box is ranked
   * live for that buyer (open now, distance, delivered price); otherwise the stored winner is used.
   */
  private async hydrateList(ids: string[], rate: RateSnapshot | null, location: ResolvedLocation | null) {
    if (!ids.length) return [];
    const products = await prisma.product.findMany({ where: { id: { in: ids } }, include: listInclude });
    const live = !!location && (location.cityId != null || location.lat != null);
    const offers = await prisma.offer.findMany({
      where: live ? { productId: { in: ids } } : { id: { in: products.map((p) => p.buyBoxOfferId).filter((x): x is string => !!x) } },
      include: buyBoxOfferInclude,
    });

    type Winner = { offer: OfferWithBuyBoxData; ranked: RankedOffer<ReturnType<typeof toCandidate>> | null };
    const winners = new Map<string, Winner>();
    const now = new Date();
    if (live) {
      const byProduct = new Map<string, OfferWithBuyBoxData[]>();
      for (const o of offers) byProduct.set(o.productId, [...(byProduct.get(o.productId) ?? []), o]);
      const vehicleOf = new Map(products.map((p) => [p.id, productVehicle(p)]));
      for (const [productId, list] of byProduct) {
        const opts = await buyBoxService.liveOptions(location, vehicleOf.get(productId) ?? 'BIKE', now);
        const w = rankOffers(list.map(toCandidate), opts).winner;
        if (w) winners.set(productId, { offer: w.offer, ranked: w });
      }
    } else {
      const settings = await getMarketSettings();
      for (const o of offers) {
        const r = rankOffers([toCandidate(o)], { hubsEnabled: settings.hubsEnabled, now }).winner;
        if (r) winners.set(o.productId, { offer: o, ranked: r });
      }
    }

    const byId = new Map(products.map((p) => [p.id, p]));
    return ids.map((id) => byId.get(id)!).filter(Boolean).map((p) => {
      const w = winners.get(p.id);
      const offer = w ? toOfferDto(w.offer, { ranked: w.ranked, isWinner: true, rate, now }) : null;
      return {
        id: p.id,
        sku: p.sku,
        slug: p.slug,
        title: p.title,
        brand: p.brand,
        category: p.category,
        image: p.images[0] ? { url: p.images[0].url, thumbUrl: p.images[0].thumbUrl ?? p.images[0].url, alt: p.images[0].alt } : null,
        ratingAvg: p.ratingAvg,
        ratingCount: p.ratingCount,
        inStock: !!offer,
        offerCount: p.offerCount,
        price: offer?.price ?? null,
        listPrice: offer?.listPrice ?? null,
        buyBox: offer
          ? {
              offerId: offer.id,
              sellerName: offer.seller.name,
              isFirstParty: offer.seller.isFirstParty,
              fulfilmentType: offer.fulfilmentType,
              branch: offer.branch ? { suburb: offer.branch.suburb, city: offer.branch.city } : null,
              distanceKm: offer.distanceKm,
              isOpenNow: offer.isOpenNow,
              etaMinutes: offer.etaMinutes,
              deliveryFee: offer.deliveryFee,
              availability: offer.availability,
            }
          : null,
      };
    });
  }

  // ── Product detail ─────────────────────────────────────

  async getProduct(idOrSlug: string, opts: LocationQuery & { viewerRole?: string }) {
    const [rate, categories, location] = await Promise.all([
      currencyService.getUsdToZwg(),
      this.categories(),
      buyBoxService.resolveLocation(locationQuery(opts)),
    ]);
    // A duplicate merged into another product: old links show the surviving product
    const head = await prisma.product.findFirst({ where: UUID_RE.test(idOrSlug) ? { id: idOrSlug } : { slug: idOrSlug }, select: { id: true, mergedIntoId: true } });
    const product = !head ? null : await prisma.product.findFirst({
      where: { id: head.mergedIntoId ?? head.id },
      include: {
        brand: { select: { id: true, name: true, slug: true, logoUrl: true } },
        images: { orderBy: { sortOrder: 'asc' } },
        offers: { include: buyBoxOfferInclude },
        category: { select: { requiredVehicleClass: true } },
      },
    });
    if (!product || (product.status !== 'ACTIVE' && opts.viewerRole !== 'ADMIN')) throw new NotFoundError('Product');

    const now = new Date();
    const vehicleClass = productVehicle(product);
    const rankOpts = await buyBoxService.liveOptions(location.lat != null || location.cityId ? location : null, vehicleClass, now);
    const result = product.status === 'ACTIVE'
      ? rankOffers(product.offers.map(toCandidate), rankOpts)
      : { winner: null, ranked: [], ineligible: [] };
    const offers = result.ranked.map((r, i) => toOfferDto(r.offer, { ranked: r, isWinner: i === 0, rate, now }));

    return {
      id: product.id,
      sku: product.sku,
      slug: product.slug,
      title: product.title,
      description: product.description,
      status: product.status,
      categoryId: product.categoryId,
      brand: product.brand,
      breadcrumb: this.breadcrumb(categories, product.categoryId),
      specifications: product.specifications,
      images: product.images.map((i) => ({ url: i.url, thumbUrl: i.thumbUrl ?? i.url, alt: i.alt })),
      ratingAvg: product.ratingAvg,
      ratingCount: product.ratingCount,
      weightKg: product.weightKg?.toNumber() ?? null,
      vehicleClass,
      /** Admin editor: the product's own override (null = inherits the category's) */
      vehicleClassOverride: product.requiredVehicleClass,
      inStock: offers.length > 0,
      buyBox: offers[0] ?? null,
      otherOffers: offers.slice(1),
      /** Offers that exist but can't be bought right now (sold out) */
      outOfStockOfferCount: result.ineligible.filter((x) => x.reason === 'OUT_OF_STOCK').length,
      /** In-stock offers from stores too far away to deliver to the buyer */
      outOfRangeOfferCount: result.ineligible.filter((x) => x.reason === 'OUT_OF_RANGE').length,
      buyerCity: location.city,
      buyerLocation: locationDto(location),
      exchangeRate: ratePayload(rate),
    };
  }

  // ── Admin: products ────────────────────────────────────

  /** All products for the catalog editor, including drafts and archived ones */
  async adminList(opts: { q?: string; status?: 'DRAFT' | 'ACTIVE' | 'ARCHIVED'; page: number; limit: number }) {
    const where: Prisma.ProductWhereInput = {
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.q ? { OR: [{ title: { contains: opts.q, mode: 'insensitive' } }, { sku: { contains: opts.q, mode: 'insensitive' } }] } : {}),
    };
    const [rows, total, categories] = await Promise.all([
      prisma.product.findMany({
        where,
        include: {
          brand: { select: { name: true } },
          images: { orderBy: { sortOrder: 'asc' }, take: 1, select: { thumbUrl: true, url: true } },
        },
        orderBy: { updatedAt: 'desc' },
        skip: (opts.page - 1) * opts.limit,
        take: opts.limit,
      }),
      prisma.product.count({ where }),
      this.categories(),
    ]);
    return {
      total,
      data: rows.map((p) => ({
        id: p.id,
        sku: p.sku,
        slug: p.slug,
        title: p.title,
        status: p.status,
        brand: p.brand?.name ?? null,
        category: this.breadcrumb(categories, p.categoryId).map((c) => c.name).join(' › '),
        image: p.images[0]?.thumbUrl ?? p.images[0]?.url ?? null,
        offerCount: p.offerCount,
        inStock: p.inStock,
        buyBoxPriceUsd: p.buyBoxPriceUsd?.toNumber() ?? null,
        updatedAt: p.updatedAt,
      })),
    };
  }

  private async assertCategoryAndBrand(categoryId?: string, brandId?: string | null) {
    if (categoryId) {
      const cat = await prisma.category.findUnique({ where: { id: categoryId }, select: { isActive: true } });
      if (!cat?.isActive) throw new BadRequestError('Category not found or inactive');
    }
    if (brandId) {
      const brand = await prisma.brand.findUnique({ where: { id: brandId }, select: { id: true } });
      if (!brand) throw new BadRequestError('Brand not found');
    }
  }

  /** Checks a new product's category, brand and SKU before creating it */
  async assertNewProduct(dto: CreateProductDto) {
    await this.assertCategoryAndBrand(dto.categoryId, dto.brandId);
    if (await prisma.product.findUnique({ where: { sku: dto.sku }, select: { id: true } })) {
      throw new ConflictError(`SKU ${dto.sku} already exists`);
    }
  }

  productCreateData(dto: CreateProductDto): Prisma.ProductCreateInput {
    return {
      sku: dto.sku,
      slug: `${slugify(dto.title)}-${slugify(dto.sku)}`,
      title: dto.title,
      description: dto.description,
      brand: dto.brandId ? { connect: { id: dto.brandId } } : undefined,
      category: { connect: { id: dto.categoryId } },
      specifications: dto.specifications,
      status: dto.status,
      weightKg: dto.weightKg,
      requiredVehicleClass: dto.requiredVehicleClass ?? null,
      images: dto.images ? { create: dto.images.map((img, i) => ({ ...img, sortOrder: i })) } : undefined,
    };
  }

  async createProduct(dto: CreateProductDto, adminId: string) {
    await this.assertNewProduct(dto);
    const product = await prisma.product.create({ data: this.productCreateData(dto) });
    void adminId; // recorded by the audit middleware
    return this.getProduct(product.id, { viewerRole: 'ADMIN' });
  }

  async updateProduct(id: string, dto: UpdateProductDto) {
    const existing = await prisma.product.findUnique({ where: { id }, select: { id: true, status: true, sku: true } });
    if (!existing) throw new NotFoundError('Product');
    await this.assertCategoryAndBrand(dto.categoryId, dto.brandId);
    if (dto.sku && dto.sku !== existing.sku && (await prisma.product.findUnique({ where: { sku: dto.sku }, select: { id: true } }))) {
      throw new ConflictError(`SKU ${dto.sku} already exists`);
    }

    await prisma.$transaction(async (tx) => {
      const { images, ...fields } = dto;
      await tx.product.update({ where: { id }, data: fields });
      if (images) {
        await tx.productImage.deleteMany({ where: { productId: id } });
        await tx.productImage.createMany({ data: images.map((img, i) => ({ ...img, productId: id, sortOrder: i })) });
      }
      if (dto.status && dto.status !== existing.status) await buyBoxService.recomputeProduct(id, tx);
    });
    return this.getProduct(id, { viewerRole: 'ADMIN' });
  }

  /** Archive rather than delete: past orders keep pointing at the product */
  async archiveProduct(id: string) {
    return this.updateProduct(id, { status: 'ARCHIVED' });
  }

  // ── Admin: categories & brands ─────────────────────────

  /**
   * Merge a duplicate into the master product: its offers move across (a seller with offers on both at the
   * same branch keeps one, with the stock added up), requests are re-pointed, and the duplicate is archived
   * with a redirect. Past orders keep pointing at the duplicate.
   */
  async mergeProducts(sourceId: string, targetId: string) {
    if (sourceId === targetId) throw new BadRequestError('Choose a different product to merge into');
    const [source, target] = await Promise.all([
      prisma.product.findUnique({ where: { id: sourceId }, include: { offers: true } }),
      prisma.product.findUnique({ where: { id: targetId }, include: { offers: true } }),
    ]);
    if (!source || !target) throw new NotFoundError('Product');
    if (source.mergedIntoId) throw new BadRequestError('That product was already merged');
    if (target.mergedIntoId || target.status === 'ARCHIVED') throw new BadRequestError('Merge into a live product');

    let moved = 0;
    let combined = 0;
    await prisma.$transaction(async (tx) => {
      await tx.product.update({ where: { id: sourceId }, data: { buyBoxOfferId: null } });
      for (const o of source.offers) {
        const twin = target.offers.find((t) => t.sellerId === o.sellerId && t.storeBranchId === o.storeBranchId && t.hubId === o.hubId);
        if (twin) {
          await tx.offer.update({ where: { id: twin.id }, data: { stockQty: { increment: o.stockQty } } });
          await tx.offer.update({ where: { id: o.id }, data: { isActive: false, stockQty: 0, isBuyBoxWinner: false } });
          combined++;
        } else {
          await tx.offer.update({ where: { id: o.id }, data: { productId: targetId, isBuyBoxWinner: false } });
          moved++;
        }
      }
      await tx.productRequest.updateMany({ where: { productId: sourceId }, data: { productId: targetId } });
      await tx.product.updateMany({ where: { mergedIntoId: sourceId }, data: { mergedIntoId: targetId } });
      await tx.product.update({ where: { id: sourceId }, data: { status: 'ARCHIVED', mergedIntoId: targetId, inStock: false, offerCount: 0, buyBoxPriceUsd: null } });
      await buyBoxService.recomputeProduct(targetId, tx);
    });
    return { mergedId: sourceId, intoId: targetId, intoSlug: target.slug, offersMoved: moved, offersCombined: combined };
  }

  async createCategory(dto: CreateCategoryDto) {
    const slug = dto.slug ?? slugify(dto.name);
    if (await prisma.category.findUnique({ where: { slug }, select: { id: true } })) throw new ConflictError(`Category slug "${slug}" is taken`);
    if (dto.parentId && !(await prisma.category.findUnique({ where: { id: dto.parentId }, select: { id: true } }))) {
      throw new BadRequestError('Parent category not found');
    }
    const created = await prisma.category.create({ data: { ...dto, slug } });
    this.invalidateCategories();
    return created;
  }

  async updateCategory(id: string, dto: UpdateCategoryDto) {
    if (dto.parentId) {
      const rows = await this.categories();
      if (dto.parentId === id || this.descendantIds(rows, id).includes(dto.parentId)) {
        throw new BadRequestError('A category cannot be moved under itself');
      }
    }
    try {
      const updated = await prisma.category.update({ where: { id }, data: dto });
      this.invalidateCategories();
      return updated;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') throw new NotFoundError('Category');
      throw err;
    }
  }

  async createBrand(name: string, logoUrl?: string) {
    const slug = slugify(name);
    const exists = await prisma.brand.findFirst({ where: { OR: [{ name }, { slug }] }, select: { id: true } });
    if (exists) throw new ConflictError(`Brand "${name}" already exists`);
    return prisma.brand.create({ data: { name, slug, logoUrl } });
  }
}

export const catalogService = new CatalogService();
