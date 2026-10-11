import { Router, Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../../lib/prisma';
import { authenticate } from '../../middleware/auth.middleware';
import { validate } from '../../middleware/validate.middleware';
import { successResponse, createdResponse } from '../../lib/response';
import { NotFoundError } from '../../middleware/error.middleware';
import { serviceInclude } from '../../lib/serializers';

const router = Router();
router.use(authenticate);

/** Returns the favourited services (same shape as GET /services) */
router.get('/', async (req: Request, res: Response) => {
  const favourites = await prisma.favourite.findMany({
    where: { userId: req.user!.sub, service: { isActive: true } },
    orderBy: { createdAt: 'desc' },
    include: { service: { include: serviceInclude } },
  });
  successResponse(res, favourites.map((f) => f.service));
});

router.post('/', validate(z.object({ serviceId: z.string().uuid() })), async (req: Request, res: Response) => {
  const service = await prisma.service.findFirst({ where: { id: req.body.serviceId, isActive: true } });
  if (!service) throw new NotFoundError('Service');
  // Idempotent: favouriting twice is not an error
  await prisma.favourite.upsert({
    where: { userId_serviceId: { userId: req.user!.sub, serviceId: service.id } },
    update: {},
    create: { userId: req.user!.sub, serviceId: service.id },
  });
  createdResponse(res, null, 'Added to favourites');
});

router.delete('/:serviceId', async (req: Request, res: Response) => {
  await prisma.favourite.deleteMany({ where: { userId: req.user!.sub, serviceId: req.params.serviceId } });
  successResponse(res, null, 'Removed from favourites');
});

export default router;
