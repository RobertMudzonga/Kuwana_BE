import { Request, Response } from 'express';
import { providersService } from './providers.service';
import { successResponse, createdResponse, buildPaginationMeta, parsePagination } from '../../lib/response';

export class ProvidersController {
  async onboard(req: Request, res: Response): Promise<void> {
    const provider = await providersService.onboard(req.user!.sub, req.body);
    createdResponse(res, provider, 'Provider onboarded — pending approval');
  }

  async getMe(req: Request, res: Response): Promise<void> {
    const provider = await providersService.getMyProvider(req.user!.sub);
    successResponse(res, provider);
  }

  async updateMe(req: Request, res: Response): Promise<void> {
    const provider = await providersService.updateMyProvider(req.user!.sub, req.body);
    successResponse(res, provider, 'Provider profile updated');
  }

  async getProvider(req: Request, res: Response): Promise<void> {
    const provider = await providersService.getProvider(req.params.id);
    successResponse(res, provider);
  }

  async getNearby(req: Request, res: Response): Promise<void> {
    const { data, total } = await providersService.getNearby(req.query as never);
    const { page, limit } = parsePagination(req.query as Record<string, unknown>);
    const meta = buildPaginationMeta(total, page, limit);
    successResponse(res, data, 'Nearby providers', 200, meta);
  }

  async setApproval(req: Request, res: Response): Promise<void> {
    const provider = await providersService.setApproval(req.params.id, req.body, req.user!.sub);
    successResponse(res, provider, 'Provider approval updated');
  }

  async listProviders(req: Request, res: Response): Promise<void> {
    const { page, limit } = parsePagination(req.query as Record<string, unknown>);
    const { approvalStatus, category, search } = req.query as Record<string, string>;
    const { data, total } = await providersService.listProviders({ page, limit, approvalStatus, category, search });
    successResponse(res, data, 'Providers retrieved', 200, buildPaginationMeta(total, page, limit));
  }
}

export const providersController = new ProvidersController();
