import crypto from 'crypto';
import { PayoutStatus, Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { sendSms } from '../../lib/sms';
import { BadRequestError, ForbiddenError } from '../../middleware/error.middleware';
import { currencyService, roundMoney, usdToZwg } from '../currency/currency.service';
import { getMarketSettings } from '../market/market.settings';
import { sellerBalances } from './earnings.service';

const Decimal = Prisma.Decimal;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const reference = () => 'PO-' + Array.from(crypto.randomBytes(6), (b) => ALPHABET[b % ALPHABET.length]).join('');

function toPayoutDto(p: Prisma.PayoutGetPayload<{ include: { seller: { select: { businessName: true } } } }> | Prisma.PayoutGetPayload<object>) {
  return {
    id: p.id,
    reference: p.reference,
    currency: p.currency,
    method: p.method,
    amountUsd: p.amountUsd.toNumber(),
    amount: p.amountTx.toNumber(),
    exchangeRate: p.exchangeRate.toNumber(),
    destination: p.destination,
    status: p.status,
    externalRef: p.externalRef,
    note: p.note,
    processedAt: p.processedAt,
    createdAt: p.createdAt,
    ...('seller' in p ? { sellerName: (p as { seller: { businessName: string } }).seller.businessName } : {}),
  };
}

export const payoutsService = {
  /**
   * Request a payout of available earnings (all of it by default). Funds are reserved at once with a
   * PAYOUT ledger entry, inside a transaction that locks the seller so two requests can't overdraw.
   */
  async request(sellerId: string, input: { currency: 'USD' | 'ZWG'; amountUsd?: number }) {
    const settings = await getMarketSettings();
    const seller = await prisma.sellerProfile.findUniqueOrThrow({ where: { id: sellerId } });
    if (seller.kycStatus !== 'APPROVED') throw new ForbiddenError('Payouts open once your seller account is approved');
    if (seller.payoutHoldAt) throw new ForbiddenError(`Payouts are on hold: ${seller.payoutHoldReason ?? 'contact Kuwana support'}`);

    const details = (input.currency === 'USD' ? seller.usdPayoutDetails : seller.zigPayoutDetails) as Record<string, string> | null;
    if (!details || !Object.keys(details).length) {
      throw new BadRequestError(`Add your ${input.currency === 'USD' ? 'USD bank' : 'ZiG bank or EcoCash merchant'} details before requesting a payout`);
    }
    const method = input.currency === 'USD' ? 'USD_BANK' : details.method === 'ECOCASH_MERCHANT' ? 'ECOCASH_MERCHANT' : 'ZWG_BANK';
    const rate = input.currency === 'ZWG' ? await currencyService.requireUsdToZwg() : await currencyService.getUsdToZwg();

    const payout = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM seller_profiles WHERE id = ${sellerId} FOR UPDATE`;
      const { availableUsd } = await sellerBalances(sellerId, tx);
      const amountUsd = roundMoney(input.amountUsd ?? availableUsd);
      if (amountUsd.lt(settings.minPayoutUsd)) {
        throw new BadRequestError(`The minimum payout is $${new Decimal(settings.minPayoutUsd).toFixed(2)}`);
      }
      if (amountUsd.gt(availableUsd)) {
        throw new BadRequestError(`You can withdraw up to $${availableUsd.toFixed(2)} right now`);
      }
      const rateValue = rate?.rate ?? new Decimal(0);
      const amountTx = input.currency === 'USD' ? amountUsd : usdToZwg(amountUsd, rateValue);
      const created = await tx.payout.create({
        data: {
          reference: reference(), sellerId, currency: input.currency, method,
          amountUsd, amountTx, exchangeRate: rateValue, destination: details,
        },
      });
      await tx.ledgerEntry.create({
        data: {
          type: 'PAYOUT', sellerId, payoutId: created.id, currency: input.currency, exchangeRateAtTx: rateValue,
          grossUsd: amountUsd, grossTx: amountTx, sellerNetUsd: amountUsd.negated(), memo: `Payout ${created.reference}`,
        },
      });
      return created;
    });
    return toPayoutDto(payout);
  },

  async listForSeller(sellerId: string) {
    const rows = await prisma.payout.findMany({ where: { sellerId }, orderBy: { createdAt: 'desc' }, take: 100 });
    return rows.map(toPayoutDto);
  },

  // ── Finance (admin) ────────────────────────────────────

  async listAll(status?: PayoutStatus) {
    const rows = await prisma.payout.findMany({
      where: status ? { status } : {},
      include: { seller: { select: { businessName: true } } },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    return rows.map(toPayoutDto);
  },

  async approve(id: string, adminId: string) {
    await assertNotHeld(id);
    const { count } = await prisma.payout.updateMany({
      where: { id, status: 'REQUESTED' },
      data: { status: 'APPROVED', processedById: adminId, processedAt: new Date() },
    });
    if (!count) throw new BadRequestError('Only requested payouts can be approved');
    return toPayoutDto(await prisma.payout.findUniqueOrThrow({ where: { id } }));
  },

  async markPaid(id: string, adminId: string, externalRef: string) {
    await assertNotHeld(id);
    const { count } = await prisma.payout.updateMany({
      where: { id, status: { in: ['REQUESTED', 'APPROVED'] } },
      data: { status: 'PAID', externalRef, processedById: adminId, processedAt: new Date() },
    });
    if (!count) throw new BadRequestError('This payout is not waiting to be paid');
    const payout = await prisma.payout.findUniqueOrThrow({ where: { id }, include: { seller: { select: { phone: true } } } });
    if (payout.seller.phone) {
      const amount = payout.currency === 'USD' ? `$${payout.amountTx.toFixed(2)}` : `ZiG ${payout.amountTx.toFixed(2)}`;
      await sendSms(payout.seller.phone, `Kuwana payout ${payout.reference} of ${amount} has been sent. Reference: ${externalRef}`)
        .catch((err) => logger.error('Payout SMS failed', { err: (err as Error).message }));
    }
    return toPayoutDto(payout);
  },

  /** Reject and return the reserved funds with an opposite ledger entry */
  async reject(id: string, adminId: string, note: string) {
    const payout = await prisma.$transaction(async (tx) => {
      const { count } = await tx.payout.updateMany({
        where: { id, status: { in: ['REQUESTED', 'APPROVED'] } },
        data: { status: 'REJECTED', note, processedById: adminId, processedAt: new Date() },
      });
      if (!count) throw new BadRequestError('This payout can no longer be rejected');
      const p = await tx.payout.findUniqueOrThrow({ where: { id } });
      await tx.ledgerEntry.create({
        data: {
          type: 'ADJUSTMENT', sellerId: p.sellerId, payoutId: p.id, currency: p.currency, exchangeRateAtTx: p.exchangeRate,
          grossUsd: p.amountUsd, grossTx: p.amountTx, sellerNetUsd: p.amountUsd, memo: `Payout ${p.reference} rejected: ${note}`,
        },
      });
      return p;
    });
    return toPayoutDto(payout);
  },

};

/** A store under an admin payout hold can't be approved or paid until the hold is lifted */
async function assertNotHeld(payoutId: string) {
  const p = await prisma.payout.findUnique({ where: { id: payoutId }, select: { seller: { select: { payoutHoldAt: true, payoutHoldReason: true } } } });
  if (p?.seller.payoutHoldAt) throw new BadRequestError(`This store's payouts are on hold (${p.seller.payoutHoldReason ?? 'no reason given'}); lift the hold first`);
}
