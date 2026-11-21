import crypto from 'crypto';
import axios from 'axios';
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

const PAYNOW_BASE = 'https://www.paynow.co.zw/interface';
const PAID_STATUSES = ['paid', 'awaiting delivery', 'delivered'];
const FAILED_STATUSES = ['cancelled', 'failed', 'disputed', 'refunded'];

/**
 * Paynow (Zimbabwe) — EcoCash / OneMoney "express checkout" and card/web checkout.
 * Protocol: form-encoded requests; every message carries an uppercase SHA512 hash of all
 * field values (in order, excluding "hash") followed by the integration key.
 */
export class PaynowGateway implements IPaymentGateway {
  readonly name = 'PAYNOW' as const;
  /** One integration per currency: Paynow settles USD and ZiG separately */
  private integrations: Record<string, { id: string; key: string }> = {
    USD: { id: env.PAYNOW_INTEGRATION_ID ?? '', key: env.PAYNOW_INTEGRATION_KEY ?? '' },
    ZWG: { id: env.PAYNOW_ZWG_INTEGRATION_ID ?? '', key: env.PAYNOW_ZWG_INTEGRATION_KEY ?? '' },
  };

  supports(method: PaymentMethod): boolean {
    return ['ECOCASH', 'ONEMONEY', 'INNBUCKS', 'ZIMSWITCH', 'CARD'].includes(method);
  }

  private hash(fields: [string, string][], key: string): string {
    const concatenated = fields.filter(([k]) => k.toLowerCase() !== 'hash').map(([, v]) => v).join('');
    return crypto.createHash('sha512').update(concatenated + key, 'utf8').digest('hex').toUpperCase();
  }

  /** Verify a message Paynow sent us (response, result callback or poll) against any configured integration */
  private verify(fields: [string, string][]): boolean {
    const received = fields.find(([k]) => k.toLowerCase() === 'hash')?.[1];
    if (!received) return false;
    return Object.values(this.integrations).some(({ key }) => {
      if (!key) return false;
      const expected = this.hash(fields, key);
      return received.length === expected.length && crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));
    });
  }

  private parse(body: string): [string, string][] {
    return [...new URLSearchParams(body).entries()];
  }

  private toStatus(fields: [string, string][]): PaymentStatusResult {
    const get = (key: string) => fields.find(([k]) => k.toLowerCase() === key)?.[1] ?? '';
    const status = get('status').toLowerCase();
    return {
      paymentId: get('reference') || undefined,
      gatewayRef: get('reference') || undefined,
      status: PAID_STATUSES.includes(status) ? 'succeeded' : FAILED_STATUSES.includes(status) ? 'failed' : 'pending',
      amount: get('amount') ? Number(get('amount')) : undefined,
      failureCode: FAILED_STATUSES.includes(status) ? status : undefined,
      rawEvent: Object.fromEntries(fields),
    };
  }

  async initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentResult> {
    const integration = this.integrations[input.currency.toUpperCase()];
    if (!integration?.id || !integration.key) {
      throw new Error(`Paynow is not configured for ${input.currency} payments`);
    }
    const resultUrl = env.PAYNOW_RESULT_URL ?? `${env.PUBLIC_API_URL}/api/${env.API_VERSION}/payments/paynow/result`;
    const returnUrl = env.PAYNOW_RETURN_URL ?? `${env.PUBLIC_API_URL}/api/${env.API_VERSION}/payments/return`;
    // Express (on-phone) methods use remotetransaction; card and Zimswitch use the hosted web page
    const expressMethod: Partial<Record<PaymentMethod, string>> = { ECOCASH: 'ecocash', ONEMONEY: 'onemoney', INNBUCKS: 'innbucks' };
    const mobile = !!expressMethod[input.method];

    const fields: [string, string][] = [
      ['id', integration.id],
      ['reference', input.paymentId],
      ['amount', input.amount.toFixed(2)],
      ['additionalinfo', input.description.slice(0, 200)],
      ['returnurl', returnUrl],
      ['resulturl', resultUrl],
      // In Paynow test mode only the merchant's own email is accepted here
      ['authemail', env.PAYNOW_MERCHANT_EMAIL ?? input.customerEmail],
    ];
    if (mobile) {
      // Paynow expects the local format 07XXXXXXXX
      fields.push(['phone', (input.phone ?? '').replace(/^\+263/, '0')]);
      fields.push(['method', expressMethod[input.method]!]);
    }
    fields.push(['status', 'Message']);
    fields.push(['hash', this.hash(fields, integration.key)]);

    const url = `${PAYNOW_BASE}/${mobile ? 'remotetransaction' : 'initiatetransaction'}`;
    const { data } = await axios.post<string>(url, new URLSearchParams(fields).toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      responseType: 'text',
      timeout: 20000,
    });
    const response = this.parse(data);
    const get = (key: string) => response.find(([k]) => k.toLowerCase() === key)?.[1] ?? '';

    if (get('status').toLowerCase() !== 'ok') {
      logger.warn('[Paynow] initiate failed', { error: get('error') });
      return { gatewayRef: input.paymentId, status: 'failed', failureMessage: get('error') || 'Paynow rejected the payment' };
    }
    if (!this.verify(response)) {
      throw new Error('Paynow response hash mismatch');
    }
    return {
      gatewayRef: input.paymentId,
      status: 'pending',
      redirectUrl: get('browserurl') || undefined,
      instructions: input.method === 'INNBUCKS'
        ? `Open InnBucks and enter authorisation code ${get('authorizationcode')} to pay.`
        : mobile
          ? get('instructions') || `Approve the ${input.method === 'ECOCASH' ? 'EcoCash' : 'OneMoney'} prompt on your phone to complete payment.`
          : undefined,
      pollUrl: get('pollurl') || undefined,
    };
  }

  handleResultCallback(fields: Record<string, string>): PaymentStatusResult | null {
    const entries = Object.entries(fields);
    if (!this.verify(entries)) {
      logger.warn('[Paynow] result callback hash mismatch — ignored');
      return null;
    }
    return this.toStatus(entries);
  }

  async poll(pollUrl: string): Promise<PaymentStatusResult | null> {
    // Only ever call Paynow's own poll endpoint
    if (!pollUrl.startsWith('https://www.paynow.co.zw/')) return null;
    const { data } = await axios.post<string>(pollUrl, '', { responseType: 'text', timeout: 15000 });
    const fields = this.parse(data);
    if (!this.verify(fields)) {
      logger.warn('[Paynow] poll response hash mismatch — ignored');
      return null;
    }
    return this.toStatus(fields);
  }

  async refund(_input: RefundInput): Promise<RefundResult> {
    // Paynow has no refund API — refunds are made from the Paynow merchant portal
    return { success: false, manual: true };
  }
}
