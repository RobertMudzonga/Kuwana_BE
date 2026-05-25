import { Request, Response } from 'express';
import { servicesService } from './services.service';
import { successResponse, createdResponse, buildPaginationMeta, parsePagination } from '../../lib/response';

export class ServicesController {
  async create(req: Request, res: Response): Promise<void> {
    const service = await servicesService.create(req.user!.sub, req.body);
    createdResponse(res, service, 'Service listing created');
  }

  async getService(req: Request, res: Response): Promise<void> {
    const service = await servicesService.getService(req.params.id);
    successResponse(res, service);
  }

  async updateService(req: Request, res: Response): Promise<void> {
    const service = await servicesService.updateService(req.params.id, req.user!.sub, req.body);
    successResponse(res, service, 'Service updated');
  }

  async deleteService(req: Request, res: Response): Promise<void> {
    await servicesService.deleteService(req.params.id, req.user!.sub);
    successResponse(res, null, 'Service deactivated');
  }

  async listServices(req: Request, res: Response): Promise<void> {
    const { page, limit } = parsePagination(req.query as Record<string, unknown>);
    const q = req.query as Record<string, string>;
    const { data, total } = await servicesService.listServices({
      page, limit,
      category: q.category,
      providerId: q.providerId,
      search: q.search,
      minPrice: q.minPrice ? parseFloat(q.minPrice) : undefined,
      maxPrice: q.maxPrice ? parseFloat(q.maxPrice) : undefined,
    });
    successResponse(res, data, 'Services retrieved', 200, buildPaginationMeta(total, page, limit));
  }
}

export const servicesController = new ServicesController();
