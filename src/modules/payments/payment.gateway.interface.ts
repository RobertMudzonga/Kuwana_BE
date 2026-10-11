import { PaymentGateway, PaymentMethod } from '@prisma/client';

export interface InitiatePaymentInput {
  /** Our Payment id — used as the gateway's merchant reference */
  paymentId: string;
  amount: number;
  currency: string;
  method: PaymentMethod;
  /** Mobile money number (+2637XXXXXXXX) for EcoCash / OneMoney */
  phone?: string;
  customerEmail: string;
  description: string;
}

export interface InitiatePaymentResult {
  gatewayRef: string;
  status: 'pending' | 'succeeded' | 'failed';
  /** Hosted payment page to open in a browser */
  redirectUrl?: string;
  /** Text to show the customer, e.g. "Approve the EcoCash prompt on your phone" */
  instructions?: string;
  pollUrl?: string;
  failureMessage?: string;
}

export interface PaymentStatusResult {
  /** Our Payment id, when the gateway echoes it back */
  paymentId?: string;
  gatewayRef?: string;
  status: 'succeeded' | 'failed' | 'pending';
  /** Amount the gateway says was paid, for verification */
  amount?: number;
  failureCode?: string;
  rawEvent?: unknown;
}

export interface RefundInput {
  gatewayRef: string;
  /** Partial refund amount in major units; omit for full refund */
  amount?: number;
  reason?: string;
}

export interface RefundResult {
  success: boolean;
  /** true when the gateway has no refund API and the refund must be made by hand */
  manual?: boolean;
  refundId?: string;
}

export interface IPaymentGateway {
  readonly name: PaymentGateway;
  supports(method: PaymentMethod): boolean;
  initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentResult>;
  /** Stripe-style signed JSON webhooks */
  handleWebhookEvent?(rawBody: Buffer, signature: string): Promise<PaymentStatusResult | null>;
  /** Paynow-style form-encoded result callbacks */
  handleResultCallback?(fields: Record<string, string>): PaymentStatusResult | null;
  poll?(pollUrl: string): Promise<PaymentStatusResult | null>;
  refund(input: RefundInput): Promise<RefundResult>;
}
