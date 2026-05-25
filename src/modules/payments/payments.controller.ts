import { Request, Response } from 'express';
import { paymentsService } from './payments.service';
import { successResponse, buildPaginationMeta, parsePagination } from '../../lib/response';

export class PaymentsController {
  async initiate(req: Request, res: Response): Promise<void> {
    const result = await paymentsService.initiatePayment(req.body.orderId, req.user!.sub);
    successResponse(res, result, 'Payment initiated', 201);
  }

  async webhook(req: Request, res: Response): Promise<void> {
    const signature = req.headers['stripe-signature'] as string ?? '';
    // rawBody populated by express.raw() middleware on this route
    await paymentsService.handleWebhook(req.body as Buffer, signature);
    res.status(200).json({ received: true });
  }

  async getTransaction(req: Request, res: Response): Promise<void> {
    const payment = await paymentsService.getTransaction(req.params.id, req.user!.sub, req.user!.role);
    successResponse(res, payment);
  }

  async listTransactions(req: Request, res: Response): Promise<void> {
    const { page, limit } = parsePagination(req.query as Record<string, unknown>);
    const { data, total } = await paymentsService.listTransactions(req.user!.sub, req.user!.role, {
      skip: (page - 1) * limit,
      take: limit,
    });
    successResponse(res, data, 'Transactions retrieved', 200, buildPaginationMeta(total, page, limit));
  }

  async refund(req: Request, res: Response): Promise<void> {
    const result = await paymentsService.refundPayment(req.params.id, req.user!.sub);
    successResponse(res, result, 'Refund processed');
  }
}

export const paymentsController = new PaymentsController();
