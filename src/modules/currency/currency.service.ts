import { Currency, Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { BadRequestError } from '../../middleware/error.middleware';

const Decimal = Prisma.Decimal;
type Decimal = Prisma.Decimal;
type Numeric = Decimal | number | string;

/** How long a looked-up rate is reused before re-reading the database */
const RATE_CACHE_MS = 30_000;

export interface RateSnapshot {
  id: string;
  /** ZiG per 1 USD */
  rate: Decimal;
  effectiveFrom: Date;
}

/** A price in both currencies. USD is the source of truth; ZiG is derived. */
export interface Money {
  usd: number;
  /** null when no exchange rate has been configured yet */
  zwg: number | null;
}

/** All money rounds half-up to cents, once, at the point of conversion. */
export function roundMoney(value: Numeric): Decimal {
  return new Decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

export function usdToZwg(usd: Numeric, rate: Numeric): Decimal {
  return roundMoney(new Decimal(usd).times(rate));
}

export function zwgToUsd(zwg: Numeric, rate: Numeric): Decimal {
  return roundMoney(new Decimal(zwg).dividedBy(rate));
}

/** Convert an amount expressed in `currency` into USD (used for price filters typed in ZiG). */
export function toUsd(amount: Numeric, currency: Currency, rate: RateSnapshot | null): Decimal {
  if (currency === 'USD') return roundMoney(amount);
  if (!rate) throw new BadRequestError('ZiG prices are unavailable until an exchange rate is set');
  return zwgToUsd(amount, rate.rate);
}

export function money(usd: Numeric, rate: RateSnapshot | null): Money {
  return {
    usd: roundMoney(usd).toNumber(),
    zwg: rate ? usdToZwg(usd, rate.rate).toNumber() : null,
  };
}

export function ratePayload(rate: RateSnapshot | null) {
  if (!rate) return null;
  return { from: 'USD' as const, to: 'ZWG' as const, rate: rate.rate.toNumber(), effectiveFrom: rate.effectiveFrom };
}

export class CurrencyService {
  private cached: { value: RateSnapshot | null; expiresAt: number } | null = null;

  /**
   * The USD→ZiG rate in force at `at` (default now). Current-rate lookups are cached briefly;
   * the cache also expires the moment a scheduled future rate takes effect.
   */
  async getUsdToZwg(at?: Date): Promise<RateSnapshot | null> {
    if (at) return this.findRate(at);

    const now = Date.now();
    if (this.cached && this.cached.expiresAt > now) return this.cached.value;

    const [value, next] = await Promise.all([
      this.findRate(new Date(now)),
      prisma.exchangeRate.findFirst({
        where: { fromCurrency: 'USD', toCurrency: 'ZWG', effectiveFrom: { gt: new Date(now) } },
        orderBy: { effectiveFrom: 'asc' },
        select: { effectiveFrom: true },
      }),
    ]);
    const expiresAt = Math.min(now + RATE_CACHE_MS, next ? next.effectiveFrom.getTime() : Infinity);
    this.cached = { value, expiresAt };
    return value;
  }

  /** Same as getUsdToZwg but fails loudly; for flows that must lock a rate (checkout, ledger). */
  async requireUsdToZwg(): Promise<RateSnapshot> {
    const rate = await this.getUsdToZwg();
    if (!rate) throw new BadRequestError('No USD→ZiG exchange rate is configured');
    return rate;
  }

  invalidate() {
    this.cached = null;
  }

  async setRate(input: { rate: number; effectiveFrom?: Date; note?: string; adminId: string }) {
    const created = await prisma.exchangeRate.create({
      data: {
        fromCurrency: 'USD',
        toCurrency: 'ZWG',
        rate: new Decimal(input.rate),
        effectiveFrom: input.effectiveFrom ?? new Date(),
        note: input.note,
        setByAdminId: input.adminId,
      },
    });
    this.invalidate();
    return created;
  }

  async history(page: number, limit: number) {
    const where = { fromCurrency: 'USD' as Currency, toCurrency: 'ZWG' as Currency };
    const [rows, total] = await Promise.all([
      prisma.exchangeRate.findMany({
        where,
        orderBy: { effectiveFrom: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: { setByAdmin: { select: { id: true, email: true } } },
      }),
      prisma.exchangeRate.count({ where }),
    ]);
    const now = new Date();
    const current = await this.findRate(now);
    return {
      total,
      data: rows.map((r) => ({
        id: r.id,
        rate: r.rate.toNumber(),
        effectiveFrom: r.effectiveFrom,
        source: r.source,
        note: r.note,
        setBy: r.setByAdmin?.email ?? null,
        createdAt: r.createdAt,
        status: r.id === current?.id ? 'CURRENT' : r.effectiveFrom > now ? 'SCHEDULED' : 'PAST',
      })),
    };
  }

  private async findRate(at: Date): Promise<RateSnapshot | null> {
    const row = await prisma.exchangeRate.findFirst({
      where: { fromCurrency: 'USD', toCurrency: 'ZWG', effectiveFrom: { lte: at } },
      // createdAt breaks ties when two rates share an effectiveFrom: the later correction wins
      orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
      select: { id: true, rate: true, effectiveFrom: true },
    });
    return row;
  }
}

export const currencyService = new CurrencyService();
