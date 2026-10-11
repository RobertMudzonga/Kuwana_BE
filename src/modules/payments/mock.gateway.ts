import { PaymentMethod } from '@prisma/client';
import { IPaymentGateway, InitiatePaymentInput, InitiatePaymentResult, RefundResult } from './payment.gateway.interface';
import { logger } from '../../lib/logger';

/** Local development only: every payment succeeds instantly. Refused in production by env validation. */
export class MockGateway implements IPaymentGateway {
  readonly name = 'MOCK' as const;

  supports(method: PaymentMethod): boolean {
    return method !== 'CASH';
  }

  async initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentResult> {
    logger.info('[MockGateway] auto-approving payment', { paymentId: input.paymentId, amount: input.amount, method: input.method });
    return { gatewayRef: `mock_${input.paymentId}`, status: 'succeeded' };
  }

  async refund(): Promise<RefundResult> {
    return { success: true, refundId: `mock_refund_${Date.now()}` };
  }
}
