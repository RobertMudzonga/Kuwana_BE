import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { paymentsService } from './payments.service';
import { successResponse, buildPaginationMeta, parsePagination } from '../../lib/response';
import { NotFoundError } from '../../middleware/error.middleware';

export class PaymentsController {
  /** Start or retry payment for an order (and the rest of its checkout) */
  async initiate(req: Request, res: Response): Promise<void> {
    const order = await prisma.order.findUnique({ where: { id: req.body.orderId } });
    if (!order || order.userId !== req.user!.sub) throw new NotFoundError('Order');
    const result = await paymentsService.retryPayment(
      order.id,
      req.user!.sub,
      req.body.paymentMethod ?? order.paymentMethod,
      req.body.paymentPhone,
    );
    successResponse(res, result, 'Payment initiated', 201);
  }

  async webhook(req: Request, res: Response): Promise<void> {
    const signature = req.headers['stripe-signature'] as string ?? '';
    // rawBody populated by express.raw() middleware on this route
    await paymentsService.handleWebhook(req.body as Buffer, signature);
    res.status(200).json({ received: true });
  }

  async paynowResult(req: Request, res: Response): Promise<void> {
    await paymentsService.handlePaynowResult(req.body as Record<string, string>);
    // Paynow only needs a 200
    res.status(200).send('OK');
  }

  /** Where the browser lands after a hosted checkout. The app polls the order for the real status. */
  async returnPage(req: Request, res: Response): Promise<void> {
    const cancelled = req.query.status === 'cancelled';
    res.type('html').send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kuwana</title><style>body{font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;background:#f8fafc;color:#0f172a;text-align:center;padding:24px}</style></head>
<body><div><h1>${cancelled ? 'Payment cancelled' : 'Thanks!'}</h1>
<p>${cancelled ? 'No money was taken. Return to the Kuwana app to try again.' : 'Your payment is being confirmed. You can close this page and return to the Kuwana app.'}</p></div></body></html>`);
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

  /** Admin: refund every paid order covered by a payment */
  async refund(req: Request, res: Response): Promise<void> {
    const payment = await prisma.payment.findUnique({ where: { id: req.params.id } });
    if (!payment) throw new NotFoundError('Payment');
    const orders = await prisma.order.findMany({ where: { checkoutRef: payment.checkoutRef, paymentStatus: 'PAID' } });
    const results = [];
    for (const order of orders) {
      results.push(await paymentsService.refundOrder(order.id, {
        reason: req.body?.reason ?? 'Refunded by admin',
        actorId: req.user!.sub,
        markRefundedStatus: true,
      }));
    }
    successResponse(res, results, 'Refund processed');
  }
}

export const paymentsController = new PaymentsController();
