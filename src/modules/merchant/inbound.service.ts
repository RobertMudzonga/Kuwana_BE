import crypto from 'crypto';
import { InboundStatus, Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../middleware/error.middleware';
import { buyBoxService } from '../catalog/buybox.service';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const reference = () => 'ASN-' + Array.from(crypto.randomBytes(6), (b) => ALPHABET[b % ALPHABET.length]).join('');

const include = {
  hub: { select: { id: true, code: true, name: true, address: true, city: { select: { name: true } } } },
  seller: { select: { id: true, businessName: true } },
  items: {
    include: {
      offer: {
        select: {
          id: true, sellerSku: true, stockQty: true,
          product: { select: { id: true, sku: true, title: true, images: { take: 1, orderBy: { sortOrder: 'asc' }, select: { thumbUrl: true, url: true } } } },
        },
      },
    },
  },
} satisfies Prisma.InboundShipmentInclude;

type InboundFull = Prisma.InboundShipmentGetPayload<{ include: typeof include }>;

function toDto(i: InboundFull) {
  const expected = i.items.reduce((n, it) => n + it.quantityExpected, 0);
  const received = i.items.reduce((n, it) => n + (it.quantityReceived ?? 0), 0);
  const damaged = i.items.reduce((n, it) => n + it.quantityDamaged, 0);
  return {
    id: i.id,
    reference: i.reference,
    status: i.status,
    hub: { id: i.hub.id, code: i.hub.code, name: i.hub.name, address: i.hub.address, city: i.hub.city.name },
    seller: { id: i.seller.id, name: i.seller.businessName },
    expectedArrival: i.expectedArrival,
    carrier: i.carrier,
    notes: i.notes,
    receivingNotes: i.receivingNotes,
    submittedAt: i.submittedAt,
    receivedAt: i.receivedAt,
    createdAt: i.createdAt,
    totals: { expected, received, damaged, shortfall: i.status === 'RECEIVED' ? Math.max(0, expected - received - damaged) : 0 },
    items: i.items.map((it) => ({
      id: it.id,
      offerId: it.offerId,
      productId: it.offer.product.id,
      sku: it.offer.product.sku,
      sellerSku: it.offer.sellerSku,
      title: it.offer.product.title,
      image: it.offer.product.images[0]?.thumbUrl ?? it.offer.product.images[0]?.url ?? null,
      quantityExpected: it.quantityExpected,
      quantityReceived: it.quantityReceived,
      quantityDamaged: it.quantityDamaged,
    })),
  };
}

export type InboundItemsInput = { offerId: string; quantity: number }[];

async function validateItems(sellerId: string, hubId: string, items: InboundItemsInput) {
  const offers = await prisma.offer.findMany({ where: { id: { in: items.map((i) => i.offerId) } }, include: { product: { select: { title: true } } } });
  for (const item of items) {
    const o = offers.find((x) => x.id === item.offerId);
    if (!o || o.sellerId !== sellerId) throw new BadRequestError('One of these products is not one of your offers');
    if (o.fulfilmentType !== 'PLATFORM_FULFILLED' || o.hubId !== hubId) {
      throw new BadRequestError(`${o.product.title} is not set up for this hub. List it as "Fulfilled by Kuwana" at this hub first.`);
    }
  }
}

export const inboundService = {
  async create(sellerId: string, input: { hubId: string; expectedArrival?: Date; carrier?: string; notes?: string; items: InboundItemsInput }) {
    const hub = await prisma.hub.findUnique({ where: { id: input.hubId }, select: { isActive: true } });
    if (!hub?.isActive) throw new BadRequestError('Hub not found or not receiving stock');
    await validateItems(sellerId, input.hubId, input.items);
    const created = await prisma.inboundShipment.create({
      data: {
        reference: reference(), sellerId, hubId: input.hubId, expectedArrival: input.expectedArrival,
        carrier: input.carrier, notes: input.notes,
        items: { create: input.items.map((i) => ({ offerId: i.offerId, quantityExpected: i.quantity })) },
      },
      include,
    });
    return toDto(created);
  },

  async updateDraft(sellerId: string, id: string, input: { expectedArrival?: Date; carrier?: string; notes?: string; items?: InboundItemsInput }) {
    const existing = await this.owned(sellerId, id);
    if (existing.status !== 'DRAFT') throw new BadRequestError('Only drafts can be edited');
    if (input.items) await validateItems(sellerId, existing.hubId, input.items);
    await prisma.$transaction(async (tx) => {
      await tx.inboundShipment.update({ where: { id }, data: { expectedArrival: input.expectedArrival, carrier: input.carrier, notes: input.notes } });
      if (input.items) {
        await tx.inboundShipmentItem.deleteMany({ where: { inboundId: id } });
        await tx.inboundShipmentItem.createMany({ data: input.items.map((i) => ({ inboundId: id, offerId: i.offerId, quantityExpected: i.quantity })) });
      }
    });
    return this.getForSeller(sellerId, id);
  },

  async submit(sellerId: string, id: string) {
    const existing = await this.owned(sellerId, id);
    if (existing.status !== 'DRAFT') throw new BadRequestError('This notice has already been sent');
    await prisma.inboundShipment.update({ where: { id }, data: { status: 'SUBMITTED', submittedAt: new Date() } });
    return this.getForSeller(sellerId, id);
  },

  async cancel(sellerId: string, id: string) {
    const { count } = await prisma.inboundShipment.updateMany({ where: { id, sellerId, status: { in: ['DRAFT', 'SUBMITTED'] } }, data: { status: 'CANCELLED' } });
    if (!count) throw new BadRequestError('This notice can no longer be cancelled');
    return this.getForSeller(sellerId, id);
  },

  async owned(sellerId: string, id: string) {
    const row = await prisma.inboundShipment.findUnique({ where: { id } });
    if (!row || row.sellerId !== sellerId) throw new NotFoundError('Inbound shipment');
    return row;
  },

  async getForSeller(sellerId: string, id: string) {
    await this.owned(sellerId, id);
    return toDto(await prisma.inboundShipment.findUniqueOrThrow({ where: { id }, include }));
  },

  async listForSeller(sellerId: string) {
    const rows = await prisma.inboundShipment.findMany({ where: { sellerId }, include, orderBy: { createdAt: 'desc' }, take: 100 });
    return rows.map(toDto);
  },

  // ── Hub side ───────────────────────────────────────────

  async listForHub(filter: { hubId?: string; status?: InboundStatus }) {
    const rows = await prisma.inboundShipment.findMany({
      where: { hubId: filter.hubId, status: filter.status ?? 'SUBMITTED' },
      include,
      orderBy: [{ expectedArrival: 'asc' }, { createdAt: 'asc' }],
      take: 200,
    });
    return rows.map(toDto);
  },

  async getForHub(id: string) {
    const row = await prisma.inboundShipment.findUnique({ where: { id }, include });
    if (!row) throw new NotFoundError('Inbound shipment');
    return toDto(row);
  },

  /**
   * Record what arrived. Good units are added to the seller's hub offer and the Buy Box is refreshed;
   * damaged units are recorded but not stocked. Short or over deliveries are allowed and shown as discrepancies.
   */
  async receive(actorId: string, id: string, input: { items: { itemId: string; received: number; damaged?: number; bin?: string }[]; notes?: string }) {
    const [actor, notice] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: actorId }, select: { role: true, hubId: true } }),
      prisma.inboundShipment.findUnique({ where: { id }, select: { hubId: true } }),
    ]);
    if (!notice) throw new NotFoundError('Inbound shipment');
    if (actor.role === 'WAREHOUSE' && actor.hubId !== notice.hubId) throw new ForbiddenError('This delivery is for another hub');
    await prisma.$transaction(async (tx) => {
      const { count } = await tx.inboundShipment.updateMany({
        where: { id, status: 'SUBMITTED' },
        data: { status: 'RECEIVED', receivedAt: new Date(), receivedById: actorId, receivingNotes: input.notes },
      });
      if (!count) throw new BadRequestError('Only submitted shipments can be received');
      const items = await tx.inboundShipmentItem.findMany({ where: { inboundId: id }, include: { offer: { select: { productId: true } } } });
      const counts = new Map(input.items.map((i) => [i.itemId, i]));
      for (const item of items) {
        const c = counts.get(item.id);
        const received = c?.received ?? 0;
        const damaged = c?.damaged ?? 0;
        await tx.inboundShipmentItem.update({ where: { id: item.id }, data: { quantityReceived: received, quantityDamaged: damaged } });
        if (received > 0 || c?.bin) {
          await tx.offer.update({
            where: { id: item.offerId },
            data: { stockQty: { increment: received }, ...(c?.bin ? { binLocation: c.bin } : {}) },
          });
        }
      }
      const unknown = input.items.filter((i) => !items.some((it) => it.id === i.itemId));
      if (unknown.length) throw new BadRequestError('Some counted lines are not on this notice');
      const ids = [...new Set(items.map((i) => i.offer.productId))].sort();
      for (const productId of ids) await buyBoxService.recomputeProduct(productId, tx);
    });
    return this.getForHub(id);
  },
};
