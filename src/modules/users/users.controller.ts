import { Request, Response } from 'express';
import { usersService } from './users.service';
import { successResponse, buildPaginationMeta, parsePagination } from '../../lib/response';

export class UsersController {
  async getMe(req: Request, res: Response): Promise<void> {
    const user = await usersService.getProfile(req.user!.sub);
    successResponse(res, user, 'Profile retrieved');
  }

  async updateMe(req: Request, res: Response): Promise<void> {
    const user = await usersService.updateProfile(req.user!.sub, req.body);
    successResponse(res, user, 'Profile updated');
  }

  async getUser(req: Request, res: Response): Promise<void> {
    const user = await usersService.getUser(req.params.id);
    successResponse(res, user);
  }

  async listUsers(req: Request, res: Response): Promise<void> {
    const { page, limit, skip: _skip } = parsePagination(req.query as Record<string, unknown>);
    const { role, status, search } = req.query as Record<string, string>;
    const { data, total } = await usersService.listUsers({ page, limit, role, status, search });
    const meta = buildPaginationMeta(total, page, limit);
    successResponse(res, data, 'Users retrieved', 200, meta);
  }
}

export const usersController = new UsersController();
