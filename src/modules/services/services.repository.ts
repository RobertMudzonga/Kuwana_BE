import { Prisma, ServiceCategory } from '@prisma/client';
import prisma from '../../lib/prisma';
import { CreateServiceDto, UpdateServiceDto, OptionGroupDto } from './services.schema';
import { serviceInclude } from '../../lib/serializers';

type Tx = Prisma.TransactionClient;

/**
 * Replace a service's option groups with `groups`, keeping ids that already belong
 * to this service (so carts and favourites referencing them stay valid).
 */
async function syncOptionGroups(tx: Tx, serviceId: string, groups: OptionGroupDto[]) {
  const existing = await tx.serviceOptionGroup.findMany({ where: { serviceId }, include: { options: true } });
  const existingIds = new Set(existing.map((g) => g.id));
  const keepIds = groups.map((g) => g.id).filter((id): id is string => !!id && existingIds.has(id));
  await tx.serviceOptionGroup.deleteMany({ where: { serviceId, id: { notIn: keepIds } } });

  for (const [groupIndex, group] of groups.entries()) {
    const groupData = { name: group.name, required: group.required, maxSelect: group.maxSelect, sortOrder: groupIndex };
    if (group.id && existingIds.has(group.id)) {
      await tx.serviceOptionGroup.update({ where: { id: group.id }, data: groupData });
      const current = existing.find((g) => g.id === group.id)!;
      const currentOptionIds = new Set(current.options.map((o) => o.id));
      const keepOptionIds = group.options.map((o) => o.id).filter((id): id is string => !!id && currentOptionIds.has(id));
      await tx.serviceOption.deleteMany({ where: { groupId: group.id, id: { notIn: keepOptionIds } } });
      for (const [optionIndex, option] of group.options.entries()) {
        const optionData = { name: option.name, price: option.price, sortOrder: optionIndex };
        if (option.id && currentOptionIds.has(option.id)) {
          await tx.serviceOption.update({ where: { id: option.id }, data: optionData });
        } else {
          await tx.serviceOption.create({ data: { ...optionData, groupId: group.id } });
        }
      }
    } else {
      await tx.serviceOptionGroup.create({
        data: {
          ...groupData,
          serviceId,
          options: { create: group.options.map((o, i) => ({ name: o.name, price: o.price, sortOrder: i })) },
        },
      });
    }
  }
}

export class ServicesRepository {
  async create(providerId: string, dto: CreateServiceDto) {
    return prisma.$transaction(async (tx) => {
      const service = await tx.service.create({
        data: {
          providerId,
          title: dto.title,
          description: dto.description,
          price: dto.price,
          currency: dto.currency,
          unit: dto.unit,
          category: dto.category as ServiceCategory,
          tags: dto.tags,
          imageUrl: dto.imageUrl,
          section: dto.section,
          stock: dto.stock ?? null,
          isAvailable: dto.isAvailable ?? true,
        },
      });
      if (dto.optionGroups?.length) await syncOptionGroups(tx, service.id, dto.optionGroups);
      return tx.service.findUniqueOrThrow({ where: { id: service.id }, include: serviceInclude });
    });
  }

  async findById(id: string) {
    return prisma.service.findUnique({ where: { id }, include: serviceInclude });
  }

  async update(id: string, dto: UpdateServiceDto) {
    return prisma.$transaction(async (tx) => {
      await tx.service.update({
        where: { id },
        data: {
          title: dto.title,
          description: dto.description,
          price: dto.price,
          currency: dto.currency,
          unit: dto.unit,
          category: dto.category as ServiceCategory | undefined,
          tags: dto.tags,
          imageUrl: dto.imageUrl,
          isActive: dto.isActive,
          section: dto.section,
          stock: dto.stock,
          isAvailable: dto.isAvailable,
        },
      });
      if (dto.optionGroups) await syncOptionGroups(tx, id, dto.optionGroups);
      return tx.service.findUniqueOrThrow({ where: { id }, include: serviceInclude });
    });
  }

  async softDelete(id: string) {
    return prisma.service.update({ where: { id }, data: { isActive: false } });
  }

  async findMany(opts: {
    skip: number;
    take: number;
    category?: string;
    providerId?: string;
    search?: string;
    minPrice?: number;
    maxPrice?: number;
    /** false when the seller is viewing their own (possibly unapproved) store */
    approvedOnly?: boolean;
  }) {
    const where: Prisma.ServiceWhereInput = { isActive: true };
    if (opts.approvedOnly !== false) where.provider = { approvalStatus: 'APPROVED' };
    if (opts.category) where.category = opts.category as ServiceCategory;
    if (opts.providerId) where.providerId = opts.providerId;
    if (opts.search) {
      where.OR = [
        { title: { contains: opts.search, mode: 'insensitive' } },
        { description: { contains: opts.search, mode: 'insensitive' } },
        { tags: { has: opts.search } },
        { provider: { businessName: { contains: opts.search, mode: 'insensitive' } } },
      ];
    }
    if (opts.minPrice !== undefined || opts.maxPrice !== undefined) {
      where.price = {
        ...(opts.minPrice !== undefined ? { gte: opts.minPrice } : {}),
        ...(opts.maxPrice !== undefined ? { lte: opts.maxPrice } : {}),
      };
    }

    const [data, total] = await Promise.all([
      prisma.service.findMany({
        where,
        skip: opts.skip,
        take: opts.take,
        orderBy: [{ section: 'asc' }, { createdAt: 'desc' }],
        include: serviceInclude,
      }),
      prisma.service.count({ where }),
    ]);

    return { data, total };
  }
}

export const servicesRepository = new ServicesRepository();
