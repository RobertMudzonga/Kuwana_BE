import { providersRepository } from './providers.repository';
import { OnboardProviderDto, UpdateProviderDto, NearbyQueryDto, ApprovalDto } from './providers.schema';
import { AppError, NotFoundError, ConflictError, ForbiddenError } from '../../middleware/error.middleware';
import prisma from '../../lib/prisma';
import { ApprovalStatus, OrderStatus } from '@prisma/client';

export class ProvidersService {
  async onboard(userId: string, dto: OnboardProviderDto) {
    // Ensure user hasn't already onboarded
    const existing = await providersRepository.findByUserId(userId);
    if (existing) throw new ConflictError('Provider profile already exists for this account');

    // Update user role to PROVIDER
    await prisma.user.update({ where: { id: userId }, data: { role: 'PROVIDER' } });

    return providersRepository.create(userId, dto);
  }

  async getMyProvider(userId: string) {
    const provider = await providersRepository.findByUserId(userId);
    if (!provider) throw new NotFoundError('Provider profile');
    return provider;
  }

  async updateMyProvider(userId: string, dto: UpdateProviderDto) {
    const provider = await providersRepository.findByUserId(userId);
    if (!provider) throw new NotFoundError('Provider profile');
    return providersRepository.update(provider.id, dto);
  }

  async getProvider(id: string, viewer?: { sub: string; role: string }) {
    const provider = await providersRepository.findPublicById(id);
    if (!provider) throw new NotFoundError('Provider');
    // Unapproved stores are only visible to their owner and admins
    if (provider.approvalStatus !== 'APPROVED' && viewer?.role !== 'ADMIN') {
      const own = viewer ? await providersRepository.findByUserId(viewer.sub) : null;
      if (own?.id !== id) throw new NotFoundError('Provider');
    }
    return provider;
  }

  async getMyStats(userId: string) {
    const provider = await providersRepository.findByUserId(userId);
    if (!provider) throw new NotFoundError('Provider profile');

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const startOfMonth = new Date(startOfDay.getFullYear(), startOfDay.getMonth(), 1);
    // Revenue counts orders the seller has accepted and not cancelled/refunded
    const earning = { in: ['ACCEPTED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY', 'DELIVERED', 'COLLECTED'] as OrderStatus[] };

    const [today, month, pendingOrders] = await Promise.all([
      prisma.order.aggregate({
        where: { providerId: provider.id, status: earning, createdAt: { gte: startOfDay } },
        _sum: { subtotal: true },
        _count: true,
      }),
      prisma.order.aggregate({
        where: { providerId: provider.id, status: earning, createdAt: { gte: startOfMonth } },
        _sum: { subtotal: true },
      }),
      prisma.order.count({ where: { providerId: provider.id, status: 'PLACED' } }),
    ]);

    return {
      ordersToday: today._count,
      revenueToday: Number(today._sum.subtotal ?? 0),
      revenueMonth: Number(month._sum.subtotal ?? 0),
      pendingOrders,
      currency: 'USD',
    };
  }

  async getNearby(query: NearbyQueryDto) {
    return providersRepository.findNearby(query);
  }

  async setApproval(id: string, dto: ApprovalDto, adminId: string) {
    const provider = await providersRepository.findById(id);
    if (!provider) throw new NotFoundError('Provider');
    if (dto.status === 'APPROVED') {
      await prisma.provider.update({ where: { id }, data: { isVerified: true } });
    }
    return providersRepository.updateApproval(
      id,
      dto.status as ApprovalStatus,
      adminId,
      dto.rejectionNote,
    );
  }

  async listProviders(opts: {
    page: number;
    limit: number;
    approvalStatus?: string;
    category?: string;
    search?: string;
  }) {
    const skip = (opts.page - 1) * opts.limit;
    return providersRepository.findMany({ skip, take: opts.limit, ...opts });
  }
}

export const providersService = new ProvidersService();
