import { Request, Response } from 'express';
import { adminService } from './admin.service';
import { usersService } from '../users/users.service';
import { providersService } from '../providers/providers.service';
import { successResponse, buildPaginationMeta, parsePagination } from '../../lib/response';

export class AdminController {
  async getDashboard(req: Request, res: Response): Promise<void> {
    const stats = await adminService.getDashboardStats();
    successResponse(res, stats, 'Dashboard stats');
  }

  async getAuditLogs(req: Request, res: Response): Promise<void> {
    const { page, limit } = parsePagination(req.query as Record<string, unknown>);
    const q = req.query as Record<string, string>;
    const { data, total } = await adminService.getAuditLogs({ page, limit, action: q.action, actorId: q.actorId });
    successResponse(res, data, 'Audit logs', 200, buildPaginationMeta(total, page, limit));
  }

  async listUsers(req: Request, res: Response): Promise<void> {
    const { page, limit } = parsePagination(req.query as Record<string, unknown>);
    const q = req.query as Record<string, string>;
    const { data, total } = await usersService.listUsers({ page, limit, role: q.role, status: q.status, search: q.search });
    successResponse(res, data, 'Users', 200, buildPaginationMeta(total, page, limit));
  }

  async setUserStatus(req: Request, res: Response): Promise<void> {
    const { status } = req.body as { status: 'ACTIVE' | 'SUSPENDED' };
    const user = await adminService.setUserStatus(req.params.id, status);
    successResponse(res, user, `User ${status.toLowerCase()}`);
  }

  async listProviders(req: Request, res: Response): Promise<void> {
    const { page, limit } = parsePagination(req.query as Record<string, unknown>);
    const q = req.query as Record<string, string>;
    const { data, total } = await providersService.listProviders({ page, limit, approvalStatus: q.approvalStatus, category: q.category, search: q.search });
    successResponse(res, data, 'Providers', 200, buildPaginationMeta(total, page, limit));
  }

  async createUser(req: Request, res: Response): Promise<void> {
    const user = await adminService.createUser(req.body);
    successResponse(res, user, 'User created', 201);
  }

  async createProvider(req: Request, res: Response): Promise<void> {
    const provider = await adminService.createProvider(req.body);
    successResponse(res, provider, 'Service provider created', 201);
  }

  async createService(req: Request, res: Response): Promise<void> {
    const service = await adminService.createService(req.body);
    successResponse(res, service, 'Service created', 201);
  }

  async setProviderApproval(req: Request, res: Response): Promise<void> {
    const provider = await providersService.setApproval(req.params.id, req.body, req.user!.sub);
    successResponse(res, provider, 'Provider approval updated');
  }

  async listPayments(req: Request, res: Response): Promise<void> {
    const { page, limit } = parsePagination(req.query as Record<string, unknown>);
    const q = req.query as Record<string, string>;
    const { data, total } = await adminService.getAllPayments({ skip: (page - 1) * limit, take: limit, status: q.status });
    successResponse(res, data, 'Payments', 200, buildPaginationMeta(total, page, limit));
  }
}

export const adminController = new AdminController();
