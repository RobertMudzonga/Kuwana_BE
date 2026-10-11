import { v4 as uuidv4 } from 'uuid';
import { OrderStatus, Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { CONSTANTS } from '../../config/constants';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { NotFoundError, ForbiddenError, BadRequestError, ConflictError } from '../../middleware/error.middleware';
import { orderInclude, toOrderDto } from '../../lib/serializers';
import { buildQuote, fromCents } from '../checkout/pricing';
import { paymentsService, PaymentSummary } from '../payments/payments.service';
import { providersRepository } from '../providers/providers.repository';
import { CheckoutDto, UpdateOrderStatusDto } from './orders.schema';
import { ACTIVE_STATUSES, applyTransition, generateReference, loadOrder, notifyStatusChange } from './order-lifecycle';

type Actor = { sub: string; role: string };

/** What a seller may do next from each status */
const SELLER_TRANSITIONS: Partial<Record<OrderStatus, OrderStatus[]>> = {
  PLACED: ['ACCEPTED', 'REJECTED'],
  ACCEPTED: ['PREPARING'],
  PREPARING: ['READY'],
  READY: ['COLLECTED', 'OUT_FOR_DELIVERY'],
  OUT_FOR_DELIVERY: ['DELIVERED'],
};

class StockConflict extends Error {}

export class OrdersService {
  async quote(userId: string, dto: CheckoutDto) {
    const { quote } = await buildQuote(prisma, userId, dto);
    return quote;
  }

  /**
   * Place a checkout: re-prices everything, reserves stock atomically, creates one order
   * per vendor, then starts payment (or releases cash orders to sellers immediately).
   */
  async placeOrder(userId: string, dto: CheckoutDto) {
    if (!paymentsService.supportsMethod(dto.paymentMethod)) {
      throw new BadRequestError('That payment method is not available right now. Choose another.');
    }
    if ((dto.paymentMethod === 'ECOCASH' || dto.paymentMethod === 'ONEMONEY') && !dto.paymentPhone) {
      throw new BadRequestError('Enter the mobile money number to charge');
    }
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user?.phoneVerified) {
      throw new BadRequestError('Verify your phone number before placing an order');
    }

    const checkoutRef = uuidv4();
    const isCash = dto.paymentMethod === 'CASH';

    let orderIds: string[];
    try {
      orderIds = await prisma.$transaction(async (tx) => {
        const { quote, plan } = await buildQuote(tx, userId, dto);
        if (quote.errors.length) throw new BadRequestError(quote.errors.join('\n'));

        // Reserve stock: conditional decrement fails if someone else just bought the last units
        for (const [serviceId, need] of plan.stockNeeded) {
          const { count } = await tx.service.updateMany({
            where: { id: serviceId, stock: { gte: need.quantity } },
            data: { stock: { decrement: need.quantity } },
          });
          if (count === 0) throw new StockConflict(`${need.title} just sold out. Update your cart and try again.`);
        }
        if (plan.promoCode) {
          const promo = await tx.promoCode.findUniqueOrThrow({ where: { code: plan.promoCode } });
          const { count } = await tx.promoCode.updateMany({
            where: { id: promo.id, ...(promo.maxUses !== null ? { usedCount: { lt: promo.maxUses } } : {}) },
            data: { usedCount: { increment: 1 } },
          });
          if (count === 0) throw new StockConflict('That promo code has just been fully used. Remove it and try again.');
        }

        const ids: string[] = [];
        for (const vendor of plan.vendors) {
          const total = fromCents(vendor.totalCents);
          const order = await tx.order.create({
            data: {
              reference: generateReference(),
              checkoutRef,
              userId,
              providerId: vendor.providerId,
              status: isCash ? 'PLACED' : 'PENDING_PAYMENT',
              fulfilment: dto.fulfilment,
              currency: plan.currency,
              subtotal: fromCents(vendor.subtotalCents),
              deliveryFee: fromCents(vendor.deliveryFeeCents),
              serviceFee: fromCents(vendor.serviceFeeCents),
              tax: fromCents(vendor.taxCents),
              discount: fromCents(vendor.discountCents),
              totalAmount: total,
              commission: fromCents(vendor.commissionCents),
              zigAmount: plan.currency === 'USD' ? total / CONSTANTS.ZIG_TO_USD_RATE : undefined,
              paymentMethod: dto.paymentMethod,
              paymentPhone: dto.paymentPhone,
              promoCode: plan.promoCode,
              address: plan.address ?? Prisma.JsonNull,
              notes: dto.notes?.trim() || undefined,
              scheduledAt: plan.scheduledAt,
              items: {
                create: vendor.lines.map((l) => ({
                  serviceId: l.serviceId,
                  title: l.title,
                  imageUrl: l.imageUrl,
                  unitPrice: fromCents(l.unitPriceCents),
                  quantity: l.quantity,
                  options: l.options,
                  notes: l.notes,
                })),
              },
              statusHistory: { create: { status: isCash ? 'PLACED' : 'PENDING_PAYMENT', actorId: userId } },
            },
          });
          ids.push(order.id);
        }
        return ids;
      });
    } catch (err) {
      if (err instanceof StockConflict) throw new ConflictError(err.message);
      throw err;
    }

    let payment: PaymentSummary | undefined;
    if (isCash) {
      await Promise.all(orderIds.map((id) => notifyStatusChange(id, 'PLACED')));
    } else {
      try {
        payment = await paymentsService.startCheckoutPayment(checkoutRef, dto.paymentMethod, dto.paymentPhone, userId);
      } catch (err) {
        // Orders exist and keep their stock while the customer retries payment from the order screen
        logger.warn('Checkout payment failed to start', { checkoutRef, err: (err as Error).message });
        payment = { id: checkoutRef, status: 'FAILED', instructions: (err as Error).message };
      }
    }

    const orders = await prisma.order.findMany({ where: { id: { in: orderIds } }, include: orderInclude });
    return { orders: orders.map(toOrderDto), payment };
  }

  private async assertCanView(order: { userId: string; providerId: string; delivery: { driverId: string | null } | null }, actor: Actor) {
    if (actor.role === 'ADMIN' || order.userId === actor.sub) return;
    if (order.delivery?.driverId === actor.sub) return;
    if (actor.role === 'PROVIDER') {
      const provider = await providersRepository.findByUserId(actor.sub);
      if (provider?.id === order.providerId) return;
    }
    throw new NotFoundError('Order');
  }

  async getOrder(id: string, actor: Actor) {
    let order = await loadOrder(id);
    if (!order) throw new NotFoundError('Order');
    await this.assertCanView(order, actor);

    // If we're still waiting on a gateway callback, ask the gateway directly
    if (order.status === 'PENDING_PAYMENT' && order.paymentStatus === 'PENDING') {
      await paymentsService.pollPendingPayment(order.checkoutRef);
      order = (await loadOrder(id))!;
    }
    return toOrderDto(order);
  }

  async listOrders(actor: Actor, opts: { page: number; limit: number; status?: OrderStatus[]; as: 'buyer' | 'seller' }) {
    const where: Prisma.OrderWhereInput = {};
    if (opts.as === 'seller') {
      const provider = await providersRepository.findByUserId(actor.sub);
      if (!provider) throw new NotFoundError('Provider profile');
      where.providerId = provider.id;
      // Sellers never see orders that haven't been paid yet
      where.status = { not: 'PENDING_PAYMENT' };
    } else {
      where.userId = actor.sub;
    }
    if (opts.status?.length) {
      where.status = opts.as === 'seller'
        ? { in: opts.status.filter((s) => s !== 'PENDING_PAYMENT') }
        : { in: opts.status };
    }
    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        include: orderInclude,
        orderBy: { createdAt: 'desc' },
        skip: (opts.page - 1) * opts.limit,
        take: opts.limit,
      }),
      prisma.order.count({ where }),
    ]);
    return { data: orders.map(toOrderDto), total };
  }

  async cancelByBuyer(id: string, userId: string, reason?: string) {
    const order = await prisma.order.findUnique({ where: { id } });
    if (!order || order.userId !== userId) throw new NotFoundError('Order');
    if (!['PENDING_PAYMENT', 'PLACED'].includes(order.status)) {
      throw new BadRequestError('This order can no longer be cancelled. Contact the seller.');
    }
    return this.transition(order.id, 'CANCELLED', { sub: userId, role: 'USER' }, reason ?? 'Cancelled by customer');
  }

  async updateStatus(id: string, dto: UpdateOrderStatusDto, actor: Actor) {
    const order = await prisma.order.findUnique({ where: { id }, include: { delivery: true } });
    if (!order) throw new NotFoundError('Order');

    if (actor.role === 'ADMIN') {
      // Admins can cancel any active order; other changes follow the seller rules
      if (dto.status === 'CANCELLED') {
        if (!ACTIVE_STATUSES.includes(order.status)) throw new BadRequestError('Only active orders can be cancelled');
        return this.transition(id, 'CANCELLED', actor, dto.reason ?? 'Cancelled by Kuwana support');
      }
    } else {
      const provider = await providersRepository.findByUserId(actor.sub);
      if (!provider || provider.id !== order.providerId) {
        if (order.userId === actor.sub && dto.status === 'CANCELLED') return this.cancelByBuyer(id, actor.sub, dto.reason);
        throw new ForbiddenError('You can only update orders for your own store');
      }
    }

    const allowed = SELLER_TRANSITIONS[order.status] ?? [];
    if (!allowed.includes(dto.status)) {
      throw new BadRequestError(`An order that is ${order.status.toLowerCase().replace(/_/g, ' ')} can't be moved to ${dto.status.toLowerCase().replace(/_/g, ' ')}`);
    }
    if (dto.status === 'COLLECTED' && order.fulfilment !== 'COLLECTION') throw new BadRequestError('This is a delivery order');
    if (dto.status === 'OUT_FOR_DELIVERY') {
      if (order.fulfilment !== 'DELIVERY') throw new BadRequestError('This is a collection order');
      if (order.delivery?.driverId) throw new BadRequestError('A Kuwana driver is handling this delivery');
    }
    if (dto.status === 'DELIVERED' && order.delivery?.driverId && order.delivery.status !== 'SELF_DELIVERED') {
      throw new BadRequestError('The driver confirms delivery for this order');
    }
    return this.transition(id, dto.status, actor, dto.reason);
  }

  /** Apply a validated transition, then notify and refund if needed */
  private async transition(id: string, to: OrderStatus, actor: Actor, reason?: string) {
    await prisma.$transaction((tx) => applyTransition(tx, id, to, { actorId: actor.sub, reason }));
    await notifyStatusChange(id, to);

    const order = await prisma.order.findUniqueOrThrow({ where: { id } });
    if ((to === 'CANCELLED' || to === 'REJECTED') && order.paymentStatus === 'PAID') {
      try {
        const refund = await paymentsService.refundOrder(id, { reason: reason ?? to.toLowerCase(), actorId: actor.sub });
        if (refund.manual) logger.warn('Cancelled paid order needs a manual refund', { orderId: id });
      } catch (err) {
        // Leave it PAID so it shows up for an admin to refund
        logger.error('Automatic refund failed', { orderId: id, err: (err as Error).message });
      }
    }
    return toOrderDto((await loadOrder(id))!);
  }

  /** Cancel checkouts that were never paid and release their stock. Run on a timer. */
  async expireUnpaidOrders() {
    const cutoff = new Date(Date.now() - env.PENDING_PAYMENT_TIMEOUT_MINUTES * 60 * 1000);
    const stale = await prisma.order.findMany({
      where: { status: 'PENDING_PAYMENT', createdAt: { lt: cutoff } },
      select: { id: true, checkoutRef: true },
    });
    // Give the gateway one last chance to report a payment before expiring
    for (const ref of new Set(stale.map((o) => o.checkoutRef))) await paymentsService.pollPendingPayment(ref);

    for (const { id } of stale) {
      try {
        const changed = await prisma.$transaction(async (tx) => {
          const current = await tx.order.findUnique({ where: { id } });
          if (current?.status !== 'PENDING_PAYMENT') return false;
          await applyTransition(tx, id, 'CANCELLED', { reason: 'Payment was not completed in time' });
          return true;
        });
        if (changed) await notifyStatusChange(id, 'CANCELLED');
      } catch (err) {
        logger.warn('Failed to expire unpaid order', { id, err: (err as Error).message });
      }
    }
    return stale.length;
  }
}

export const ordersService = new OrdersService();
