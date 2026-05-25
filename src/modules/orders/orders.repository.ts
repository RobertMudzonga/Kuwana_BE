import prisma from '../../lib/prisma';
import { CreateOrderDto, UpdateOrderStatusDto } from './orders.schema';
import { OrderStatus } from '@prisma/client';
import { CONSTANTS } from '../../config/constants';

export class OrdersRepository {
  async create(userId: string, serviceId: string, dto: CreateOrderDto, unitPrice: number, providerId: string) {
    const totalAmount = unitPrice * dto.quantity;
    const zigAmount = totalAmount / CONSTANTS.ZIG_TO_USD_RATE;

    return prisma.order.create({
      data: {
        userId,
        providerId,
        serviceId,
        quantity: dto.quantity,
        unitPrice,
        totalAmount,
        zigAmount,
        currency: 'USD',
        notes: dto.notes,
        scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : undefined,
      },
      include: {
        service: { select: { title: true, unit: true } },
        provider: { select: { businessName: true } },
      },
    });
  }

  async findById(id: string) {
    return prisma.order.findUnique({
      where: { id },
      include: {
        service: true,
        provider: { select: { id: true, businessName: true, phone: true } },
        user: { select: { id: true, email: true, profile: { select: { fullName: true } } } },
        payment: true,
        review: true,
      },
    });
  }

  async updateStatus(id: string, status: OrderStatus) {
    const data: Record<string, unknown> = { status };
    if (status === 'COMPLETED') data.completedAt = new Date();
    if (status === 'CANCELLED') data.cancelledAt = new Date();
    return prisma.order.update({ where: { id }, data });
  }

  async findManyForUser(userId: string, opts: { skip: number; take: number; status?: string }) {
    const where: Record<string, unknown> = { userId };
    if (opts.status) where.status = opts.status;
    const [data, total] = await Promise.all([
      prisma.order.findMany({
        where, skip: opts.skip, take: opts.take,
        orderBy: { createdAt: 'desc' },
        include: { service: { select: { title: true } }, provider: { select: { businessName: true } }, payment: { select: { status: true } } },
      }),
      prisma.order.count({ where }),
    ]);
    return { data, total };
  }

  async findManyForProvider(providerId: string, opts: { skip: number; take: number; status?: string }) {
    const where: Record<string, unknown> = { providerId };
    if (opts.status) where.status = opts.status;
    const [data, total] = await Promise.all([
      prisma.order.findMany({
        where, skip: opts.skip, take: opts.take,
        orderBy: { createdAt: 'desc' },
        include: { service: { select: { title: true } }, user: { select: { email: true, profile: { select: { fullName: true } } } }, payment: { select: { status: true } } },
      }),
      prisma.order.count({ where }),
    ]);
    return { data, total };
  }

  async findAll(opts: { skip: number; take: number; status?: string }) {
    const where: Record<string, unknown> = {};
    if (opts.status) where.status = opts.status;
    const [data, total] = await Promise.all([
      prisma.order.findMany({ where, skip: opts.skip, take: opts.take, orderBy: { createdAt: 'desc' } }),
      prisma.order.count({ where }),
    ]);
    return { data, total };
  }
}

export const ordersRepository = new OrdersRepository();
