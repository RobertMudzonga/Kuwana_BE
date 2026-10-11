import prisma from '../../lib/prisma';
import { parsePagination, buildPaginationMeta } from '../../lib/response';
import { authService } from '../auth/auth.service';
import { providersRepository } from '../providers/providers.repository';
import { servicesRepository } from '../services/services.repository';
import { CreateServiceDto } from '../services/services.schema';
import { NotFoundError } from '../../middleware/error.middleware';

export class AdminService {
  async getDashboardStats() {
    const [
      totalUsers,
      totalProviders,
      pendingProviders,
      totalServices,
      totalOrders,
      completedOrders,
      totalRevenue,
    ] = await Promise.all([
      prisma.user.count({ where: { role: 'USER' } }),
      prisma.provider.count(),
      prisma.provider.count({ where: { approvalStatus: 'PENDING' } }),
      prisma.service.count({ where: { isActive: true } }),
      prisma.order.count(),
      prisma.order.count({ where: { status: { in: ['DELIVERED', 'COLLECTED'] } } }),
      prisma.payment.aggregate({
        where: { status: 'SUCCEEDED' },
        _sum: { amount: true },
      }),
    ]);

    // Recent 7-day order trend
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const recentOrders = await prisma.order.count({ where: { createdAt: { gte: sevenDaysAgo } } });
    const recentRevenue = await prisma.payment.aggregate({
      where: { status: 'SUCCEEDED', createdAt: { gte: sevenDaysAgo } },
      _sum: { amount: true },
    });

    return {
      users: { total: totalUsers },
      providers: { total: totalProviders, pending: pendingProviders },
      services: { total: totalServices },
      orders: {
        total: totalOrders,
        completed: completedOrders,
        recentWeek: recentOrders,
      },
      revenue: {
        totalUSD: Number(totalRevenue._sum.amount ?? 0),
        recentWeekUSD: Number(recentRevenue._sum.amount ?? 0),
      },
    };
  }

  async getAuditLogs(opts: { page: number; limit: number; action?: string; actorId?: string }) {
    const skip = (opts.page - 1) * opts.limit;
    const where: Record<string, unknown> = {};
    if (opts.action) where.action = opts.action;
    if (opts.actorId) where.actorId = opts.actorId;

    const [data, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        skip,
        take: opts.limit,
        orderBy: { createdAt: 'desc' },
        include: {
          actor: { select: { email: true, profile: { select: { fullName: true } } } },
        },
      }),
      prisma.auditLog.count({ where }),
    ]);

    return { data, total };
  }

  async createUser(dto: { email: string; phone?: string; password: string; fullName: string; role: 'USER' | 'PROVIDER' | 'DRIVER' }) {
    return authService.createUser(dto);
  }

  async createProvider(dto: {
    email: string;
    phone?: string;
    password: string;
    fullName: string;
    businessName: string;
    description?: string;
    category: string;
    address?: string;
    city?: string;
    website?: string;
    lat?: number;
    lng?: number;
  }) {
    const user = await authService.createUser({
      email: dto.email,
      phone: dto.phone,
      password: dto.password,
      fullName: dto.fullName,
      role: 'PROVIDER',
    });

    const provider = await providersRepository.create(user.id, {
      businessName: dto.businessName,
      description: dto.description,
      category: dto.category as any,
      address: dto.address,
      city: dto.city,
      phone: dto.phone,
      website: dto.website,
      lat: dto.lat,
      lng: dto.lng,
    });

    return { user, provider };
  }

  async createService(dto: CreateServiceDto & { providerId: string }) {
    const provider = await providersRepository.findById(dto.providerId);
    if (!provider) throw new NotFoundError('Provider not found');
    return servicesRepository.create(dto.providerId, dto);
  }

  async setUserStatus(id: string, status: 'ACTIVE' | 'SUSPENDED') {
    return prisma.user.update({ where: { id }, data: { status } });
  }

  async getAllPayments(opts: { skip: number; take: number; status?: string }) {
    const where: Record<string, unknown> = {};
    if (opts.status) where.status = opts.status;
    const [data, total] = await Promise.all([
      prisma.payment.findMany({
        where, skip: opts.skip, take: opts.take,
        orderBy: { createdAt: 'desc' },

      }),
      prisma.payment.count({ where }),
    ]);
    return { data, total };
  }
}

export const adminService = new AdminService();
