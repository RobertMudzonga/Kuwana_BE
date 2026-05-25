import { env } from '../../config/env';
import { IPaymentGateway } from './payment.gateway.interface';
import { StripeGateway } from './stripe.gateway';
import { PaynowGateway } from './paynow.gateway';
import prisma from '../../lib/prisma';
import { ordersRepository } from '../orders/orders.repository';
import { NotFoundError, AppError } from '../../middleware/error.middleware';
import { PaymentGateway, PaymentStatus } from '@prisma/client';

// Gateway factory — resolves at runtime based on env
function createGateway(): IPaymentGateway {
  if (env.ACTIVE_PAYMENT_GATEWAY === 'paynow') return new PaynowGateway();
  return new StripeGateway();
}

export class PaymentsService {
  private gateway: IPaymentGateway;

  constructor() {
    this.gateway = createGateway();
  }

  async initiatePayment(orderId: string, userId: string) {
    const order = await ordersRepository.findById(orderId);
    if (!order) throw new NotFoundError('Order');
    if (order.userId !== userId) throw new AppError('Not your order', 403);
    if (order.payment) throw new AppError('Payment already initiated for this order', 409);
    if (order.status === 'CANCELLED') throw new AppError('Cannot pay for a cancelled order', 400);

    const result = await this.gateway.initiatePayment({
      orderId: order.id,
      amount: Number(order.totalAmount),
      currency: order.currency.toLowerCase(),
      description: `Sosa Connect — ${order.service.title}`,
      customerEmail: order.user.email,
      metadata: { providerId: order.providerId },
    });

    // Persist payment record
    const payment = await prisma.payment.create({
      data: {
        orderId: order.id,
        gateway: env.ACTIVE_PAYMENT_GATEWAY.toUpperCase() as PaymentGateway,
        gatewayRef: result.gatewayRef,
        amount: order.totalAmount,
        currency: order.currency,
        status: 'PROCESSING',
        metadata: result as any,
      },
    });

    return {
      paymentId: payment.id,
      clientSecret: result.clientSecret,
      redirectUrl: result.redirectUrl,
      gatewayRef: result.gatewayRef,
      amount: order.totalAmount,
      currency: order.currency,
    };
  }

  async handleWebhook(rawBody: Buffer, signature: string) {
    const result = await this.gateway.handleWebhookEvent(rawBody, signature);
    if (!result) return; // Unhandled event type — OK

    const payment = await prisma.payment.findFirst({
      where: { gatewayRef: result.gatewayRef },
    });
    if (!payment) return; // Unknown ref — ignore

    const newStatus: PaymentStatus = result.status === 'succeeded'
      ? 'SUCCEEDED'
      : result.status === 'failed'
        ? 'FAILED'
        : 'PENDING';

    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: newStatus,
        receiptUrl: result.receiptUrl ?? null,
        failureCode: result.failureCode ?? null,
        metadata: result.rawEvent as any,
      },
    });

    // If succeeded, mark order as confirmed
    if (newStatus === 'SUCCEEDED') {
      await prisma.order.update({
        where: { id: payment.orderId },
        data: { status: 'CONFIRMED' },
      });
    }
  }

  async getTransaction(id: string, userId: string, userRole: string) {
    const payment = await prisma.payment.findUnique({
      where: { id },
      include: { order: { select: { userId: true, providerId: true } } },
    });
    if (!payment) throw new NotFoundError('Transaction');

    if (userRole !== 'ADMIN' && payment.order.userId !== userId) {
      throw new AppError('Access denied', 403);
    }
    return payment;
  }

  async listTransactions(userId: string, userRole: string, opts: { skip: number; take: number }) {
    const where = userRole === 'ADMIN'
      ? {}
      : { order: { userId } };

    const [data, total] = await Promise.all([
      prisma.payment.findMany({
        where,
        skip: opts.skip,
        take: opts.take,
        orderBy: { createdAt: 'desc' },
        include: { order: { select: { id: true, service: { select: { title: true } } } } },
      }),
      prisma.payment.count({ where }),
    ]);

    return { data, total };
  }

  async refundPayment(paymentId: string, adminId: string) {
    const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new NotFoundError('Payment');
    if (payment.status !== 'SUCCEEDED') throw new AppError('Only succeeded payments can be refunded', 400);
    if (!payment.gatewayRef) throw new AppError('No gateway reference for this payment', 400);

    const result = await this.gateway.refund({ gatewayRef: payment.gatewayRef });

    await prisma.payment.update({
      where: { id: paymentId },
      data: { status: 'REFUNDED', refundedAt: new Date() },
    });

    return result;
  }
}

export const paymentsService = new PaymentsService();
