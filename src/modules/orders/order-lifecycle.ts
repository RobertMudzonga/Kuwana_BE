import crypto from 'crypto';
import { OrderStatus, Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { orderInclude, OrderWithRelations } from '../../lib/serializers';
import { sendPushToRole, sendPushToUsers } from '../../lib/push';

type Tx = Prisma.TransactionClient;

export const ACTIVE_STATUSES: OrderStatus[] = ['PENDING_PAYMENT', 'PLACED', 'ACCEPTED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY'];
export const TERMINAL_STATUSES: OrderStatus[] = ['DELIVERED', 'COLLECTED', 'CANCELLED', 'REJECTED', 'REFUNDED'];

const STATUS_MESSAGES: Partial<Record<OrderStatus, string>> = {
  PLACED: 'has been sent to the seller',
  ACCEPTED: 'was accepted',
  PREPARING: 'is being prepared',
  READY: 'is ready',
  OUT_FOR_DELIVERY: 'is on its way',
  DELIVERED: 'was delivered. Enjoy!',
  COLLECTED: 'was collected. Enjoy!',
  CANCELLED: 'was cancelled',
  REJECTED: 'was declined by the seller',
  REFUNDED: 'was refunded',
};

const REFERENCE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L

/** Short, unambiguous order reference, e.g. KW7Q2M9X */
export function generateReference(): string {
  const bytes = crypto.randomBytes(6);
  return 'KW' + Array.from(bytes, (b) => REFERENCE_ALPHABET[b % REFERENCE_ALPHABET.length]).join('');
}

export async function loadOrder(id: string, db: Tx | typeof prisma = prisma): Promise<OrderWithRelations | null> {
  return db.order.findUnique({ where: { id }, include: orderInclude });
}

/** Put stock back for stock-tracked items (on cancel, reject or payment expiry) */
export async function restoreStock(tx: Tx, orderId: string) {
  const items = await tx.orderItem.findMany({ where: { orderId } });
  for (const item of items) {
    await tx.service.updateMany({
      where: { id: item.serviceId, stock: { not: null } },
      data: { stock: { increment: item.quantity } },
    });
  }
}

interface TransitionOptions {
  actorId?: string | null;
  reason?: string;
}

/**
 * Move an order to `to` and apply side effects (timestamps, stock, deliveries, cash payment).
 * Callers are responsible for checking the transition is allowed for the actor.
 * Run inside a transaction; call `notifyStatusChange` after it commits.
 */
export async function applyTransition(tx: Tx, orderId: string, to: OrderStatus, opts: TransitionOptions = {}) {
  const order = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { provider: { select: { estimatedPrepMinutes: true } }, delivery: true },
  });
  const now = new Date();
  const data: Prisma.OrderUpdateInput = { status: to };

  switch (to) {
    case 'ACCEPTED': {
      const prep = order.provider.estimatedPrepMinutes ?? 30;
      data.estimatedReadyAt = new Date(now.getTime() + prep * 60 * 1000);
      // Delivery orders become a job drivers can pick up
      if (order.fulfilment === 'DELIVERY') {
        await tx.delivery.upsert({
          where: { orderId },
          update: {},
          create: { orderId, fee: order.deliveryFee, status: 'AVAILABLE' },
        });
      }
      break;
    }
    case 'OUT_FOR_DELIVERY':
      // Seller sending with their own rider: retire the open driver job
      if (order.delivery && !order.delivery.driverId) {
        await tx.delivery.update({ where: { orderId }, data: { status: 'SELF_DELIVERED' } });
      }
      break;
    case 'DELIVERED':
    case 'COLLECTED':
      data.completedAt = now;
      if (order.paymentMethod === 'CASH') data.paymentStatus = 'PAID';
      break;
    case 'CANCELLED':
    case 'REJECTED':
      data.cancelledAt = now;
      data.cancelReason = opts.reason ?? null;
      await restoreStock(tx, orderId);
      if (order.delivery && ['AVAILABLE', 'ASSIGNED', 'PICKED_UP'].includes(order.delivery.status)) {
        await tx.delivery.update({ where: { orderId }, data: { status: 'CANCELLED' } });
      }
      break;
    default:
      break;
  }

  await tx.order.update({ where: { id: orderId }, data });
  await tx.orderStatusHistory.create({
    data: { orderId, status: to, actorId: opts.actorId ?? null, note: opts.reason },
  });
}

/** Push notifications for a status change. Never throws. */
export async function notifyStatusChange(orderId: string, to: OrderStatus) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, reference: true, userId: true, fulfilment: true, provider: { select: { userId: true, businessName: true } } },
  });
  if (!order) return;

  if (to === 'PLACED') {
    await sendPushToUsers([order.provider.userId], {
      title: 'New order',
      body: `Order #${order.reference} is waiting for you to accept it.`,
      data: { type: 'NEW_ORDER', orderId: order.id },
    });
  }
  if (to === 'ACCEPTED' && order.fulfilment === 'DELIVERY') {
    await sendPushToRole('DRIVER', {
      title: 'New delivery job',
      body: `Pick up from ${order.provider.businessName}.`,
      data: { type: 'NEW_DELIVERY', orderId: order.id },
    });
  }
  const message = STATUS_MESSAGES[to];
  if (message) {
    await sendPushToUsers([order.userId], {
      title: `Order #${order.reference}`,
      body: `Your order ${message}`,
      data: { type: 'ORDER_UPDATE', orderId: order.id },
    });
  }
}
