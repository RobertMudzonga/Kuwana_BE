import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../middleware/error.middleware';
import { JwtPayload } from '../../middleware/auth.middleware';
import { currencyService, money } from '../currency/currency.service';
import { rankOffers } from '../catalog/buybox';
import { buyBoxOfferInclude, buyBoxService, toCandidate } from '../catalog/buybox.service';
import { sellersService } from '../sellers/sellers.service';
import { getMarketSettings } from '../market/market.settings';
import { CreateOfferDto, UpdateOfferDto } from './offers.schema';

/** Roles allowed to set stock held in a platform hub (it normally changes only via hub receiving) */
const HUB_STOCK_ROLES = new Set(['ADMIN', 'WAREHOUSE']);

const mineInclude = {
  ...buyBoxOfferInclude,
  product: { select: { id: true, sku: true, slug: true, title: true, status: true, buyBoxPriceUsd: true, images: { orderBy: { sortOrder: 'asc' }, take: 1, select: { thumbUrl: true, url: true } } } },
} satisfies Prisma.OfferInclude;

export class OffersService {
  /** Resolve which seller an offer is created for, enforcing who may act for whom */
  private async actingSellerId(actor: JwtPayload, requestedSellerId?: string): Promise<string> {
    if (requestedSellerId) {
      if (actor.role !== 'ADMIN') throw new ForbiddenError('Only admins can list offers for another seller');
      const exists = await prisma.sellerProfile.findUnique({ where: { id: requestedSellerId }, select: { id: true } });
      if (!exists) throw new BadRequestError('Seller not found');
      return requestedSellerId;
    }
    return (await sellersService.requireOwnProfile(actor.sub)).id;
  }

  private async loadOwned(offerId: string, actor: JwtPayload) {
    const offer = await prisma.offer.findUnique({ where: { id: offerId }, include: { seller: { select: { userId: true } } } });
    if (!offer) throw new NotFoundError('Offer');
    if (actor.role !== 'ADMIN' && offer.seller.userId !== actor.sub) throw new ForbiddenError('This offer belongs to another seller');
    return offer;
  }

  async create(actor: JwtPayload, dto: CreateOfferDto) {
    const sellerId = await this.actingSellerId(actor, dto.sellerId);
    const [seller, product] = await Promise.all([
      prisma.sellerProfile.findUniqueOrThrow({ where: { id: sellerId }, select: { cityId: true, leadTimeDays: true } }),
      prisma.product.findUnique({ where: { id: dto.productId }, select: { status: true } }),
    ]);
    if (!product || product.status !== 'ACTIVE') throw new BadRequestError('Product not found or not open for offers');

    let stockQty = dto.stockQty;
    let dispatchCityId: string | null = null;
    let prepTimeMins = dto.prepTimeMins ?? 30;
    if (dto.fulfilmentType === 'PLATFORM_FULFILLED') {
      if (!(await getMarketSettings()).hubsEnabled) throw new BadRequestError('Kuwana hubs are switched off; list stock against one of your store branches');
      const hub = await prisma.hub.findUnique({ where: { id: dto.hubId! }, select: { isActive: true } });
      if (!hub?.isActive) throw new BadRequestError('Hub not found or inactive');
      // Hub stock starts at zero and grows as the hub receives the seller's inbound shipments
      if (!HUB_STOCK_ROLES.has(actor.role)) stockQty = 0;
    } else {
      const branch = await prisma.storeBranch.findUnique({ where: { id: dto.storeBranchId! }, select: { sellerId: true, cityId: true, isActive: true, defaultPrepTimeMins: true } });
      if (!branch || branch.sellerId !== sellerId) throw new BadRequestError('Branch not found for this store');
      if (!branch.isActive) throw new BadRequestError('That branch is closed; reopen it before listing stock');
      dispatchCityId = branch.cityId;
      prepTimeMins = dto.prepTimeMins ?? branch.defaultPrepTimeMins;
    }

    const duplicate = await prisma.offer.findFirst({
      where: { productId: dto.productId, sellerId, fulfilmentType: dto.fulfilmentType, hubId: dto.hubId ?? null, storeBranchId: dto.storeBranchId ?? null },
      select: { id: true },
    });
    if (duplicate) throw new ConflictError('This branch already lists this product — update that offer instead');

    const offer = await prisma.$transaction(async (tx) => {
      const created = await tx.offer.create({
        data: {
          productId: dto.productId,
          sellerId,
          sellerSku: dto.sellerSku,
          priceUsd: dto.priceUsd,
          listPriceUsd: dto.listPriceUsd,
          shippingFeeUsd: dto.shippingFeeUsd,
          stockQty,
          fulfilmentType: dto.fulfilmentType,
          hubId: dto.hubId ?? null,
          storeBranchId: dto.storeBranchId ?? null,
          prepTimeMins,
          dispatchCityId,
          leadTimeDays: dto.leadTimeDays ?? seller.leadTimeDays,
        },
      });
      await buyBoxService.recomputeProduct(dto.productId, tx);
      return created;
    });
    return this.getOne(offer.id);
  }

  async update(actor: JwtPayload, offerId: string, dto: UpdateOfferDto) {
    const offer = await this.loadOwned(offerId, actor);
    if (dto.stockQty !== undefined && offer.fulfilmentType === 'PLATFORM_FULFILLED' && !HUB_STOCK_ROLES.has(actor.role)) {
      throw new BadRequestError('Hub stock changes when the hub receives or ships your units; send an inbound shipment to add stock');
    }
    if (dto.dispatchCityId && offer.fulfilmentType === 'PLATFORM_FULFILLED') {
      throw new BadRequestError('Hub-fulfilled offers ship from their hub');
    }
    if (dto.dispatchCityId && offer.storeBranchId) {
      throw new BadRequestError('Store offers ship from their branch');
    }
    const price = dto.priceUsd ?? offer.priceUsd.toNumber();
    const listPrice = dto.listPriceUsd === undefined ? offer.listPriceUsd?.toNumber() : dto.listPriceUsd;
    if (listPrice != null && listPrice < price) throw new BadRequestError('"Was" price must be at least the selling price');

    await prisma.$transaction(async (tx) => {
      await tx.offer.update({ where: { id: offerId }, data: dto });
      await buyBoxService.recomputeProduct(offer.productId, tx);
    });
    return this.getOne(offerId);
  }

  /** Deactivate (offers stay for order history) */
  async remove(actor: JwtPayload, offerId: string) {
    const offer = await this.loadOwned(offerId, actor);
    await prisma.$transaction(async (tx) => {
      await tx.offer.update({ where: { id: offerId }, data: { isActive: false } });
      await buyBoxService.recomputeProduct(offer.productId, tx);
    });
  }

  /** The seller's offers, with whether each currently wins its Buy Box and the price to beat */
  async listMine(actor: JwtPayload) {
    const seller = await sellersService.requireOwnProfile(actor.sub);
    const rate = await currencyService.getUsdToZwg();
    const [offers, settings] = await Promise.all([
      prisma.offer.findMany({ where: { sellerId: seller.id }, include: mineInclude, orderBy: { updatedAt: 'desc' } }),
      getMarketSettings(),
    ]);
    return offers.map((o) => ({
      id: o.id,
      product: { id: o.product.id, sku: o.product.sku, slug: o.product.slug, title: o.product.title, image: o.product.images[0]?.thumbUrl ?? o.product.images[0]?.url ?? null },
      sellerSku: o.sellerSku,
      price: money(o.priceUsd, rate),
      listPrice: o.listPriceUsd ? money(o.listPriceUsd, rate) : null,
      shippingFee: money(o.shippingFeeUsd, rate),
      stockQty: o.stockQty,
      fulfilmentType: o.fulfilmentType,
      hub: o.hub ? { id: o.hub.id, code: o.hub.code, name: o.hub.name } : null,
      branch: o.storeBranch ? { id: o.storeBranch.id, code: o.storeBranch.code, name: o.storeBranch.name } : null,
      prepTimeMins: o.prepTimeMins,
      dispatchCity: o.dispatchCity?.name ?? null,
      leadTimeDays: o.leadTimeDays,
      isActive: o.isActive,
      isBuyBoxWinner: o.isBuyBoxWinner,
      buyBoxPrice: o.product.buyBoxPriceUsd ? money(o.product.buyBoxPriceUsd, rate) : null,
      eligibility: rankOffers([toCandidate(o)], { hubsEnabled: settings.hubsEnabled }).ineligible[0]?.reason ?? 'ELIGIBLE',
      updatedAt: o.updatedAt,
    }));
  }

  async getOne(offerId: string) {
    const o = await prisma.offer.findUniqueOrThrow({ where: { id: offerId }, include: buyBoxOfferInclude });
    const [rate, settings] = await Promise.all([currencyService.getUsdToZwg(), getMarketSettings()]);
    return {
      id: o.id,
      productId: o.productId,
      sellerId: o.sellerId,
      sellerSku: o.sellerSku,
      price: money(o.priceUsd, rate),
      listPrice: o.listPriceUsd ? money(o.listPriceUsd, rate) : null,
      shippingFee: money(o.shippingFeeUsd, rate),
      stockQty: o.stockQty,
      fulfilmentType: o.fulfilmentType,
      hub: o.hub ? { id: o.hub.id, code: o.hub.code, name: o.hub.name } : null,
      branch: o.storeBranch ? { id: o.storeBranch.id, code: o.storeBranch.code, name: o.storeBranch.name } : null,
      prepTimeMins: o.prepTimeMins,
      dispatchCity: o.dispatchCity,
      leadTimeDays: o.leadTimeDays,
      isActive: o.isActive,
      isBuyBoxWinner: o.isBuyBoxWinner,
      eligibility: rankOffers([toCandidate(o)], { hubsEnabled: settings.hubsEnabled }).ineligible[0]?.reason ?? 'ELIGIBLE',
    };
  }
}

export const offersService = new OffersService();
