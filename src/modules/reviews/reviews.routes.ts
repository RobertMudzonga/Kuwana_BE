import { Router, Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../../lib/prisma';
import { authenticate } from '../../middleware/auth.middleware';
import { validate } from '../../middleware/validate.middleware';
import { auditLog } from '../../middleware/audit.middleware';
import { createdResponse } from '../../lib/response';
import { BadRequestError, ConflictError, NotFoundError } from '../../middleware/error.middleware';

const router = Router();

router.post(
  '/',
  authenticate,
  validate(z.object({
    orderId: z.string().uuid(),
    rating: z.number().int().min(1).max(5),
    comment: z.string().max(500).optional(),
  })),
  auditLog({ action: 'REVIEW_CREATED', targetType: 'Review' }),
  async (req: Request, res: Response) => {
    const userId = req.user!.sub;
    const order = await prisma.order.findUnique({ where: { id: req.body.orderId }, include: { review: true } });
    if (!order || order.userId !== userId) throw new NotFoundError('Order');
    if (!['DELIVERED', 'COLLECTED'].includes(order.status)) throw new BadRequestError('You can review an order once it has been delivered');
    if (order.review) throw new ConflictError('You have already reviewed this order');

    const review = await prisma.$transaction(async (tx) => {
      const created = await tx.review.create({
        data: { userId, providerId: order.providerId, orderId: order.id, rating: req.body.rating, comment: req.body.comment?.trim() || null },
      });
      const stats = await tx.review.aggregate({ where: { providerId: order.providerId }, _avg: { rating: true }, _count: true });
      await tx.provider.update({
        where: { id: order.providerId },
        data: { rating: Math.round((stats._avg.rating ?? 0) * 10) / 10, reviewCount: stats._count },
      });
      return created;
    });
    createdResponse(res, review, 'Review posted');
  },
);

export default router;
