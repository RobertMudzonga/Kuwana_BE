import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { BadRequestError, NotFoundError } from '../../middleware/error.middleware';
import { currencyService, money } from '../currency/currency.service';
import { ledgerService } from './ledger.service';

type Tx = Prisma.TransactionClient;
const Decimal = Prisma.Decimal;

export const walletService = {
  async balance(userId: string): Promise<Prisma.Decimal> {
    const w = await prisma.wallet.findUnique({ where: { userId }, select: { balanceUsd: true } });
    return w?.balanceUsd ?? new Decimal(0);
  },

  /**
   * Take `amountUsd` from the wallet inside a transaction. The conditional update refuses
   * to go below zero even if two checkouts race.
   */
  async debit(tx: Tx, input: { userId: string; amountUsd: Prisma.Decimal; orderId: string; paymentId: string; rate: Prisma.Decimal; memo: string }) {
    const { count } = await tx.wallet.updateMany({
      where: { userId: input.userId, balanceUsd: { gte: input.amountUsd } },
      data: { balanceUsd: { decrement: input.amountUsd } },
    });
    if (count === 0) throw new BadRequestError('Your wallet balance is too low for this order');
    await ledgerService.recordWallet(tx, {
      userId: input.userId, deltaUsd: input.amountUsd.negated(), type: 'WALLET_DEBIT',
      orderId: input.orderId, paymentId: input.paymentId, rate: input.rate, memo: input.memo,
    });
  },

  /** Admin goodwill credit (refund-to-wallet arrives with returns in Phase 4) */
  async credit(userId: string, amountUsd: number, memo: string) {
    if (!(await prisma.user.findUnique({ where: { id: userId }, select: { id: true } }))) throw new NotFoundError('User');
    const rate = await currencyService.getUsdToZwg();
    const amount = new Decimal(amountUsd);
    await prisma.$transaction(async (tx) => {
      await tx.wallet.upsert({
        where: { userId },
        update: { balanceUsd: { increment: amount } },
        create: { userId, balanceUsd: amount },
      });
      await ledgerService.recordWallet(tx, { userId, deltaUsd: amount, type: 'WALLET_CREDIT', rate: rate?.rate ?? 0, memo });
    });
    return this.summary(userId);
  },

  async summary(userId: string) {
    const [balance, rate, entries] = await Promise.all([
      this.balance(userId),
      currencyService.getUsdToZwg(),
      prisma.ledgerEntry.findMany({
        where: { userId, type: { in: ['WALLET_CREDIT', 'WALLET_DEBIT'] } },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { id: true, type: true, walletDeltaUsd: true, memo: true, orderId: true, createdAt: true },
      }),
    ]);
    return {
      balance: money(balance, rate),
      history: entries.map((e) => ({ id: e.id, type: e.type, amount: money(e.walletDeltaUsd, rate), memo: e.memo, orderId: e.orderId, createdAt: e.createdAt })),
    };
  },
};
