import Stripe from 'stripe';
import { env } from '../../config/env';
import {
  IPaymentGateway,
  InitiatePaymentInput,
  InitiatePaymentResult,
  ConfirmPaymentResult,
  RefundInput,
} from './payment.gateway.interface';
import { logger } from '../../lib/logger';

export class StripeGateway implements IPaymentGateway {
  private stripe: Stripe;

  constructor() {
    if (!env.STRIPE_SECRET_KEY) {
      throw new Error('STRIPE_SECRET_KEY is not configured');
    }
    this.stripe = new Stripe(env.STRIPE_SECRET_KEY, {
      apiVersion: '2024-04-10',
    });
  }

  async initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentResult> {
    const amountInCents = Math.round(input.amount * 100);

    const intent = await this.stripe.paymentIntents.create({
      amount: amountInCents,
      currency: input.currency.toLowerCase(),
      description: input.description,
      receipt_email: input.customerEmail,
      metadata: {
        orderId: input.orderId,
        ...input.metadata,
      },
      automatic_payment_methods: { enabled: true },
    });

    return {
      gatewayRef: intent.id,
      clientSecret: intent.client_secret ?? undefined,
      status: intent.status === 'requires_payment_method' ? 'requires_action' : 'pending',
    };
  }

  async handleWebhookEvent(rawBody: Buffer, signature: string): Promise<ConfirmPaymentResult | null> {
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

    if (event.type === 'payment_intent.succeeded') {
      const intent = event.data.object as Stripe.PaymentIntent;
      return {
        gatewayRef: intent.id,
        status: 'succeeded',
        receiptUrl: undefined, // Charge receipt fetched separately if needed
        rawEvent: event,
      };
    }

    if (event.type === 'payment_intent.payment_failed') {
      const intent = event.data.object as Stripe.PaymentIntent;
      return {
        gatewayRef: intent.id,
        status: 'failed',
        failureCode: intent.last_payment_error?.code ?? 'unknown',
        rawEvent: event,
      };
    }

    // Unhandled event type — not an error
    return null;
  }

  async refund(input: RefundInput): Promise<{ success: boolean; refundId?: string }> {
    const params: Stripe.RefundCreateParams = {
      payment_intent: input.gatewayRef,
      ...(input.amount ? { amount: Math.round(input.amount * 100) } : {}),
      reason: (input.reason as Stripe.RefundCreateParams.Reason) ?? 'requested_by_customer',
    };
    const refund = await this.stripe.refunds.create(params);
    return { success: refund.status === 'succeeded', refundId: refund.id };
  }
}
