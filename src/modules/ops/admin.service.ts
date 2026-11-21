import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { env } from '../../config/env';
import { BadRequestError } from '../../middleware/error.middleware';

const Decimal = Prisma.Decimal;
type Row = Record<string, unknown>;
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

export const adminOpsService = {
  /**
   * Marketplace performance over the last `days`. GMV = value of items in confirmed orders
   * (cancellations excluded); revenue = the platform's share recorded in the ledger (net of reversals).
   */
  async analytics(days: number) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const confirmed = Prisma.sql`o.confirmed_at >= ${since} AND o.status <> 'CANCELLED'`;
    const [totals, daily, byMethod, byCurrency, byFulfilment, topSellers, byCategory, revenue, cancelled, returns, codOpen] = await Promise.all([
      prisma.$queryRaw<Row[]>`
        SELECT COUNT(*)::int AS orders, COALESCE(SUM(o.items_subtotal_usd),0) AS gmv, COALESCE(SUM(o.total_usd),0) AS billed
        FROM market_orders o WHERE ${confirmed}`,
      prisma.$queryRaw<Row[]>`
        SELECT to_char(date_trunc('day', o.confirmed_at AT TIME ZONE 'Africa/Harare'), 'YYYY-MM-DD') AS day,
               COUNT(*)::int AS orders, SUM(o.items_subtotal_usd) AS gmv
        FROM market_orders o WHERE ${confirmed} GROUP BY 1 ORDER BY 1`,
      prisma.$queryRaw<Row[]>`
        SELECT o.payment_method::text AS key, COUNT(*)::int AS orders, SUM(o.items_subtotal_usd) AS gmv
        FROM market_orders o WHERE ${confirmed} GROUP BY 1 ORDER BY gmv DESC`,
      prisma.$queryRaw<Row[]>`
        SELECT o.payment_currency::text AS key, COUNT(*)::int AS orders, SUM(o.items_subtotal_usd) AS gmv
        FROM market_orders o WHERE ${confirmed} GROUP BY 1 ORDER BY gmv DESC`,
      prisma.$queryRaw<Row[]>`
        SELECT i.fulfilment_type::text AS key, SUM(i.quantity)::int AS units, SUM(i.line_total_usd) AS gmv
        FROM market_order_items i JOIN market_orders o ON o.id = i.order_id WHERE ${confirmed} GROUP BY 1 ORDER BY gmv DESC`,
      prisma.$queryRaw<Row[]>`
        SELECT s.business_name AS name, s.is_first_party AS "firstParty", SUM(i.quantity)::int AS units, SUM(i.line_total_usd) AS gmv
        FROM market_order_items i JOIN market_orders o ON o.id = i.order_id JOIN seller_profiles s ON s.id = i.seller_id
        WHERE ${confirmed} GROUP BY s.id ORDER BY gmv DESC LIMIT 10`,
      prisma.$queryRaw<Row[]>`
        WITH RECURSIVE tree AS (
          SELECT id, id AS root_id FROM categories WHERE parent_id IS NULL
          UNION ALL SELECT c.id, t.root_id FROM categories c JOIN tree t ON c.parent_id = t.id
        )
        SELECT r.name AS name, SUM(i.quantity)::int AS units, SUM(i.line_total_usd) AS gmv
        FROM market_order_items i JOIN market_orders o ON o.id = i.order_id JOIN products p ON p.id = i.product_id
        JOIN tree t ON t.id = p.category_id JOIN categories r ON r.id = t.root_id
        WHERE ${confirmed} GROUP BY r.id ORDER BY gmv DESC`,
      prisma.$queryRaw<Row[]>`
        SELECT COALESCE(SUM(platform_revenue_usd) FILTER (WHERE type IN ('SALE','REFUND','ADJUSTMENT') AND order_item_id IS NOT NULL),0) AS commission_and_fees,
               COALESCE(SUM(platform_revenue_usd) FILTER (WHERE type IN ('SHIPPING_FEE','ADJUSTMENT') AND order_item_id IS NULL),0) AS delivery,
               COALESCE(SUM(platform_revenue_usd) FILTER (WHERE type = 'COD_FEE'),0) AS cod_fees,
               COALESCE(SUM(platform_revenue_usd),0) AS total
        FROM ledger_entries WHERE created_at >= ${since}`,
      prisma.marketOrder.count({ where: { status: 'CANCELLED', cancelledAt: { gte: since }, confirmedAt: { not: null } } }),
      prisma.returnRequest.aggregate({ where: { createdAt: { gte: since } }, _count: true, _sum: { refundUsd: true } }),
      prisma.codRemittance.groupBy({ by: ['currency'], where: { status: { in: ['COLLECTED', 'DISCREPANCY'] } }, _sum: { collectedAmount: true }, _count: true }),
    ]);
    const t = totals[0] ?? {};
    const orders = num(t.orders);
    const gmv = num(t.gmv);
    const r = revenue[0] ?? {};
    const breakdown = (rows: Row[]) => rows.map((x) => ({ key: String(x.key ?? x.name), orders: num(x.orders), units: num(x.units), gmvUsd: num(x.gmv) }));
    return {
      days,
      totals: {
        orders,
        gmvUsd: gmv,
        billedUsd: num(t.billed),
        averageOrderUsd: orders ? new Decimal(gmv).dividedBy(orders).toDecimalPlaces(2).toNumber() : 0,
        cancelledOrders: cancelled,
        cancellationRate: orders + cancelled ? Math.round((cancelled * 1000) / (orders + cancelled)) / 10 : 0,
        returns: returns._count,
        refundedUsd: returns._sum.refundUsd?.toNumber() ?? 0,
      },
      revenue: {
        commissionAndFeesUsd: num(r.commission_and_fees),
        deliveryUsd: num(r.delivery),
        codFeesUsd: num(r.cod_fees),
        totalUsd: num(r.total),
      },
      daily: daily.map((d) => ({ day: String(d.day), orders: num(d.orders), gmvUsd: num(d.gmv) })),
      byPaymentMethod: breakdown(byMethod),
      byCurrency: breakdown(byCurrency),
      byFulfilment: breakdown(byFulfilment),
      byCategory: byCategory.map((c) => ({ name: String(c.name), units: num(c.units), gmvUsd: num(c.gmv) })),
      topSellers: topSellers.map((s) => ({ name: String(s.name), firstParty: !!s.firstParty, units: num(s.units), gmvUsd: num(s.gmv) })),
      codOutstanding: codOpen.map((c) => ({ currency: c.currency, collections: c._count, amount: c._sum.collectedAmount?.toNumber() ?? 0 })),
    };
  },

  async listStaff() {
    const rows = await prisma.user.findMany({
      where: { role: { in: ['WAREHOUSE', 'DRIVER', 'PICKUP_AGENT'] } },
      select: {
        id: true, email: true, phone: true, role: true, status: true,
        profile: { select: { fullName: true } },
        staffHub: { select: { id: true, code: true, name: true } },
        staffPickupPoint: { select: { id: true, code: true, name: true } },
      },
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map((u) => ({ id: u.id, email: u.email, phone: u.phone, role: u.role, status: u.status, name: u.profile?.fullName ?? u.email, hub: u.staffHub, pickupPoint: u.staffPickupPoint }));
  },

  /**
   * Create a staff account, or change an existing user's staff role and assignment.
   * Warehouse staff need a hub; pickup agents need a pickup point; drivers may have a home hub.
   */
  async upsertStaff(input: { email: string; fullName: string; phone?: string; password?: string; role: 'WAREHOUSE' | 'DRIVER' | 'PICKUP_AGENT'; hubId?: string; pickupPointId?: string }) {
    if (input.role === 'WAREHOUSE' && !input.hubId) throw new BadRequestError('Choose the hub this person works at');
    if (input.role === 'PICKUP_AGENT' && !input.pickupPointId) throw new BadRequestError('Choose the pickup point this agent runs');
    const assignment = {
      role: input.role,
      hubId: input.role === 'PICKUP_AGENT' ? null : input.hubId ?? null,
      pickupPointId: input.role === 'PICKUP_AGENT' ? input.pickupPointId! : null,
    };
    const email = input.email.toLowerCase();
    const existing = await prisma.user.findUnique({ where: { email }, select: { id: true, role: true } });
    if (existing) {
      if (existing.role === 'ADMIN') throw new BadRequestError('Admins cannot be turned into staff accounts');
      await prisma.user.update({ where: { id: existing.id }, data: assignment });
    } else {
      if (!input.password) throw new BadRequestError('Set a temporary password for the new account');
      await prisma.user.create({
        data: {
          email, phone: input.phone, passwordHash: await bcrypt.hash(input.password, env.BCRYPT_SALT_ROUNDS), emailVerified: true,
          profile: { create: { fullName: input.fullName } }, ...assignment,
        },
      });
    }
    return (await this.listStaff()).find((s) => s.email === email)!;
  },
};
