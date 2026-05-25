/**
 * Paynow Gateway — Zimbabwe's leading payment gateway.
 * This is a functional stub ready for full integration.
 * Docs: https://developers.paynow.co.zw/
 *
 * To complete integration:
 * 1. npm install paynow  (official JS SDK)
 * 2. Replace stub methods with real Paynow SDK calls
 */

import { env } from '../../config/env';
import {
  IPaymentGateway,
  InitiatePaymentInput,
  InitiatePaymentResult,
  ConfirmPaymentResult,
  RefundInput,
} from './payment.gateway.interface';
import { logger } from '../../lib/logger';

export class PaynowGateway implements IPaymentGateway {
  private integrationId: string;
  private integrationKey: string;
  private resultUrl: string;
  private returnUrl: string;

  constructor() {
    this.integrationId = env.PAYNOW_INTEGRATION_ID ?? '';
    this.integrationKey = env.PAYNOW_INTEGRATION_KEY ?? '';
    this.resultUrl = env.PAYNOW_RESULT_URL ?? '';
    this.returnUrl = env.PAYNOW_RETURN_URL ?? '';

    if (!this.integrationId || !this.integrationKey) {
      logger.warn('Paynow credentials not fully configured — running in stub mode');
    }
  }

  async initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentResult> {
    /**
     * TODO: Replace stub with real Paynow SDK:
     *
     * const Paynow = require('paynow');
     * const paynow = new Paynow(this.integrationId, this.integrationKey);
     * paynow.resultUrl = this.resultUrl;
     * paynow.returnUrl = this.returnUrl;
     *
     * const payment = paynow.createPayment(`Order-${input.orderId}`, input.customerEmail);
     * payment.add(input.description ?? 'Sosa Connect Order', input.amount);
     *
     * const response = await paynow.send(payment);
     * if (response.success) {
     *   return {
     *     gatewayRef: response.pollUrl,
     *     redirectUrl: response.redirectUrl,
     *     status: 'pending',
     *   };
     * }
     */

    logger.info('[Paynow STUB] Initiating payment', { orderId: input.orderId, amount: input.amount });

    return {
      gatewayRef: `paynow_stub_${input.orderId}`,
      redirectUrl: `https://www.paynow.co.zw/Payment/Confirm/stub_${input.orderId}`,
      status: 'pending',
    };
  }

  async handleWebhookEvent(rawBody: Buffer, _signature: string): Promise<ConfirmPaymentResult | null> {
    /**
     * TODO: Paynow sends a POST to resultUrl with form-encoded data.
     * Parse it, verify hash, extract status.
     *
     * const params = new URLSearchParams(rawBody.toString());
     * const status = params.get('status');
     * const pollUrl = params.get('pollurl');
     * const hash = params.get('hash');
     * // Verify hash using integrationKey
     * if (status === 'Paid' || status === 'Awaiting Delivery') {
     *   return { gatewayRef: pollUrl, status: 'succeeded' };
     * }
     */

    logger.info('[Paynow STUB] Received webhook');
    return null;
  }

  async refund(_input: RefundInput): Promise<{ success: boolean; refundId?: string }> {
    // Paynow does not support automated refunds via API — must be done manually
    logger.warn('[Paynow] Refunds must be processed manually via Paynow merchant portal');
    return { success: false };
  }
}
