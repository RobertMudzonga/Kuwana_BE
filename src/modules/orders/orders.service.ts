import { ordersRepository } from './orders.repository';
import { servicesRepository } from '../services/services.repository';
import { providersRepository } from '../providers/providers.repository';
import { CreateOrderDto, UpdateOrderStatusDto } from './orders.schema';
import { NotFoundError, ForbiddenError, AppError } from '../../middleware/error.middleware';
import { OrderStatus } from '@prisma/client';

export class OrdersService {
  async createOrder(userId: string, dto: CreateOrderDto) {
    const service = await servicesRepository.findById(dto.serviceId);
    if (!service) throw new NotFoundError('Service');
    if (!service.isActive) throw new AppError('This service is no longer available', 400);

    const provider = await providersRepository.findById(service.providerId);
    if (!provider || provider.approvalStatus !== 'APPROVED') {
      throw new AppError('Service provider is not available', 400);
    }
    // Prevent providers ordering their own services
    if (provider.userId === userId) throw new ForbiddenError('Cannot order your own service');

    return ordersRepository.create(
      userId,
      dto.serviceId,
      dto,
      Number(service.price),
      provider.id,
    );
  }

  async getOrder(id: string, userId: string, userRole: string) {
    const order = await ordersRepository.findById(id);
    if (!order) throw new NotFoundError('Order');

    // Users can only see their own orders; providers their own; admins see all
    if (userRole === 'ADMIN') return order;
    if (userRole === 'PROVIDER') {
      const provider = await providersRepository.findByUserId(userId);
      if (!provider || order.providerId !== provider.id) throw new ForbiddenError('Order not found');
    } else {
      if (order.userId !== userId) throw new ForbiddenError('Order not found');
    }
    return order;
  }

  async updateStatus(id: string, dto: UpdateOrderStatusDto, userId: string, userRole: string) {
    const order = await ordersRepository.findById(id);
    if (!order) throw new NotFoundError('Order');

    if (userRole === 'PROVIDER') {
      const provider = await providersRepository.findByUserId(userId);
      if (!provider || order.providerId !== provider.id) throw new ForbiddenError('Not your order');
      if (dto.status === 'CANCELLED' && order.userId !== userId) {
        // Providers can only confirm/progress/complete their orders
        if (!['CONFIRMED', 'IN_PROGRESS', 'COMPLETED'].includes(dto.status)) {
          throw new ForbiddenError('Providers cannot perform this status change');
        }
      }
    } else if (userRole === 'USER') {
      if (order.userId !== userId) throw new ForbiddenError('Not your order');
      if (dto.status !== 'CANCELLED') throw new ForbiddenError('Users can only cancel orders');
      if (!['PENDING'].includes(order.status)) {
        throw new AppError('Order cannot be cancelled at this stage', 400);
      }
    }

    return ordersRepository.updateStatus(id, dto.status as OrderStatus);
  }

  async listOrders(userId: string, userRole: string, opts: { page: number; limit: number; status?: string; role?: string }) {
    const skip = (opts.page - 1) * opts.limit;

    if (userRole === 'ADMIN') {
      return ordersRepository.findAll({ skip, take: opts.limit, status: opts.status });
    }

    if (userRole === 'PROVIDER' && opts.role === 'seller') {
      const provider = await providersRepository.findByUserId(userId);
      if (!provider) throw new NotFoundError('Provider profile');
      return ordersRepository.findManyForProvider(provider.id, { skip, take: opts.limit, status: opts.status });
    }

    return ordersRepository.findManyForUser(userId, { skip, take: opts.limit, status: opts.status });
  }
}

export const ordersService = new OrdersService();
