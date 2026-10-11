import { Request, Response } from 'express';
import { ordersService } from './orders.service';
import { successResponse, createdResponse, buildPaginationMeta } from '../../lib/response';

export class OrdersController {
  async quote(req: Request, res: Response): Promise<void> {
    successResponse(res, await ordersService.quote(req.user!.sub, req.body), 'Quote');
  }

  async create(req: Request, res: Response): Promise<void> {
    const result = await ordersService.placeOrder(req.user!.sub, req.body);
    createdResponse(res, result, 'Order placed');
  }

  async getOrder(req: Request, res: Response): Promise<void> {
    successResponse(res, await ordersService.getOrder(req.params.id, req.user!));
  }

  async cancel(req: Request, res: Response): Promise<void> {
    const order = await ordersService.cancelByBuyer(req.params.id, req.user!.sub, req.body?.reason);
    successResponse(res, order, 'Order cancelled');
  }

  async updateStatus(req: Request, res: Response): Promise<void> {
    const order = await ordersService.updateStatus(req.params.id, req.body, req.user!);
    successResponse(res, order, 'Order status updated');
  }

  async listOrders(req: Request, res: Response): Promise<void> {
    const q = req.query as unknown as { page: number; limit: number; status?: never; as: 'buyer' | 'seller' };
    const { data, total } = await ordersService.listOrders(req.user!, q);
    successResponse(res, data, 'Orders retrieved', 200, buildPaginationMeta(total, q.page, q.limit));
  }
}

export const ordersController = new OrdersController();
