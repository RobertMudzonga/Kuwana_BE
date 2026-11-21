import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { currencyService, money } from '../currency/currency.service';
import { getMarketSettings } from '../market/market.settings';

type Db = Prisma.TransactionClient | typeof prisma;
const Decimal = Prisma.Decimal;

export interface SellerBalances {
  /** Can be paid out now */
  availableUsd: Prisma.Decimal;
  /** Earned but not yet delivered, or still inside the return window */
  pendingUsd: Prisma.Decimal;
  /** Payouts requested or approved but not yet paid */
  inPayoutUsd: Prisma.Decimal;
  /** Part of pending frozen by an admin hold on the order */
  heldUsd: Prisma.Decimal;
  lifetime: { salesUsd: Prisma.Decimal; commissionUsd: Prisma.Decimal; fulfilmentFeesUsd: Prisma.Decimal; shippingUsd: Prisma.Decimal; netUsd: Prisma.Decimal; paidOutUsd: Prisma.Decimal };
  holdDays: number;
  /** Escrow after delivery, in hours */
  holdHours: number;
}

/**
 * Seller balances, derived from the ledger (never stored):
 * an entry tied to a shipment leaves escrow `escrowHoldHours` after that shipment is delivered
 * (covers wrong-item / damaged disputes raised at the door);
 * entries without a shipment (payouts, payout reversals, adjustments) count immediately.
 * Cancelled orders net to zero because their reversal entries sit on the same shipment.
 */
export async function sellerBalances(sellerId: string, db: Db = prisma): Promise<SellerBalances> {
  const { escrowHoldHours } = await getMarketSettings();
  const [row] = await db.$queryRaw<Record<string, Prisma.Decimal | null>[]>`
    SELECT
      SUM(e.seller_net_usd) FILTER (
        WHERE e.shipment_id IS NULL
           OR (s.delivered_at IS NOT NULL AND s.delivered_at <= now() - make_interval(hours => ${escrowHoldHours}::int) AND o.payout_hold_at IS NULL)
      ) AS available,
      SUM(e.seller_net_usd) FILTER (
        WHERE e.shipment_id IS NOT NULL
          AND (s.delivered_at IS NULL OR s.delivered_at > now() - make_interval(hours => ${escrowHoldHours}::int) OR o.payout_hold_at IS NOT NULL)
      ) AS pending,
      SUM(e.seller_net_usd) FILTER (WHERE e.shipment_id IS NOT NULL AND o.payout_hold_at IS NOT NULL) AS held,
      SUM(e.gross_usd) FILTER (WHERE e.order_item_id IS NOT NULL) AS sales,
      SUM(e.commission_usd) FILTER (WHERE e.order_item_id IS NOT NULL) AS commission,
      SUM(e.fulfilment_fee_usd) FILTER (WHERE e.order_item_id IS NOT NULL) AS fees,
      SUM(e.seller_net_usd) FILTER (WHERE e.order_item_id IS NULL AND e.shipment_id IS NOT NULL) AS shipping,
      SUM(e.seller_net_usd) FILTER (WHERE e.shipment_id IS NOT NULL) AS net
    FROM ledger_entries e
    LEFT JOIN shipments s ON s.id = e.shipment_id
    LEFT JOIN market_orders o ON o.id = e.order_id
    WHERE e.seller_id = ${sellerId}`;
  const [paid, open] = await Promise.all([
    db.payout.aggregate({ where: { sellerId, status: 'PAID' }, _sum: { amountUsd: true } }),
    db.payout.aggregate({ where: { sellerId, status: { in: ['REQUESTED', 'APPROVED'] } }, _sum: { amountUsd: true } }),
  ]);
  const d = (v: Prisma.Decimal | null | undefined) => new Decimal(v ?? 0);
  return {
    availableUsd: d(row?.available),
    pendingUsd: d(row?.pending),
    inPayoutUsd: d(open._sum.amountUsd),
    heldUsd: d(row?.held),
    lifetime: {
      salesUsd: d(row?.sales),
      commissionUsd: d(row?.commission),
      fulfilmentFeesUsd: d(row?.fees),
      shippingUsd: d(row?.shipping),
      netUsd: d(row?.net),
      paidOutUsd: d(paid._sum.amountUsd),
    },
    holdDays: Math.round((escrowHoldHours / 24) * 10) / 10,
    holdHours: escrowHoldHours,
  };
}

export async function balancesDto(sellerId: string) {
  const [b, rate] = await Promise.all([sellerBalances(sellerId), currencyService.getUsdToZwg()]);
  return {
    available: money(b.availableUsd, rate),
    pending: money(b.pendingUsd, rate),
    inPayout: money(b.inPayoutUsd, rate),
    held: money(b.heldUsd, rate),
    lifetime: {
      sales: money(b.lifetime.salesUsd, rate),
      commission: money(b.lifetime.commissionUsd, rate),
      fulfilmentFees: money(b.lifetime.fulfilmentFeesUsd, rate),
      shipping: money(b.lifetime.shippingUsd, rate),
      net: money(b.lifetime.netUsd, rate),
      paidOut: money(b.lifetime.paidOutUsd, rate),
    },
    holdDays: b.holdDays,
    holdHours: b.holdHours,
  };
}

const TYPE_LABELS: Record<string, string> = {
  SALE: 'Sale',
  SHIPPING_FEE: 'Shipping charged',
  ADJUSTMENT: 'Adjustment',
  REFUND: 'Refund',
  PAYOUT: 'Payout',
  COD_COLLECTED: 'Cash collected',
};

/** Every ledger movement for the seller in a period, with opening and closing balances */
export async function statement(sellerId: string, from: Date, to: Date) {
  const where = { sellerId, createdAt: { gte: from, lt: to } };
  const [opening, entries] = await Promise.all([
    prisma.ledgerEntry.aggregate({ where: { sellerId, createdAt: { lt: from } }, _sum: { sellerNetUsd: true } }),
    prisma.ledgerEntry.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      include: { order: { select: { reference: true } } },
    }),
  ]);
  let running = new Decimal(opening._sum.sellerNetUsd ?? 0);
  const openingUsd = running;
  const rows = entries.map((e) => {
    running = running.plus(e.sellerNetUsd);
    return {
      id: e.id,
      date: e.createdAt,
      type: e.type,
      label: TYPE_LABELS[e.type] ?? e.type,
      memo: e.memo,
      orderReference: e.order?.reference ?? null,
      currency: e.currency,
      exchangeRate: e.exchangeRateAtTx.toNumber(),
      grossUsd: e.grossUsd.toNumber(),
      grossTx: e.grossTx.toNumber(),
      commissionUsd: e.commissionUsd.toNumber(),
      fulfilmentFeeUsd: e.fulfilmentFeeUsd.toNumber(),
      netUsd: e.sellerNetUsd.toNumber(),
      balanceUsd: running.toNumber(),
    };
  });
  return {
    from,
    to,
    openingBalanceUsd: openingUsd.toNumber(),
    closingBalanceUsd: running.toNumber(),
    totals: {
      salesUsd: rows.filter((r) => r.type === 'SALE').reduce((s, r) => s + r.grossUsd, 0),
      netUsd: running.minus(openingUsd).toNumber(),
    },
    entries: rows,
  };
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function statementCsv(st: Awaited<ReturnType<typeof statement>>): string {
  const header = ['Date', 'Type', 'Order', 'Details', 'Currency', 'Rate USD→ZiG', 'Gross (USD)', 'Gross (tx currency)', 'Commission (USD)', 'Fulfilment fee (USD)', 'Net to you (USD)', 'Balance (USD)'];
  const lines = st.entries.map((r) => [
    r.date, r.label, r.orderReference, r.memo, r.currency === 'ZWG' ? 'ZiG' : 'USD', r.exchangeRate, r.grossUsd.toFixed(2),
    r.grossTx.toFixed(2), r.commissionUsd.toFixed(2), r.fulfilmentFeeUsd.toFixed(2), r.netUsd.toFixed(2), r.balanceUsd.toFixed(2),
  ]);
  return [
    `Opening balance (USD),${st.openingBalanceUsd.toFixed(2)}`,
    header.join(','),
    ...lines.map((l) => l.map(csvCell).join(',')),
    `Closing balance (USD),${st.closingBalanceUsd.toFixed(2)}`,
  ].join('\n');
}
