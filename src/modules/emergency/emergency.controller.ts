import { Request, Response } from 'express';
import { emergencyService } from './emergency.service';
import { successResponse, createdResponse } from '../../lib/response';

export class EmergencyController {
  async list(req: Request, res: Response): Promise<void> {
    const contacts = await emergencyService.list(req.query.city as string | undefined);
    successResponse(res, contacts);
  }

  async create(req: Request, res: Response): Promise<void> {
    const contact = await emergencyService.create(req.body);
    createdResponse(res, contact, 'Emergency contact created');
  }

  async update(req: Request, res: Response): Promise<void> {
    const contact = await emergencyService.update(req.params.id, req.body);
    successResponse(res, contact, 'Emergency contact updated');
  }

  async delete(req: Request, res: Response): Promise<void> {
    await emergencyService.delete(req.params.id);
    successResponse(res, null, 'Emergency contact deactivated');
  }
}

export const emergencyController = new EmergencyController();
