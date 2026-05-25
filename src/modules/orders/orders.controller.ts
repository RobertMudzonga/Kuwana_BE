import { Request, Response } from 'express';
import { ordersService } from './orders.service';
import { successResponse, createdResponse, buildPaginationMeta, parsePagination } from '../../lib/response';

export class OrdersController {
  async create(req: Request, res: Response): Promise<void> {
    const order = await ordersService.createOrder(req.user!.sub, req.body);
    createdResponse(res, order, 'Order placed');
  }

  async getOrder(req: Request, res: Response): Promise<void> {
    const order = await ordersService.getOrder(req.params.id, req.user!.sub, req.user!.role);
    successResponse(res, order);
  }

  async updateStatus(req: Request, res: Response): Promise<void> {
    const order = await ordersService.updateStatus(req.params.id, req.body, req.user!.sub, req.user!.role);
    successResponse(res, order, 'Order status updated');
  }

  async listOrders(req: Request, res: Response): Promise<void> {
    const { page, limit } = parsePagination(req.query as Record<string, unknown>);
    const q = req.query as Record<string, string>;
    const { data, total } = await ordersService.listOrders(req.user!.sub, req.user!.role, {
      page, limit, status: q.status, role: q.role,
    });
    successResponse(res, data, 'Orders retrieved', 200, buildPaginationMeta(total, page, limit));
  }
}

export const ordersController = new OrdersController();
