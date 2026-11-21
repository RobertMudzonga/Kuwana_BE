import { Prisma, ShipmentStatus } from '@prisma/client';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { assertCollectionPin, settleOrderIfDone } from '../market/handover';
import { BadRequestError, NotFoundError } from '../../middleware/error.middleware';
import { buyBoxService } from '../catalog/buybox.service';
import { TIER_LABELS } from '../market/pricing';

/** SLA needs a few dispatches before it moves away from the starting score */
const SLA_MIN_SAMPLE = 5;
const SLA_WINDOW = 50;

const include = {
  order: {
    select: {
      id: true, reference: true, status: true, paymentMethod: true, deliveryMode: true, deliveryAddress: true,
      recipientName: true, recipientPhone: true, recipientIdNumber: true, notes: true, confirmedAt: true,
      pickupPoint: { select: { name: true, address: true } },
    },
  },
  items: { select: { id: true, title: true, sku: true, quantity: true, unitPriceUsd: true, lineTotalUsd: true, sellerNetUsd: true, offer: { select: { sellerSku: true } } } },
  dispatchCity: { select: { name: true } },
} satisfies Prisma.ShipmentInclude;

type ShipmentFull = Prisma.ShipmentGetPayload<{ include: typeof include }>;

function toDto(s: ShipmentFull) {
  const overdue = !!s.dispatchBy && !s.dispatchedAt && ['PROCESSING', 'PACKED'].includes(s.status) && s.dispatchBy < new Date();
  return {
    id: s.id,
    reference: s.reference,
    status: s.status,
    tier: s.tier,
    tierLabel: TIER_LABELS[s.tier],
    dispatchBy: s.dispatchBy,
    overdue,
    packedAt: s.packedAt,
    dispatchedAt: s.dispatchedAt,
    deliveredAt: s.deliveredAt,
    dispatchedOnTime: s.dispatchedOnTime,
    courierName: s.courierName,
    trackingNumber: s.trackingNumber,
    shippingFeeUsd: s.feeUsd.toNumber(),
    order: {
      id: s.order.id,
      reference: s.order.reference,
      deliveryMode: s.order.deliveryMode,
      // The seller delivers these parcels, so they get the full address and phone
      address: s.order.deliveryAddress,
      pickupPoint: s.order.pickupPoint,
      recipientName: s.order.recipientName,
      recipientPhone: s.order.recipientPhone,
      notes: s.order.notes,
      confirmedAt: s.order.confirmedAt,
    },
    items: s.items.map((i) => ({
      id: i.id, title: i.title, sku: i.sku, sellerSku: i.offer.sellerSku, quantity: i.quantity,
      unitPriceUsd: i.unitPriceUsd.toNumber(), lineTotalUsd: i.lineTotalUsd.toNumber(), sellerNetUsd: i.sellerNetUsd.toNumber(),
    })),
  };
}

const TABS: Record<string, ShipmentStatus[]> = {
  to_dispatch: ['PROCESSING', 'PACKED'],
  in_transit: ['DISPATCHED', 'OUT_FOR_DELIVERY', 'READY_FOR_COLLECTION'],
  delivered: ['DELIVERED', 'COLLECTED'],
  cancelled: ['CANCELLED', 'RETURNED'],
};

export const fulfilmentService = {
  /** Seller-fulfilled parcels for confirmed orders (unpaid orders are never shown) */
  async list(sellerId: string, tab: keyof typeof TABS | 'all' = 'to_dispatch') {
    const rows = await prisma.shipment.findMany({
      where: {
        sellerId,
        sourceType: 'SELLER_FULFILLED',
        // Store-branch parcels are worked from the store portal (/store) and collected by Kuwana drivers
        storeBranchId: null,
        order: { status: { in: ['CONFIRMED', 'COMPLETED', 'CANCELLED'] }, confirmedAt: { not: null } },
        ...(tab === 'all' ? {} : { status: { in: TABS[tab] } }),
      },
      include,
      orderBy: tab === 'to_dispatch' ? [{ dispatchBy: 'asc' }] : [{ updatedAt: 'desc' }],
      take: 200,
    });
    return rows.map(toDto);
  },

  async owned(sellerId: string, id: string) {
    const s = await prisma.shipment.findUnique({ where: { id }, include });
    if (!s || s.sellerId !== sellerId || s.sourceType !== 'SELLER_FULFILLED' || s.storeBranchId || !s.order.confirmedAt) throw new NotFoundError('Shipment');
    return s;
  },

  async get(sellerId: string, id: string) {
    return toDto(await this.owned(sellerId, id));
  },

  async pack(sellerId: string, id: string) {
    await this.owned(sellerId, id);
    const { count } = await prisma.shipment.updateMany({ where: { id, status: 'PROCESSING' }, data: { status: 'PACKED', packedAt: new Date() } });
    if (!count) throw new BadRequestError('Only parcels being prepared can be marked packed');
    return this.get(sellerId, id);
  },

  /** Hand to the courier. Whether it left by the SLA deadline updates the seller's SLA score. */
  async dispatch(sellerId: string, id: string, input: { courierName: string; trackingNumber?: string }) {
    const s = await this.owned(sellerId, id);
    const now = new Date();
    const onTime = !s.dispatchBy || now <= s.dispatchBy;
    const { count } = await prisma.shipment.updateMany({
      where: { id, status: { in: ['PROCESSING', 'PACKED'] } },
      data: { status: 'DISPATCHED', dispatchedAt: now, dispatchedOnTime: onTime, courierName: input.courierName, trackingNumber: input.trackingNumber },
    });
    if (!count) throw new BadRequestError('This parcel has already been dispatched');
    await this.recomputeSla(sellerId);
    return this.get(sellerId, id);
  },

  /**
   * Confirm handover with the recipient's collection PIN. Only for home deliveries of prepaid orders;
   * pickup-point collections are confirmed by the pickup agent.
   */
  async deliver(sellerId: string, id: string, pin: string) {
    const s = await this.owned(sellerId, id);
    if (s.status !== 'DISPATCHED' && s.status !== 'OUT_FOR_DELIVERY') throw new BadRequestError('Dispatch the parcel before confirming delivery');
    if (s.order.deliveryMode !== 'DELIVERY') throw new BadRequestError('The pickup point confirms collection for this parcel');
    if (s.order.paymentMethod === 'CASH') throw new BadRequestError('Cash orders are confirmed by Kuwana');

    await assertCollectionPin(s.order.id, pin);
    await prisma.$transaction(async (tx) => {
      const { count } = await tx.shipment.updateMany({
        where: { id, status: { in: ['DISPATCHED', 'OUT_FOR_DELIVERY'] } },
        data: { status: 'DELIVERED', deliveredAt: new Date() },
      });
      if (!count) throw new BadRequestError('This parcel has already been delivered');
      await settleOrderIfDone(tx, s.order.id);
    });
    return this.get(sellerId, id);
  },

  /** On-time dispatch rate over the seller's recent parcels; refreshes their Buy Boxes when it changes */
  async recomputeSla(sellerId: string) {
    const recent = await prisma.shipment.findMany({
      where: { sellerId, dispatchedOnTime: { not: null } },
      orderBy: { dispatchedAt: 'desc' },
      take: SLA_WINDOW,
      select: { dispatchedOnTime: true },
    });
    if (recent.length < SLA_MIN_SAMPLE) return;
    const score = new Prisma.Decimal((recent.filter((r) => r.dispatchedOnTime).length * 100) / recent.length).toDecimalPlaces(2);
    const seller = await prisma.sellerProfile.findUniqueOrThrow({ where: { id: sellerId }, select: { slaScore: true } });
    if (seller.slaScore.equals(score)) return;
    await prisma.sellerProfile.update({ where: { id: sellerId }, data: { slaScore: score } });
    logger.info('Seller SLA score updated', { sellerId, from: seller.slaScore.toNumber(), to: score.toNumber() });
    await buyBoxService.recomputeForSeller(sellerId);
  },

  /** Every item this seller sold, including parcels Kuwana ships from a hub */
  async sales(sellerId: string, limit = 100) {
    const rows = await prisma.marketOrderItem.findMany({
      where: { sellerId, order: { confirmedAt: { not: null } } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { order: { select: { reference: true, status: true, paymentMethod: true } }, shipment: { select: { status: true, reference: true } } },
    });
    return rows.map((i) => ({
      id: i.id,
      orderReference: i.order.reference,
      orderStatus: i.order.status,
      shipmentReference: i.shipment.reference,
      shipmentStatus: i.shipment.status,
      fulfilmentType: i.fulfilmentType,
      title: i.title,
      quantity: i.quantity,
      lineTotalUsd: i.lineTotalUsd.toNumber(),
      commissionUsd: i.commissionUsd.toNumber(),
      fulfilmentFeeUsd: i.fulfilmentFeeUsd.toNumber(),
      sellerNetUsd: i.sellerNetUsd.toNumber(),
      cashOnDelivery: i.order.paymentMethod === 'CASH',
      createdAt: i.createdAt,
    }));
  },
};
