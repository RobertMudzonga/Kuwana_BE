import Stripe from 'stripe';
import { PaymentMethod } from '@prisma/client';
import { env } from '../../config/env';
import {
  IPaymentGateway,
  InitiatePaymentInput,
  InitiatePaymentResult,
  PaymentStatusResult,
  RefundInput,
  RefundResult,
} from './payment.gateway.interface';
import { logger } from '../../lib/logger';

/** Card payments via Stripe Checkout (a hosted page the app opens in a browser) */
export class StripeGateway implements IPaymentGateway {
  readonly name = 'STRIPE' as const;
  private stripe: Stripe;

  constructor() {
    if (!env.STRIPE_SECRET_KEY) {
      throw new Error('STRIPE_SECRET_KEY is not configured');
    }
    this.stripe = new Stripe(env.STRIPE_SECRET_KEY, {
      apiVersion: '2024-04-10',
    });
  }

  supports(method: PaymentMethod): boolean {
    return method === 'CARD';
  }

  async initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentResult> {
    const returnBase = `${env.PUBLIC_API_URL}/api/${env.API_VERSION}/payments/return`;
    const session = await this.stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        quantity: 1,
        price_data: {
          currency: input.currency.toLowerCase(),
          unit_amount: Math.round(input.amount * 100),
          product_data: { name: input.description },
        },
      }],
      customer_email: input.customerEmail,
      client_reference_id: input.paymentId,
      metadata: { paymentId: input.paymentId },
      payment_intent_data: { metadata: { paymentId: input.paymentId } },
      success_url: `${returnBase}?status=success`,
      cancel_url: `${returnBase}?status=cancelled`,
    });

    return { gatewayRef: session.id, status: 'pending', redirectUrl: session.url ?? undefined };
  }

  async handleWebhookEvent(rawBody: Buffer, signature: string): Promise<PaymentStatusResult | null> {
    if (!env.STRIPE_WEBHOOK_SECRET) {
      logger.warn('Stripe webhook secret not configured');
      return null;
    }

    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      logger.warn('Stripe webhook signature verification failed', { err });
      throw new Error('Invalid webhook signature');
    }

    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.payment_status !== 'paid') return null;
        return {
          paymentId: session.metadata?.paymentId,
          gatewayRef: session.id,
          status: 'succeeded',
          amount: (session.amount_total ?? 0) / 100,
          rawEvent: { id: event.id, type: event.type },
        };
      }
      case 'checkout.session.async_payment_failed':
      case 'checkout.session.expired': {
        const session = event.data.object as Stripe.Checkout.Session;
        return {
          paymentId: session.metadata?.paymentId,
          gatewayRef: session.id,
          status: 'failed',
          failureCode: event.type === 'checkout.session.expired' ? 'expired' : 'payment_failed',
          rawEvent: { id: event.id, type: event.type },
        };
      }
      default:
        return null; // Unhandled event type — not an error
    }
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    const session = await this.stripe.checkout.sessions.retrieve(input.gatewayRef);
    const paymentIntent = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
    if (!paymentIntent) return { success: false };
    const refund = await this.stripe.refunds.create({
      payment_intent: paymentIntent,
      ...(input.amount ? { amount: Math.round(input.amount * 100) } : {}),
      reason: 'requested_by_customer',
      metadata: input.reason ? { reason: input.reason.slice(0, 450) } : undefined,
    });
    return { success: refund.status === 'succeeded' || refund.status === 'pending', refundId: refund.id };
  }
}
