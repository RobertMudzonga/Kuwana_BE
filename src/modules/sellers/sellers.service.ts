import { ApprovalStatus, Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../middleware/error.middleware';
import { buyBoxService } from '../catalog/buybox.service';
import { slugify } from '../catalog/catalog.service';
import { OnboardSellerDto, UpdateSellerDto } from './sellers.schema';

const sellerInclude = { city: { select: { id: true, name: true, slug: true } } } satisfies Prisma.SellerProfileInclude;
type SellerWithCity = Prisma.SellerProfileGetPayload<{ include: typeof sellerInclude }>;

/** The seller's own view, including KYC and payout fields */
function toPrivateSeller(s: SellerWithCity) {
  return {
    id: s.id,
    businessName: s.businessName,
    slug: s.slug,
    description: s.description,
    logoUrl: s.logoUrl,
    isFirstParty: s.isFirstParty,
    kycTier: s.kycTier,
    kycStatus: s.kycStatus,
    taxNumber: s.taxNumber,
    nationalId: s.nationalId,
    phone: s.phone,
    city: s.city,
    plan: s.plan,
    slaScore: s.slaScore.toNumber(),
    disputeRate: s.disputeRate.toNumber(),
    ratingAvg: s.ratingAvg,
    ratingCount: s.ratingCount,
    leadTimeDays: s.leadTimeDays,
    usdPayoutDetails: s.usdPayoutDetails,
    zigPayoutDetails: s.zigPayoutDetails,
    rejectionNote: s.rejectionNote,
    approvedAt: s.approvedAt,
    createdAt: s.createdAt,
  };
}

async function uniqueSlug(name: string): Promise<string> {
  const base = slugify(name) || 'seller';
  for (let i = 0; i < 50; i++) {
    const slug = i === 0 ? base : `${base}-${i + 1}`;
    if (!(await prisma.sellerProfile.findUnique({ where: { slug }, select: { id: true } }))) return slug;
  }
  return `${base}-${Date.now()}`;
}

export class SellersService {
  /** The seller profile owned by this user, or 403 */
  async requireOwnProfile(userId: string) {
    const profile = await prisma.sellerProfile.findUnique({ where: { userId } });
    if (!profile) throw new ForbiddenError('Set up a seller account first');
    return profile;
  }

  async onboard(userId: string, dto: OnboardSellerDto) {
    if (await prisma.sellerProfile.findUnique({ where: { userId }, select: { id: true } })) {
      throw new ConflictError('You already have a seller account');
    }
    if (!(await prisma.city.findUnique({ where: { id: dto.cityId }, select: { id: true } }))) {
      throw new BadRequestError('Unknown city');
    }
    const slug = await uniqueSlug(dto.businessName);
    const profile = await prisma.$transaction(async (tx) => {
      const created = await tx.sellerProfile.create({ data: { ...dto, userId, slug }, include: sellerInclude });
      // Buyers become SELLER; providers and admins keep their role (selling rights come from the profile)
      await tx.user.updateMany({ where: { id: userId, role: 'USER' }, data: { role: 'SELLER' } });
      return created;
    });
    return toPrivateSeller(profile);
  }

  async me(userId: string) {
    const profile = await prisma.sellerProfile.findUnique({ where: { userId }, include: sellerInclude });
    if (!profile) throw new NotFoundError('Seller account');
    return toPrivateSeller(profile);
  }

  async updateMe(userId: string, dto: UpdateSellerDto) {
    await this.requireOwnProfile(userId);
    if (dto.cityId && !(await prisma.city.findUnique({ where: { id: dto.cityId }, select: { id: true } }))) {
      throw new BadRequestError('Unknown city');
    }
    const profile = await prisma.sellerProfile.update({ where: { userId }, data: dto, include: sellerInclude });
    return toPrivateSeller(profile);
  }

  /** Public storefront summary. Only approved sellers are visible. */
  async publicProfile(slug: string) {
    const s = await prisma.sellerProfile.findFirst({
      where: { slug, kycStatus: 'APPROVED' },
      include: { ...sellerInclude, _count: { select: { offers: { where: { isActive: true, stockQty: { gt: 0 } } } } } },
    });
    if (!s) throw new NotFoundError('Seller');
    return {
      id: s.id,
      businessName: s.businessName,
      slug: s.slug,
      description: s.description,
      logoUrl: s.logoUrl,
      isFirstParty: s.isFirstParty,
      isRegisteredBusiness: s.kycTier === 'REGISTERED',
      city: s.city,
      slaScore: s.slaScore.toNumber(),
      ratingAvg: s.ratingAvg,
      ratingCount: s.ratingCount,
      activeOffers: s._count.offers,
      memberSince: s.createdAt,
    };
  }

  // ── Admin ──────────────────────────────────────────────

  async list(status: ApprovalStatus | undefined, page: number, limit: number) {
    const where = status ? { kycStatus: status } : {};
    const [rows, total] = await Promise.all([
      prisma.sellerProfile.findMany({
        where,
        include: { ...sellerInclude, user: { select: { email: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.sellerProfile.count({ where }),
    ]);
    return { total, data: rows.map((r) => ({ ...toPrivateSeller(r), ownerEmail: r.user.email })) };
  }

  async setKycStatus(sellerId: string, status: 'APPROVED' | 'REJECTED' | 'SUSPENDED', adminId: string, note?: string) {
    const existing = await prisma.sellerProfile.findUnique({ where: { id: sellerId }, select: { id: true, isFirstParty: true } });
    if (!existing) throw new NotFoundError('Seller');
    if (existing.isFirstParty && status !== 'APPROVED') throw new BadRequestError('The first-party retail account cannot be suspended');

    const profile = await prisma.sellerProfile.update({
      where: { id: sellerId },
      data: {
        kycStatus: status,
        approvedAt: status === 'APPROVED' ? new Date() : null,
        approvedBy: status === 'APPROVED' ? adminId : null,
        rejectionNote: status === 'APPROVED' ? null : note ?? null,
      },
      include: sellerInclude,
    });
    // Approval makes offers eligible; suspension removes them from every Buy Box
    await buyBoxService.recomputeForSeller(sellerId);
    return toPrivateSeller(profile);
  }
}

export const sellersService = new SellersService();
