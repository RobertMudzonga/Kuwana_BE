import { providersRepository } from './providers.repository';
import { OnboardProviderDto, UpdateProviderDto, NearbyQueryDto, ApprovalDto } from './providers.schema';
import { AppError, NotFoundError, ConflictError, ForbiddenError } from '../../middleware/error.middleware';
import prisma from '../../lib/prisma';
import { ApprovalStatus } from '@prisma/client';

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

  async getProvider(id: string) {
    const provider = await providersRepository.findById(id);
    if (!provider) throw new NotFoundError('Provider');
    return provider;
  }

  async getNearby(query: NearbyQueryDto) {
    return providersRepository.findNearby(query);
  }

  async setApproval(id: string, dto: ApprovalDto, adminId: string) {
    const provider = await providersRepository.findById(id);
    if (!provider) throw new NotFoundError('Provider');
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
