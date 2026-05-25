/**
 * Payment Gateway Abstraction Interface
 * All concrete gateways must implement this contract.
 * Swap gateways by changing ACTIVE_PAYMENT_GATEWAY env var.
 */

export interface InitiatePaymentInput {
  orderId: string;
  amount: number;      // in USD cents (for Stripe) or base units
  currency: string;    // e.g. 'usd'
  description?: string;
  customerEmail?: string;
  metadata?: Record<string, string>;
}

export interface InitiatePaymentResult {
  gatewayRef: string;          // Stripe PaymentIntent ID or Paynow poll URL
  clientSecret?: string;       // Stripe only — sent to frontend to confirm payment
  redirectUrl?: string;        // Paynow only — redirect customer here
  status: 'pending' | 'requires_action';
}

export interface ConfirmPaymentResult {
  gatewayRef: string;
  status: 'succeeded' | 'failed' | 'pending';
  receiptUrl?: string;
  failureCode?: string;
  rawEvent?: unknown;
}

export interface RefundInput {
  gatewayRef: string;
  amount?: number;    // partial refund amount in cents; omit for full refund
  reason?: string;
}

export interface IPaymentGateway {
  /** Initiate a payment and return gateway reference + client-side secret/redirect */
  initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentResult>;

  /** Called by webhook handler to confirm payment status */
  handleWebhookEvent(rawBody: Buffer, signature: string): Promise<ConfirmPaymentResult | null>;

  /** Issue a refund */
  refund(input: RefundInput): Promise<{ success: boolean; refundId?: string }>;
}
