import { Prisma, ShipmentStatus } from '@prisma/client';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { sendSms } from '../../lib/sms';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../middleware/error.middleware';
import { TIER_LABELS } from '../market/pricing';
import { codAmountsByShipment } from '../market/handover';
import { StaffContext, hubScope } from './staff';

export const opsShipmentInclude = {
  hub: { select: { id: true, code: true, name: true } },
  driver: { select: { id: true, profile: { select: { fullName: true } }, email: true } },
  order: {
    select: {
      id: true, reference: true, deliveryMode: true, deliveryAddress: true, recipientName: true, recipientPhone: true,
      paymentMethod: true, paymentCurrency: true, confirmedAt: true,
      pickupPoint: { select: { id: true, code: true, name: true, address: true } },
      destinationCity: { select: { name: true } },
    },
  },
  items: { select: { id: true, title: true, sku: true, quantity: true, offer: { select: { id: true, binLocation: true } } } },
  codRemittance: { select: { collectedAmount: true, status: true } },
} satisfies Prisma.ShipmentInclude;

export type OpsShipment = Prisma.ShipmentGetPayload<{ include: typeof opsShipmentInclude }>;

/** Shape shared by hub, driver and pickup-agent screens */
export async function toOpsShipmentDto(s: OpsShipment) {
  const cod = s.order.paymentMethod === 'CASH';
  const due = cod ? (await codAmountsByShipment(prisma, s.order.id)).get(s.id) : undefined;
  return {
    id: s.id,
    reference: s.reference,
    status: s.status,
    sourceType: s.sourceType,
    tier: s.tier,
    tierLabel: TIER_LABELS[s.tier],
    hub: s.hub,
    driver: s.driver ? { id: s.driver.id, name: s.driver.profile?.fullName || s.driver.email } : null,
    courierName: s.courierName,
    trackingNumber: s.trackingNumber,
    deliveryAttempts: s.deliveryAttempts,
    lastAttemptNote: s.lastAttemptNote,
    packedAt: s.packedAt,
    dispatchedAt: s.dispatchedAt,
    outForDeliveryAt: s.outForDeliveryAt,
    readyForCollectionAt: s.readyForCollectionAt,
    deliveredAt: s.deliveredAt,
    weightKg: s.weightKg?.toNumber() ?? null,
    cashToCollect: due ? { amount: due.toNumber(), currency: s.order.paymentCurrency } : null,
    cashCollected: s.codRemittance ? s.codRemittance.collectedAmount.toNumber() : null,
    order: {
      id: s.order.id,
      reference: s.order.reference,
      deliveryMode: s.order.deliveryMode,
      address: s.order.deliveryAddress,
      city: s.order.destinationCity.name,
      pickupPoint: s.order.pickupPoint,
      recipientName: s.order.recipientName,
      recipientPhone: s.order.recipientPhone,
    },
    items: s.items.map((i) => ({ id: i.id, offerId: i.offer.id, title: i.title, sku: i.sku, quantity: i.quantity, bin: i.offer.binLocation })),
  };
}

const TABS: Record<string, ShipmentStatus[]> = {
  to_pick: ['PROCESSING'],
  packed: ['PACKED'],
  out: ['OUT_FOR_DELIVERY', 'DISPATCHED', 'READY_FOR_COLLECTION'],
  done: ['DELIVERED', 'COLLECTED', 'RETURNED'],
};

async function loadAtHub(ctx: StaffContext, id: string) {
  const s = await prisma.shipment.findUnique({ where: { id }, include: opsShipmentInclude });
  if (!s || s.sourceType !== 'PLATFORM_FULFILLED' || !s.order.confirmedAt) throw new NotFoundError('Shipment');
  if (ctx.role !== 'ADMIN' && s.hubId !== ctx.hubId) throw new ForbiddenError('This parcel belongs to another hub');
  return s;
}

export const hubService = {
  async queue(ctx: StaffContext, tab: keyof typeof TABS, hubId?: string) {
    const rows = await prisma.shipment.findMany({
      where: {
        sourceType: 'PLATFORM_FULFILLED',
        hubId: hubScope(ctx, hubId),
        status: { in: TABS[tab] },
        order: { confirmedAt: { not: null } },
      },
      include: opsShipmentInclude,
      orderBy: tab === 'done' ? { updatedAt: 'desc' } : { createdAt: 'asc' },
      take: 200,
    });
    return Promise.all(rows.map(toOpsShipmentDto));
  },

  /** Everything to pick right now, grouped by product and sorted by shelf so one walk covers the hub */
  async pickList(ctx: StaffContext, hubId?: string) {
    const items = await prisma.marketOrderItem.findMany({
      where: { shipment: { sourceType: 'PLATFORM_FULFILLED', status: 'PROCESSING', hubId: hubScope(ctx, hubId), order: { confirmedAt: { not: null } } } },
      select: { quantity: true, title: true, sku: true, offer: { select: { id: true, binLocation: true } }, shipment: { select: { reference: true } } },
    });
    const byOffer = new Map<string, { offerId: string; title: string; sku: string; bin: string | null; quantity: number; parcels: string[] }>();
    for (const i of items) {
      const e = byOffer.get(i.offer.id) ?? { offerId: i.offer.id, title: i.title, sku: i.sku, bin: i.offer.binLocation, quantity: 0, parcels: [] };
      e.quantity += i.quantity;
      e.parcels.push(i.shipment.reference);
      byOffer.set(i.offer.id, e);
    }
    return [...byOffer.values()].sort((a, b) => (a.bin ?? '~').localeCompare(b.bin ?? '~') || a.title.localeCompare(b.title));
  },

  async pack(ctx: StaffContext, id: string) {
    await loadAtHub(ctx, id);
    const { count } = await prisma.shipment.updateMany({ where: { id, status: 'PROCESSING' }, data: { status: 'PACKED', packedAt: new Date() } });
    if (!count) throw new BadRequestError('Only parcels waiting to be picked can be packed');
    return toOpsShipmentDto(await loadAtHub(ctx, id));
  },

  /**
   * Send a packed parcel on its way:
   * pickup-point orders → DISPATCHED to the point; metro home delivery → OUT_FOR_DELIVERY with a hub driver;
   * intercity home delivery → DISPATCHED with a courier and tracking number.
   */
  async dispatch(ctx: StaffContext, id: string, input: { driverId?: string; courierName?: string; trackingNumber?: string }) {
    const s = await loadAtHub(ctx, id);
    if (!['PROCESSING', 'PACKED'].includes(s.status)) throw new BadRequestError('This parcel has already left the hub');
    const now = new Date();
    let data: Prisma.ShipmentUncheckedUpdateManyInput;
    let sms: string | null = null;

    if (s.order.deliveryMode === 'PICKUP') {
      data = { status: 'DISPATCHED', dispatchedAt: now, courierName: input.courierName ?? 'Kuwana van', trackingNumber: input.trackingNumber };
    } else if (s.tier === 'METRO_NEXT_DAY' || s.tier === 'METRO_SAME_DAY') {
      if (!input.driverId) throw new BadRequestError('Choose the driver taking this parcel');
      const driver = await prisma.user.findUnique({ where: { id: input.driverId }, select: { role: true, hubId: true, profile: { select: { fullName: true } } } });
      if (!driver || driver.role !== 'DRIVER') throw new BadRequestError('That person is not a driver');
      if (driver.hubId && driver.hubId !== s.hubId) throw new BadRequestError('That driver works from another hub');
      data = { status: 'OUT_FOR_DELIVERY', dispatchedAt: now, outForDeliveryAt: now, driverId: input.driverId, courierName: 'Kuwana driver' };
      const due = s.order.paymentMethod === 'CASH' ? (await codAmountsByShipment(prisma, s.order.id)).get(s.id) : null;
      const cash = due ? ` Please have ${s.order.paymentCurrency === 'USD' ? `$${due.toFixed(2)}` : `ZiG ${due.toFixed(2)}`} cash ready.` : '';
      sms = `Your Kuwana parcel ${s.reference} is out for delivery today with ${driver.profile?.fullName ?? 'our driver'}.${cash} Have your collection PIN ready.`;
    } else {
      if (!input.courierName) throw new BadRequestError('Enter the courier taking this parcel');
      data = { status: 'DISPATCHED', dispatchedAt: now, courierName: input.courierName, trackingNumber: input.trackingNumber };
      sms = `Your Kuwana parcel ${s.reference} is on its way with ${input.courierName}${input.trackingNumber ? ` (tracking ${input.trackingNumber})` : ''}.`;
    }

    const { count } = await prisma.shipment.updateMany({ where: { id, status: { in: ['PROCESSING', 'PACKED'] } }, data });
    if (!count) throw new BadRequestError('This parcel has already left the hub');
    if (sms) await sendSms(s.order.recipientPhone, sms).catch((err) => logger.error('Dispatch SMS failed', { err: (err as Error).message }));
    return toOpsShipmentDto(await loadAtHub(ctx, id));
  },

  async drivers(ctx: StaffContext, hubId?: string) {
    const hub = hubScope(ctx, hubId);
    const rows = await prisma.user.findMany({
      where: { role: 'DRIVER', status: 'ACTIVE', ...(hub ? { OR: [{ hubId: hub }, { hubId: null }] } : {}) },
      select: { id: true, email: true, phone: true, hubId: true, profile: { select: { fullName: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const loads = await prisma.shipment.groupBy({ by: ['driverId'], where: { status: 'OUT_FOR_DELIVERY', driverId: { in: rows.map((r) => r.id) } }, _count: true });
    return rows.map((r) => ({
      id: r.id, name: r.profile?.fullName || r.email, phone: r.phone, hubId: r.hubId,
      outForDelivery: loads.find((l) => l.driverId === r.id)?._count ?? 0,
    }));
  },

  async setBin(ctx: StaffContext, offerId: string, bin: string | null) {
    const offer = await prisma.offer.findUnique({ where: { id: offerId }, select: { hubId: true, fulfilmentType: true } });
    if (!offer || offer.fulfilmentType !== 'PLATFORM_FULFILLED') throw new NotFoundError('Hub offer');
    if (ctx.role !== 'ADMIN' && offer.hubId !== ctx.hubId) throw new ForbiddenError('This stock is at another hub');
    await prisma.offer.update({ where: { id: offerId }, data: { binLocation: bin } });
    return { offerId, bin };
  },
};
