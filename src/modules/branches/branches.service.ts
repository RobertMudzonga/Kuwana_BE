import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { BadRequestError, NotFoundError } from '../../middleware/error.middleware';
import { DEFAULT_HOURS, isOpenAt, nextOpening, parseHours } from '../../lib/opening-hours';
import { buyBoxService } from '../catalog/buybox.service';
import { CreateBranchDto, UpdateBranchDto } from './branches.schema';

const branchInclude = {
  city: { select: { id: true, name: true, slug: true } },
  suburb: { select: { id: true, name: true } },
  _count: { select: { offers: { where: { isActive: true } } } },
} satisfies Prisma.StoreBranchInclude;

type BranchRow = Prisma.StoreBranchGetPayload<{ include: typeof branchInclude }>;

export function branchDto(b: BranchRow, now = new Date()) {
  const open = b.isActive && !b.isPaused && isOpenAt(b.operatingHours, now);
  return {
    id: b.id,
    code: b.code,
    name: b.name,
    city: b.city,
    suburb: b.suburb,
    address: b.address,
    landmark: b.landmark,
    lat: b.lat,
    lng: b.lng,
    phone: b.phone,
    operatingHours: parseHours(b.operatingHours),
    defaultPrepTimeMins: b.defaultPrepTimeMins,
    isActive: b.isActive,
    isPaused: b.isPaused,
    isOpenNow: open,
    opensAt: open || !b.isActive ? null : nextOpening(b.operatingHours, now),
    activeOfferCount: b._count.offers,
    createdAt: b.createdAt,
  };
}

/** e.g. "Harare Gadget Hub" + "Avondale" → HGH-AVO; a numeric suffix keeps it unique */
function codeBase(storeName: string, place: string) {
  const initials = storeName.split(/\s+/).filter(Boolean).map((w) => w[0]).join('').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) || 'STR';
  const loc = place.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) || 'BR';
  return `${initials}-${loc}`;
}

export class BranchesService {
  private async validateLocation(cityId: string, suburbId: string | null | undefined) {
    const city = await prisma.city.findUnique({ where: { id: cityId }, select: { id: true, name: true } });
    if (!city) throw new BadRequestError('Unknown city');
    if (suburbId) {
      const suburb = await prisma.suburb.findUnique({ where: { id: suburbId }, select: { cityId: true, name: true } });
      if (!suburb || suburb.cityId !== cityId) throw new BadRequestError('That suburb is not in the selected city');
      return { city, suburb };
    }
    return { city, suburb: null };
  }

  private async owned(sellerId: string, branchId: string) {
    const b = await prisma.storeBranch.findUnique({ where: { id: branchId }, select: { sellerId: true, cityId: true, lat: true, lng: true } });
    if (!b || b.sellerId !== sellerId) throw new NotFoundError('Branch');
    return b;
  }

  async list(sellerId: string) {
    const rows = await prisma.storeBranch.findMany({ where: { sellerId }, include: branchInclude, orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }] });
    const now = new Date();
    return rows.map((r) => branchDto(r, now));
  }

  async get(sellerId: string, branchId: string) {
    await this.owned(sellerId, branchId);
    return branchDto(await prisma.storeBranch.findUniqueOrThrow({ where: { id: branchId }, include: branchInclude }));
  }

  async create(sellerId: string, dto: CreateBranchDto) {
    const { city, suburb } = await this.validateLocation(dto.cityId, dto.suburbId);
    const seller = await prisma.sellerProfile.findUniqueOrThrow({ where: { id: sellerId }, select: { businessName: true } });
    const base = codeBase(seller.businessName, suburb?.name ?? city.name);
    const taken = new Set((await prisma.storeBranch.findMany({ where: { code: { startsWith: base } }, select: { code: true } })).map((r) => r.code));
    let code = base;
    for (let i = 2; taken.has(code); i++) code = `${base}${i}`;

    const created = await prisma.storeBranch.create({
      data: {
        sellerId,
        code,
        name: dto.name,
        cityId: dto.cityId,
        suburbId: dto.suburbId ?? null,
        address: dto.address,
        landmark: dto.landmark,
        lat: dto.lat,
        lng: dto.lng,
        phone: dto.phone,
        operatingHours: (dto.operatingHours ?? DEFAULT_HOURS) as Prisma.InputJsonValue,
        defaultPrepTimeMins: dto.defaultPrepTimeMins ?? 30,
      },
      include: branchInclude,
    });
    return branchDto(created);
  }

  async update(sellerId: string, branchId: string, dto: UpdateBranchDto) {
    const existing = await this.owned(sellerId, branchId);
    if (dto.cityId || dto.suburbId) await this.validateLocation(dto.cityId ?? existing.cityId, dto.suburbId);
    if (dto.cityId && dto.cityId !== existing.cityId && dto.suburbId === undefined) {
      // A suburb from the old city would no longer make sense
      dto.suburbId = null;
    }

    const { operatingHours, ...rest } = dto;
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.storeBranch.update({
        where: { id: branchId },
        data: {
          ...rest,
          ...(operatingHours ? { operatingHours: operatingHours as Prisma.InputJsonValue } : {}),
          // A moved pin needs checking again
          ...((rest.lat !== undefined && rest.lat !== existing.lat) || (rest.lng !== undefined && rest.lng !== existing.lng) ? { locationVerifiedAt: null } : {}),
        },
        include: branchInclude,
      });
      // Offers inherit the branch's city for legacy dispatch-city filters
      if (dto.cityId) await tx.offer.updateMany({ where: { storeBranchId: branchId }, data: { dispatchCityId: dto.cityId } });
      return row;
    });

    if (dto.isActive !== undefined || dto.isPaused !== undefined || dto.cityId || dto.lat !== undefined) {
      await buyBoxService.recomputeForBranch(branchId);
    }
    return branchDto(updated);
  }
}

export const branchesService = new BranchesService();
