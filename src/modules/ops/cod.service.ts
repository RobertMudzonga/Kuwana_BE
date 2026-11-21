import { CodRemittanceStatus, Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { BadRequestError } from '../../middleware/error.middleware';
import { StaffContext, hubScope } from './staff';

const Decimal = Prisma.Decimal;

function dto(r: Prisma.CodRemittanceGetPayload<{ include: { collector: { select: { email: true; profile: { select: { fullName: true } } } }; shipment: { select: { reference: true } } } }>) {
  return {
    id: r.id,
    shipmentReference: r.shipment.reference,
    collector: { id: r.collectorId, name: r.collector.profile?.fullName || r.collector.email },
    currency: r.currency,
    expectedAmount: r.expectedAmount.toNumber(),
    collectedAmount: r.collectedAmount.toNumber(),
    short: r.expectedAmount.minus(r.collectedAmount).toNumber(),
    status: r.status,
    collectedAt: r.collectedAt,
    verifiedAt: r.verifiedAt,
    note: r.note,
  };
}

export const codService = {
  /** Cash collections, with per-collector totals for the cash-up */
  async list(ctx: StaffContext, filter: { status?: CodRemittanceStatus; hubId?: string }) {
    const hub = hubScope(ctx, filter.hubId);
    const rows = await prisma.codRemittance.findMany({
      where: { status: filter.status ?? 'COLLECTED', ...(hub ? { shipment: { hubId: hub } } : {}) },
      include: { collector: { select: { email: true, profile: { select: { fullName: true } } } }, shipment: { select: { reference: true } } },
      orderBy: { collectedAt: 'asc' },
      take: 500,
    });
    const items = rows.map(dto);
    const byCollector = new Map<string, { collector: { id: string; name: string }; count: number; totals: Record<string, number> }>();
    for (const r of items) {
      const e = byCollector.get(r.collector.id) ?? { collector: r.collector, count: 0, totals: {} };
      e.count++;
      e.totals[r.currency] = new Decimal(e.totals[r.currency] ?? 0).plus(r.collectedAmount).toNumber();
      byCollector.set(r.collector.id, e);
    }
    return { items, collectors: [...byCollector.values()] };
  },

  /**
   * Cash-up: hub staff count the cash handed in for a set of collections. If the counted cash matches
   * what was recorded (per currency) and each parcel was paid in full, they are VERIFIED; otherwise every
   * collection in the batch is marked DISCREPANCY with the difference noted.
   */
  async verify(ctx: StaffContext, input: { ids: string[]; counted: { USD?: number; ZWG?: number }; note?: string }) {
    const hub = hubScope(ctx);
    const rows = await prisma.codRemittance.findMany({
      where: { id: { in: input.ids }, status: 'COLLECTED', ...(hub ? { shipment: { hubId: hub } } : {}) },
    });
    if (rows.length !== input.ids.length) throw new BadRequestError('Some of these collections are already reconciled or belong to another hub');

    const recorded: Record<string, Prisma.Decimal> = {};
    for (const r of rows) recorded[r.currency] = (recorded[r.currency] ?? new Decimal(0)).plus(r.collectedAmount);
    const problems: string[] = [];
    for (const cur of ['USD', 'ZWG'] as const) {
      const want = recorded[cur] ?? new Decimal(0);
      const got = new Decimal(input.counted[cur] ?? 0);
      if (!want.equals(got)) problems.push(`${cur === 'USD' ? 'USD' : 'ZiG'} counted ${got.toFixed(2)}, recorded ${want.toFixed(2)}`);
    }
    const shortParcels = rows.filter((r) => !r.collectedAmount.equals(r.expectedAmount));
    if (shortParcels.length) problems.push(`${shortParcels.length} parcel(s) not paid in full`);

    const status: CodRemittanceStatus = problems.length ? 'DISCREPANCY' : 'VERIFIED';
    const note = [problems.join('; '), input.note].filter(Boolean).join(' — ') || null;
    await prisma.codRemittance.updateMany({
      where: { id: { in: input.ids }, status: 'COLLECTED' },
      data: { status, verifiedById: ctx.id, verifiedAt: new Date(), note },
    });
    return { status, note, count: rows.length };
  },
};
