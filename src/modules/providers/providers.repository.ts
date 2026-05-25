import prisma from '../../lib/prisma';
import { kmToMetres } from '../../lib/geo';
import { OnboardProviderDto, UpdateProviderDto, NearbyQueryDto } from './providers.schema';
import { ApprovalStatus, ServiceCategory } from '@prisma/client';

export class ProvidersRepository {
  async create(userId: string, dto: OnboardProviderDto) {
    const provider = await prisma.provider.create({
      data: {
        userId,
        businessName: dto.businessName,
        description: dto.description,
        category: dto.category as ServiceCategory,
        address: dto.address,
        city: dto.city,
        phone: dto.phone,
        website: dto.website,
        lat: dto.lat,
        lng: dto.lng,
      },
      include: { user: { select: { email: true } } },
    });

    // Update PostGIS geometry column if coordinates provided
    if (dto.lat && dto.lng) {
      await this.updateGeom(provider.id, dto.lat, dto.lng);
    }

    return provider;
  }

  async findByUserId(userId: string) {
    return prisma.provider.findUnique({
      where: { userId },
      include: { services: { where: { isActive: true } } },
    });
  }

  async findById(id: string) {
    return prisma.provider.findUnique({
      where: { id },
      include: {
        services: { where: { isActive: true } },
        user: { select: { email: true, phone: true } },
      },
    });
  }

  async update(id: string, dto: UpdateProviderDto) {
    const provider = await prisma.provider.update({
      where: { id },
      data: {
        businessName: dto.businessName,
        description: dto.description,
        category: dto.category as ServiceCategory | undefined,
        address: dto.address,
        city: dto.city,
        phone: dto.phone,
        website: dto.website,
        lat: dto.lat,
        lng: dto.lng,
      },
    });
    if (dto.lat && dto.lng) {
      await this.updateGeom(id, dto.lat, dto.lng);
    }
    return provider;
  }

  async updateApproval(id: string, status: ApprovalStatus, approvedBy: string, rejectionNote?: string) {
    return prisma.provider.update({
      where: { id },
      data: {
        approvalStatus: status,
        approvedBy,
        approvedAt: status === 'APPROVED' ? new Date() : undefined,
        rejectionNote: rejectionNote ?? null,
      },
    });
  }

  /**
   * PostGIS-powered proximity search.
   * Returns providers within radiusKm of (lat, lng), sorted by distance.
   */
  async findNearby(query: NearbyQueryDto) {
    const radiusMetres = kmToMetres(query.radiusKm);
    const offset = (query.page - 1) * query.limit;

    const categoryFilter = query.category ? `AND p.category = '${query.category}'` : '';

    // Raw SQL using PostGIS ST_DWithin and ST_Distance
    const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `
      SELECT
        p.id, p.business_name, p.description, p.category, p.city, p.lat, p.lng,
        p.rating, p.review_count, p.logo_url, p.approval_status, p.is_verified,
        ROUND(ST_Distance(
          p.geom,
          ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography
        )::numeric / 1000, 2) AS distance_km
      FROM providers p
      WHERE
        p.approval_status = 'APPROVED'
        AND p.geom IS NOT NULL
        AND ST_DWithin(
          p.geom,
          ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
          $3
        )
        ${categoryFilter}
      ORDER BY distance_km ASC
      LIMIT $4 OFFSET $5
      `,
      query.lat,
      query.lng,
      radiusMetres,
      query.limit,
      offset,
    );

    const countRows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `
      SELECT COUNT(*) AS count
      FROM providers p
      WHERE
        p.approval_status = 'APPROVED'
        AND p.geom IS NOT NULL
        AND ST_DWithin(
          p.geom,
          ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
          $3
        )
        ${categoryFilter}
      `,
      query.lat,
      query.lng,
      radiusMetres,
    );

    return {
      data: rows,
      total: Number(countRows[0]?.count ?? 0),
    };
  }

  async findMany(opts: { skip: number; take: number; approvalStatus?: string; category?: string; search?: string }) {
    const where: Record<string, unknown> = {};
    if (opts.approvalStatus) where.approvalStatus = opts.approvalStatus;
    if (opts.category) where.category = opts.category;
    if (opts.search) {
      where.OR = [
        { businessName: { contains: opts.search, mode: 'insensitive' } },
        { city: { contains: opts.search, mode: 'insensitive' } },
      ];
    }
    const [data, total] = await Promise.all([
      prisma.provider.findMany({ where, skip: opts.skip, take: opts.take, orderBy: { createdAt: 'desc' } }),
      prisma.provider.count({ where }),
    ]);
    return { data, total };
  }

  private async updateGeom(providerId: string, lat: number, lng: number) {
    await prisma.$executeRawUnsafe(
      `UPDATE providers SET geom = ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography WHERE id = $3`,
      lat,
      lng,
      providerId,
    );
  }
}

export const providersRepository = new ProvidersRepository();
