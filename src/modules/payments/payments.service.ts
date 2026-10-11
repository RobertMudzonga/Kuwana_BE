import { PaymentMethod, Prisma } from '@prisma/client';
import { env } from '../../config/env';
import { IPaymentGateway, PaymentStatusResult } from './payment.gateway.interface';
import { StripeGateway } from './stripe.gateway';
import { PaynowGateway } from './paynow.gateway';
import { MockGateway } from './mock.gateway';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { NotFoundError, AppError, BadRequestError, ForbiddenError } from '../../middleware/error.middleware';
import { applyTransition, notifyStatusChange } from '../orders/order-lifecycle';

let gateway: IPaymentGateway | null = null;
/** Resolved lazily so the API can boot without payment credentials */
function getGateway(): IPaymentGateway {
  if (!gateway) {
    if (env.ACTIVE_PAYMENT_GATEWAY === 'paynow') gateway = new PaynowGateway();
    else if (env.ACTIVE_PAYMENT_GATEWAY === 'stripe') gateway = new StripeGateway();
    else gateway = new MockGateway();
  }
  return gateway;
}

/** Test hook */
export function setGatewayForTests(g: IPaymentGateway | null) {
  gateway = g;
}

export interface PaymentSummary {
  id: string;
  status: 'PENDING' | 'PAID' | 'FAILED';
  redirectUrl?: string;
  instructions?: string;
}

const lastPolled = new Map<string, number>();
const POLL_INTERVAL_MS = 5000;

export class PaymentsService {
  supportsMethod(method: PaymentMethod): boolean {
    return method === 'CASH' || getGateway().supports(method);
  }

  /**
   * Charge for every unpaid order in a checkout. Orders stay PENDING_PAYMENT until the
   * gateway confirms; a mock or instant success confirms immediately.
   */
  async startCheckoutPayment(checkoutRef: string, method: PaymentMethod, phone: string | undefined, userId: string): Promise<PaymentSummary> {
    const orders = await prisma.order.findMany({
      where: { checkoutRef, userId, status: 'PENDING_PAYMENT', paymentStatus: { in: ['PENDING', 'FAILED'] } },
      include: { user: { select: { email: true } } },
    });
    if (!orders.length) throw new BadRequestError('Nothing left to pay for this order');

    const g = getGateway();
    if (!g.supports(method)) throw new BadRequestError('That payment method is not available right now');

    const amount = orders.reduce((sum, o) => sum + Number(o.totalAmount), 0);
    const currency = orders[0].currency;
    const references = orders.map((o) => `#${o.reference}`).join(', ');

    const payment = await prisma.payment.create({
      data: { checkoutRef, method, gateway: g.name, amount, currency, status: 'PROCESSING' },
    });
    await prisma.order.updateMany({
      where: { id: { in: orders.map((o) => o.id) } },
      data: { paymentStatus: 'PENDING', paymentMethod: method, paymentPhone: phone },
    });

    try {
      const result = await g.initiatePayment({
        paymentId: payment.id,
        amount: Math.round(amount * 100) / 100,
        currency,
        method,
        phone,
        customerEmail: orders[0].user.email,
        description: `Kuwana order ${references}`,
      });
      await prisma.payment.update({
        where: { id: payment.id },
        data: { gatewayRef: result.gatewayRef, pollUrl: result.pollUrl, failureCode: result.failureMessage },
      });

      if (result.status === 'succeeded') {
        await this.markPaid(payment.id, amount);
        return { id: payment.id, status: 'PAID' };
      }
      if (result.status === 'failed') {
        await this.markFailed(payment.id, result.failureMessage ?? 'declined');
        throw new BadRequestError(result.failureMessage ?? 'The payment could not be started');
      }
      return { id: payment.id, status: 'PENDING', redirectUrl: result.redirectUrl, instructions: result.instructions };
    } catch (err) {
      if (!(err instanceof AppError)) {
        logger.error('Payment initiation failed', { err: (err as Error).message, paymentId: payment.id });
        await this.markFailed(payment.id, 'gateway_error');
        throw new AppError('The payment provider is unavailable. Please try again.', 502);
      }
      throw err;
    }
  }

  /** Retry / change payment for an order whose payment failed or was abandoned */
  async retryPayment(orderId: string, userId: string, method: PaymentMethod, phone?: string): Promise<PaymentSummary> {
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.userId !== userId) throw new NotFoundError('Order');
    if (order.status !== 'PENDING_PAYMENT') throw new BadRequestError('This order does not need payment');

    if (method === 'CASH') {
      // Switching to cash: release the orders to the sellers now
      const pending = await prisma.order.findMany({ where: { checkoutRef: order.checkoutRef, status: 'PENDING_PAYMENT' } });
      await prisma.$transaction(async (tx) => {
        for (const o of pending) {
          await tx.order.update({ where: { id: o.id }, data: { paymentMethod: 'CASH', paymentStatus: 'PENDING' } });
          await applyTransition(tx, o.id, 'PLACED', { actorId: userId, reason: 'Switched to cash' });
        }
      });
      await Promise.all(pending.map((o) => notifyStatusChange(o.id, 'PLACED')));
      return { id: order.checkoutRef, status: 'PENDING', instructions: 'Pay in cash when your order arrives.' };
    }
    if ((method === 'ECOCASH' || method === 'ONEMONEY') && !phone && !order.paymentPhone) {
      throw new BadRequestError('Enter the mobile money number to charge');
    }
    return this.startCheckoutPayment(order.checkoutRef, method, phone ?? order.paymentPhone ?? undefined, userId);
  }

  /** Idempotent: confirms payment and releases the checkout's orders to their sellers */
  async markPaid(paymentId: string, paidAmount?: number) {
    const released = await prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({ where: { id: paymentId } });
      if (!payment || payment.status === 'SUCCEEDED') return [];
      if (paidAmount !== undefined && Math.abs(paidAmount - Number(payment.amount)) > 0.009) {
        logger.error('Payment amount mismatch — not confirming', { paymentId, expected: Number(payment.amount), paidAmount });
        await tx.payment.update({ where: { id: paymentId }, data: { status: 'FAILED', failureCode: 'amount_mismatch' } });
        return [];
      }
      await tx.payment.update({ where: { id: paymentId }, data: { status: 'SUCCEEDED' } });
      const orders = await tx.order.findMany({ where: { checkoutRef: payment.checkoutRef, status: 'PENDING_PAYMENT' } });
      for (const order of orders) {
        await tx.order.update({ where: { id: order.id }, data: { paymentStatus: 'PAID' } });
        await applyTransition(tx, order.id, 'PLACED', { reason: 'Payment confirmed' });
      }
      // Paid after the order expired: mark it paid so it shows up for an admin to refund
      const late = await tx.order.findMany({
        where: { checkoutRef: payment.checkoutRef, status: 'CANCELLED', paymentStatus: { in: ['PENDING', 'FAILED'] } },
      });
      for (const order of late) {
        await tx.order.update({ where: { id: order.id }, data: { paymentStatus: 'PAID' } });
        logger.warn('Payment received for a cancelled order — needs refund', { orderId: order.id });
      }
      return orders.map((o) => o.id);
    });
    await Promise.all(released.map((id) => notifyStatusChange(id, 'PLACED')));
  }

  async markFailed(paymentId: string, failureCode: string) {
    const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment || payment.status === 'SUCCEEDED') return;
    await prisma.$transaction([
      prisma.payment.update({ where: { id: paymentId }, data: { status: 'FAILED', failureCode } }),
      prisma.order.updateMany({
        where: { checkoutRef: payment.checkoutRef, status: 'PENDING_PAYMENT' },
        data: { paymentStatus: 'FAILED' },
      }),
    ]);
  }

  private async applyGatewayResult(result: PaymentStatusResult) {
    const payment = result.paymentId
      ? await prisma.payment.findUnique({ where: { id: result.paymentId } })
      : result.gatewayRef ? await prisma.payment.findFirst({ where: { gatewayRef: result.gatewayRef } }) : null;
    if (!payment) return;
    if (result.status === 'succeeded') await this.markPaid(payment.id, result.amount);
    else if (result.status === 'failed') await this.markFailed(payment.id, result.failureCode ?? 'failed');
  }

  /** Stripe webhook (raw JSON body + signature header) */
  async handleWebhook(rawBody: Buffer, signature: string) {
    const g = getGateway();
    if (!g.handleWebhookEvent) return;
    const result = await g.handleWebhookEvent(rawBody, signature);
    if (result) await this.applyGatewayResult(result);
  }

  /** Paynow result URL callback (form fields, verified by hash) */
  async handlePaynowResult(fields: Record<string, string>) {
    const g = getGateway();
    if (!g.handleResultCallback) return;
    const result = g.handleResultCallback(fields);
    if (result) await this.applyGatewayResult(result);
  }

  /**
   * Ask the gateway for the status of a pending payment. Used when the result callback
   * can't reach us (e.g. local development). Throttled per checkout.
   */
  async pollPendingPayment(checkoutRef: string) {
    const g = getGateway();
    if (!g.poll) return;
    const last = lastPolled.get(checkoutRef) ?? 0;
    if (Date.now() - last < POLL_INTERVAL_MS) return;
    lastPolled.set(checkoutRef, Date.now());

    const payment = await prisma.payment.findFirst({
      where: { checkoutRef, status: 'PROCESSING', pollUrl: { not: null } },
      orderBy: { createdAt: 'desc' },
    });
    if (!payment?.pollUrl) return;
    try {
      const result = await g.poll(payment.pollUrl);
      if (result) await this.applyGatewayResult({ ...result, paymentId: payment.id });
    } catch (err) {
      logger.warn('Payment poll failed', { err: (err as Error).message });
    }
  }

  /**
   * Refund one order (fully, or `amount` for a partial refund).
   * Gateways without a refund API (Paynow) and cash orders are recorded as manual refunds.
   */
  async refundOrder(orderId: string, opts: { amount?: number; reason: string; actorId?: string; markRefundedStatus?: boolean }) {
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundError('Order');
    if (order.paymentStatus !== 'PAID') throw new BadRequestError('Only paid orders can be refunded');

    const fullAmount = Number(order.totalAmount);
    const amount = opts.amount ?? fullAmount;
    if (amount <= 0 || amount > fullAmount + 0.001) throw new BadRequestError('Refund amount is more than the order total');

    let manual = order.paymentMethod === 'CASH';
    if (!manual) {
      const payment = await prisma.payment.findFirst({
        where: { checkoutRef: order.checkoutRef, status: 'SUCCEEDED' },
        orderBy: { createdAt: 'desc' },
      });
      if (!payment?.gatewayRef) throw new BadRequestError('No completed payment found for this order');
      const g = getGateway();
      if (g.name !== payment.gateway) {
        throw new BadRequestError(`This order was paid through ${payment.gateway}; refund it in that provider's dashboard`);
      }
      const result = await g.refund({ gatewayRef: payment.gatewayRef, amount, reason: opts.reason });
      if (!result.success && !result.manual) throw new AppError('The payment provider declined the refund', 502);
      manual = !!result.manual;
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          metadata: {
            ...((payment.metadata as Prisma.JsonObject | null) ?? {}),
            [`refund_${Date.now()}`]: { orderId, amount, reason: opts.reason, refundId: result.refundId ?? null, manual },
          },
          ...(amount >= Number(payment.amount) - 0.001 ? { status: 'REFUNDED' as const, refundedAt: new Date() } : {}),
        },
      });
    }

    const isFull = amount >= fullAmount - 0.001;
    const markStatus = isFull && opts.markRefundedStatus && order.status !== 'REFUNDED';
    await prisma.$transaction(async (tx) => {
      if (isFull) await tx.order.update({ where: { id: orderId }, data: { paymentStatus: 'REFUNDED' } });
      if (markStatus) await tx.order.update({ where: { id: orderId }, data: { status: 'REFUNDED' } });
      await tx.orderStatusHistory.create({
        data: {
          orderId,
          status: markStatus ? 'REFUNDED' : order.status,
          actorId: opts.actorId ?? null,
          note: `${isFull ? 'Full' : 'Partial'} refund of ${order.currency} ${amount.toFixed(2)}${manual ? ' (manual: pay the customer back via the merchant portal or in cash)' : ''}: ${opts.reason}`,
        },
      });
    });
    if (isFull) await notifyStatusChange(orderId, 'REFUNDED');
    return { amount, manual };
  }

  async listTransactions(userId: string, userRole: string, opts: { skip: number; take: number }) {
    let where: Prisma.PaymentWhereInput = {};
    if (userRole !== 'ADMIN') {
      const refs = await prisma.order.findMany({ where: { userId }, select: { checkoutRef: true }, distinct: ['checkoutRef'] });
      where = { checkoutRef: { in: refs.map((r) => r.checkoutRef) } };
    }
    const [data, total] = await Promise.all([
      prisma.payment.findMany({ where, skip: opts.skip, take: opts.take, orderBy: { createdAt: 'desc' } }),
      prisma.payment.count({ where }),
    ]);
    return { data, total };
  }

  async getTransaction(id: string, userId: string, userRole: string) {
    const payment = await prisma.payment.findUnique({ where: { id } });
    if (!payment) throw new NotFoundError('Transaction');
    if (userRole !== 'ADMIN') {
      const owns = await prisma.order.count({ where: { checkoutRef: payment.checkoutRef, userId } });
      if (!owns) throw new ForbiddenError('Access denied');
    }
    return payment;
  }
}

export const paymentsService = new PaymentsService();
