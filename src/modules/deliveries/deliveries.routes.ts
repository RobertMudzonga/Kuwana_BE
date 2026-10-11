import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { authenticate } from '../../middleware/auth.middleware';
import { requireRoles } from '../../middleware/rbac.middleware';
import { validate } from '../../middleware/validate.middleware';
import { auditLog } from '../../middleware/audit.middleware';
import { successResponse } from '../../lib/response';
import { BadRequestError, ConflictError, NotFoundError } from '../../middleware/error.middleware';
import { applyTransition, notifyStatusChange } from '../orders/order-lifecycle';

const deliveryInclude = {
  order: {
    include: {
      provider: { select: { businessName: true, address: true, city: true, phone: true, lat: true, lng: true } },
      user: { select: { phone: true, profile: { select: { fullName: true } } } },
      items: { select: { quantity: true } },
    },
  },
} satisfies Prisma.DeliveryInclude;

type DeliveryWithOrder = Prisma.DeliveryGetPayload<{ include: typeof deliveryInclude }>;

/** Customer contact details are only shared with the driver who took the job */
function toDeliveryDto(d: DeliveryWithOrder, viewerId: string) {
  const o = d.order;
  const address = (o.address ?? {}) as Record<string, unknown>;
  const assignedToViewer = d.driverId === viewerId;
  return {
    id: d.id,
    orderId: o.id,
    orderReference: o.reference,
    status: d.status,
    pickup: {
      name: o.provider.businessName,
      address: [o.provider.address, o.provider.city].filter(Boolean).join(', '),
      phone: assignedToViewer ? o.provider.phone ?? undefined : undefined,
      lat: o.provider.lat ?? undefined,
      lng: o.provider.lng ?? undefined,
    },
    dropoff: {
      ...address,
      contactName: assignedToViewer ? o.user.profile?.fullName : undefined,
      phone: assignedToViewer ? o.user.phone ?? undefined : undefined,
    },
    itemCount: o.items.reduce((sum, i) => sum + i.quantity, 0),
    cashToCollect: o.paymentMethod === 'CASH' && o.paymentStatus !== 'PAID' ? o.totalAmount : undefined,
    fee: d.fee,
    currency: o.currency,
  };
}

const router = Router();
router.use(authenticate, requireRoles('DRIVER', 'ADMIN'));

router.get('/available', async (req: Request, res: Response) => {
  const deliveries = await prisma.delivery.findMany({
    where: { status: 'AVAILABLE', driverId: null, order: { status: { in: ['ACCEPTED', 'PREPARING', 'READY'] } } },
    include: deliveryInclude,
    orderBy: { createdAt: 'asc' },
    take: 50,
  });
  successResponse(res, deliveries.map((d) => toDeliveryDto(d, req.user!.sub)));
});

router.get('/mine', async (req: Request, res: Response) => {
  const deliveries = await prisma.delivery.findMany({
    where: { driverId: req.user!.sub },
    include: deliveryInclude,
    orderBy: { updatedAt: 'desc' },
    take: 20,
  });
  successResponse(res, deliveries.map((d) => toDeliveryDto(d, req.user!.sub)));
});

router.post(
  '/:id/accept',
  auditLog({ action: 'DELIVERY_ACCEPTED', targetType: 'Delivery', targetIdParam: 'id' }),
  async (req: Request, res: Response) => {
    const driverId = req.user!.sub;
    const active = await prisma.delivery.count({ where: { driverId, status: { in: ['ASSIGNED', 'PICKED_UP'] } } });
    if (active > 0) throw new BadRequestError('Finish your current delivery before accepting another');

    // Atomic claim: only succeeds if nobody else has taken it
    const { count } = await prisma.delivery.updateMany({
      where: { id: req.params.id, status: 'AVAILABLE', driverId: null },
      data: { driverId, status: 'ASSIGNED', assignedAt: new Date() },
    });
    if (count === 0) throw new ConflictError('This job has already been taken');

    const delivery = await prisma.delivery.findUniqueOrThrow({ where: { id: req.params.id }, include: deliveryInclude });
    successResponse(res, toDeliveryDto(delivery, driverId), 'Delivery accepted');
  },
);

router.patch(
  '/:id/status',
  validate(z.object({ status: z.enum(['PICKED_UP', 'DELIVERED']), proofPhotoUrl: z.string().url().optional() })),
  auditLog({ action: 'DELIVERY_STATUS_CHANGED', targetType: 'Delivery', targetIdParam: 'id' }),
  async (req: Request, res: Response) => {
    const driverId = req.user!.sub;
    const delivery = await prisma.delivery.findUnique({ where: { id: req.params.id }, include: { order: true } });
    if (!delivery || (delivery.driverId !== driverId && req.user!.role !== 'ADMIN')) throw new NotFoundError('Delivery');

    if (req.body.status === 'PICKED_UP') {
      if (delivery.status !== 'ASSIGNED') throw new BadRequestError('This delivery has already been picked up');
      if (delivery.order.status !== 'READY') throw new BadRequestError('The seller has not marked this order ready yet');
      await prisma.$transaction(async (tx) => {
        await tx.delivery.update({ where: { id: delivery.id }, data: { status: 'PICKED_UP', pickedUpAt: new Date() } });
        await applyTransition(tx, delivery.orderId, 'OUT_FOR_DELIVERY', { actorId: driverId });
      });
      await notifyStatusChange(delivery.orderId, 'OUT_FOR_DELIVERY');
    } else {
      if (delivery.status !== 'PICKED_UP') throw new BadRequestError('Pick up the order before marking it delivered');
      if (!req.body.proofPhotoUrl) throw new BadRequestError('A proof-of-delivery photo is required');
      await prisma.$transaction(async (tx) => {
        await tx.delivery.update({
          where: { id: delivery.id },
          data: { status: 'DELIVERED', deliveredAt: new Date(), proofPhotoUrl: req.body.proofPhotoUrl },
        });
        await applyTransition(tx, delivery.orderId, 'DELIVERED', { actorId: driverId });
      });
      await notifyStatusChange(delivery.orderId, 'DELIVERED');
    }

    const updated = await prisma.delivery.findUniqueOrThrow({ where: { id: delivery.id }, include: deliveryInclude });
    successResponse(res, toDeliveryDto(updated, driverId), 'Delivery updated');
  },
);

router.post(
  '/:id/location',
  validate(z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) })),
  async (req: Request, res: Response) => {
    const { count } = await prisma.delivery.updateMany({
      where: { id: req.params.id, driverId: req.user!.sub, status: { in: ['ASSIGNED', 'PICKED_UP'] } },
      data: { driverLat: req.body.lat, driverLng: req.body.lng, locationAt: new Date() },
    });
    if (count === 0) throw new NotFoundError('Active delivery');
    successResponse(res, null, 'Location updated');
  },
);

export default router;
