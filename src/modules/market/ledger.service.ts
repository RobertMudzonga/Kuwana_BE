import { Currency, LedgerEntryType, Prisma } from '@prisma/client';
import { roundMoney, usdToZwg } from '../currency/currency.service';

type Tx = Prisma.TransactionClient;
const Decimal = Prisma.Decimal;
type Numeric = Prisma.Decimal | number | string;

/** Gross in the transaction currency, at the order's locked rate */
function grossTx(usd: Numeric, currency: Currency, rate: Numeric) {
  return currency === 'USD' ? roundMoney(usd) : usdToZwg(usd, rate);
}

type OrderForLedger = Prisma.MarketOrderGetPayload<{ include: { items: true; shipments: true } }>;

/**
 * Ledger writes. Entries are append-only: corrections are new, opposite entries.
 * Amounts are USD; each entry also records the transaction currency, the rate and the gross in that currency.
 */
export const ledgerService = {
  /**
   * Record the money side of a confirmed order: one SALE per item (seller net after commission and
   * fulfilment fee), one SHIPPING_FEE per charged shipment, and the COD fee.
   * For cash on delivery the entries are marked PENDING until the cash is collected.
   */
  async recordOrderConfirmed(tx: Tx, order: OrderForLedger, paymentId: string | null) {
    const base = {
      orderId: order.id,
      userId: order.userId,
      paymentId,
      currency: order.paymentCurrency,
      exchangeRateAtTx: order.lockedExchangeRate,
      codStatus: order.paymentMethod === 'CASH' ? ('PENDING' as const) : ('NOT_COD' as const),
    };
    // A COD deposit paid the fees online; only the goods wait for cash
    const feesPaidOnline = order.paymentMethod === 'CASH' && order.depositUsd.gt(0);
    const feeBase = feesPaidOnline ? { ...base, codStatus: 'NOT_COD' as const } : base;
    const rate = order.lockedExchangeRate;
    const data: Prisma.LedgerEntryCreateManyInput[] = [];

    for (const item of order.items) {
      data.push({
        ...base,
        type: 'SALE',
        orderItemId: item.id,
        shipmentId: item.shipmentId,
        sellerId: item.sellerId,
        grossUsd: item.lineTotalUsd,
        grossTx: grossTx(item.lineTotalUsd, order.paymentCurrency, rate),
        commissionUsd: item.commissionUsd,
        fulfilmentFeeUsd: item.fulfilmentFeeUsd,
        platformRevenueUsd: item.commissionUsd.plus(item.fulfilmentFeeUsd),
        sellerNetUsd: item.sellerNetUsd,
        memo: `${item.quantity} × ${item.title}`,
      });
    }

    for (const sh of order.shipments) {
      if (sh.storeBranchId) {
        // Store run: Kuwana keeps the margin over the driver's fee (negative when free delivery waived the fee)
        const driverFee = sh.driverFeeUsd ?? new Decimal(0);
        if (sh.feeUsd.lte(0) && driverFee.lte(0)) continue;
        data.push({
          ...feeBase,
          type: 'SHIPPING_FEE',
          shipmentId: sh.id,
          grossUsd: sh.feeUsd,
          grossTx: grossTx(sh.feeUsd, order.paymentCurrency, rate),
          platformRevenueUsd: sh.feeUsd.minus(driverFee),
          memo: sh.feeUsd.gt(0) ? `Delivery ${sh.reference} (driver ${driverFee.toFixed(2)})` : `Free delivery ${sh.reference}: Kuwana pays the driver ${driverFee.toFixed(2)}`,
        });
        continue;
      }
      if (sh.feeUsd.lte(0)) continue;
      const platform = sh.sourceType === 'PLATFORM_FULFILLED';
      data.push({
        ...feeBase,
        type: 'SHIPPING_FEE',
        shipmentId: sh.id,
        sellerId: platform ? null : sh.sellerId,
        grossUsd: sh.feeUsd,
        grossTx: grossTx(sh.feeUsd, order.paymentCurrency, rate),
        platformRevenueUsd: platform ? sh.feeUsd : new Decimal(0),
        sellerNetUsd: platform ? new Decimal(0) : sh.feeUsd,
        memo: platform ? `Delivery ${sh.reference}` : `Seller shipping ${sh.reference}`,
      });
    }

    if (order.codFeeUsd.gt(0)) {
      data.push({
        ...feeBase,
        type: 'COD_FEE',
        grossUsd: order.codFeeUsd,
        grossTx: grossTx(order.codFeeUsd, order.paymentCurrency, rate),
        platformRevenueUsd: order.codFeeUsd,
        memo: 'Cash on delivery fee',
      });
    }

    if (data.length) await tx.ledgerEntry.createMany({ data });
  },

  /** Cancel an order's recorded money with equal and opposite entries */
  async reverseOrder(tx: Tx, orderId: string, type: LedgerEntryType, memo: string, types: LedgerEntryType[] = ['SALE', 'SHIPPING_FEE', 'COD_FEE']) {
    const entries = await tx.ledgerEntry.findMany({ where: { orderId, type: { in: types } } });
    if (!entries.length) return;
    await tx.ledgerEntry.createMany({
      data: entries.map((e) => ({
        type,
        orderId: e.orderId,
        orderItemId: e.orderItemId,
        shipmentId: e.shipmentId,
        sellerId: e.sellerId,
        userId: e.userId,
        currency: e.currency,
        exchangeRateAtTx: e.exchangeRateAtTx,
        grossUsd: e.grossUsd.negated(),
        grossTx: e.grossTx.negated(),
        commissionUsd: e.commissionUsd.negated(),
        fulfilmentFeeUsd: e.fulfilmentFeeUsd.negated(),
        platformRevenueUsd: e.platformRevenueUsd.negated(),
        sellerNetUsd: e.sellerNetUsd.negated(),
        codStatus: e.codStatus,
        memo: `${memo} (reverses ${e.type.toLowerCase()})`,
      })),
    });
  },

  async recordWallet(
    tx: Tx,
    input: { userId: string; deltaUsd: Numeric; type: 'WALLET_CREDIT' | 'WALLET_DEBIT'; orderId?: string; paymentId?: string; rate: Numeric; memo: string },
  ) {
    const delta = roundMoney(input.deltaUsd);
    await tx.ledgerEntry.create({
      data: {
        type: input.type,
        userId: input.userId,
        orderId: input.orderId,
        paymentId: input.paymentId,
        currency: 'USD',
        exchangeRateAtTx: new Decimal(input.rate),
        grossUsd: delta.abs(),
        grossTx: delta.abs(),
        walletDeltaUsd: delta,
        memo: input.memo,
      },
    });
  },
};
