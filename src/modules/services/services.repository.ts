import prisma from '../../lib/prisma';
import { CreateServiceDto, UpdateServiceDto } from './services.schema';
import { ServiceCategory } from '@prisma/client';

export class ServicesRepository {
  async create(providerId: string, dto: CreateServiceDto) {
    return prisma.service.create({
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
      },
    });
  }

  async findById(id: string) {
    return prisma.service.findUnique({
      where: { id },
      include: { provider: { select: { id: true, businessName: true, city: true, rating: true } } },
    });
  }

  async update(id: string, dto: UpdateServiceDto) {
    return prisma.service.update({
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
      },
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
  }) {
    const where: Record<string, unknown> = { isActive: true };
    if (opts.category) where.category = opts.category;
    if (opts.providerId) where.providerId = opts.providerId;
    if (opts.search) {
      where.OR = [
        { title: { contains: opts.search, mode: 'insensitive' } },
        { description: { contains: opts.search, mode: 'insensitive' } },
        { tags: { has: opts.search } },
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
        orderBy: { createdAt: 'desc' },
        include: {
          provider: {
            select: { id: true, businessName: true, city: true, rating: true, logoUrl: true },
          },
        },
      }),
      prisma.service.count({ where }),
    ]);

    return { data, total };
  }
}

export const servicesRepository = new ServicesRepository();
