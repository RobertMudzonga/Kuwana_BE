import { servicesRepository } from './services.repository';
import { CreateServiceDto, UpdateServiceDto } from './services.schema';
import { NotFoundError, ForbiddenError } from '../../middleware/error.middleware';
import { providersRepository } from '../providers/providers.repository';

export class ServicesService {
  async create(userId: string, dto: CreateServiceDto) {
    const provider = await providersRepository.findByUserId(userId);
    if (!provider) throw new ForbiddenError('Provider profile not found. Please onboard first.');
    if (provider.approvalStatus !== 'APPROVED') {
      throw new ForbiddenError('Your provider account is pending approval.');
    }
    return servicesRepository.create(provider.id, dto);
  }

  async getService(id: string) {
    const service = await servicesRepository.findById(id);
    if (!service || !service.isActive) throw new NotFoundError('Service');
    return service;
  }

  async updateService(id: string, userId: string, dto: UpdateServiceDto, role?: string) {
    const service = await servicesRepository.findById(id);
    if (!service) throw new NotFoundError('Service');
    if (role === 'ADMIN') return servicesRepository.update(id, dto);
    const provider = await providersRepository.findByUserId(userId);
    if (!provider || service.providerId !== provider.id) {
      throw new ForbiddenError('You do not own this service listing');
    }
    return servicesRepository.update(id, dto);
  }

  async deleteService(id: string, userId: string, role?: string) {
    const service = await servicesRepository.findById(id);
    if (!service) throw new NotFoundError('Service');
    if (role === 'ADMIN') return servicesRepository.softDelete(id);
    const provider = await providersRepository.findByUserId(userId);
    if (!provider || service.providerId !== provider.id) {
      throw new ForbiddenError('You do not own this service listing');
    }
    return servicesRepository.softDelete(id);
  }

  async listServices(opts: {
    page: number;
    limit: number;
    category?: string;
    providerId?: string;
    search?: string;
    minPrice?: number;
    maxPrice?: number;
    viewer?: { sub: string; role: string };
  }) {
    const skip = (opts.page - 1) * opts.limit;
    // Sellers see their own listings even before approval; admins see everything
    let approvedOnly = opts.viewer?.role !== 'ADMIN';
    if (approvedOnly && opts.providerId && opts.viewer) {
      const own = await providersRepository.findByUserId(opts.viewer.sub);
      if (own?.id === opts.providerId) approvedOnly = false;
    }
    return servicesRepository.findMany({ skip, take: opts.limit, ...opts, approvedOnly });
  }
}

export const servicesService = new ServicesService();
