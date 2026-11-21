import { DriverWalletEntryType, Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { BadRequestError } from '../../middleware/error.middleware';

type Tx = Prisma.TransactionClient;
const Decimal = Prisma.Decimal;
type Numeric = Prisma.Decimal | number | string;

export interface WalletDeltas {
  available?: Numeric;
  locked?: Numeric;
  earnings?: Numeric;
}

export interface WalletMeta {
  jobId?: string | null;
  reference?: string | null;
  memo?: string | null;
  actorId?: string | null;
  /** Message when the wallet can't cover the move */
  insufficient?: string;
}

/**
 * Move money between a driver's buckets in one guarded statement: the update only applies if no
 * bucket would go negative (also enforced by CHECK constraints), then an append-only entry records
 * the change and the balances after it.
 */
export async function moveWallet(tx: Tx, driverId: string, type: DriverWalletEntryType, d: WalletDeltas, meta: WalletMeta = {}) {
  const a = new Decimal(d.available ?? 0);
  const l = new Decimal(d.locked ?? 0);
  const e = new Decimal(d.earnings ?? 0);
  await tx.driverWallet.upsert({ where: { driverId }, update: {}, create: { driverId } });
  const rows = await tx.$queryRaw<{ available: Prisma.Decimal; locked: Prisma.Decimal; earnings: Prisma.Decimal }[]>`
    UPDATE driver_wallets SET
      available_float_usd = available_float_usd + ${a.toString()}::numeric,
      locked_float_usd = locked_float_usd + ${l.toString()}::numeric,
      withdrawable_earnings_usd = withdrawable_earnings_usd + ${e.toString()}::numeric,
      updated_at = now()
    WHERE driver_id = ${driverId}
      AND available_float_usd + ${a.toString()}::numeric >= 0
      AND locked_float_usd + ${l.toString()}::numeric >= 0
      AND withdrawable_earnings_usd + ${e.toString()}::numeric >= 0
    RETURNING available_float_usd AS available, locked_float_usd AS locked, withdrawable_earnings_usd AS earnings`;
  if (!rows.length) throw new BadRequestError(meta.insufficient ?? 'Not enough balance in your driver wallet');
  const after = rows[0];
  return tx.driverWalletEntry.create({
    data: {
      driverId, type, availableDeltaUsd: a, lockedDeltaUsd: l, earningsDeltaUsd: e,
      availableAfterUsd: after.available, lockedAfterUsd: after.locked, earningsAfterUsd: after.earnings,
      deliveryJobId: meta.jobId ?? null, reference: meta.reference ?? null, memo: meta.memo ?? null, createdById: meta.actorId ?? null,
    },
  });
}

export async function walletDto(driverId: string, db: Tx | typeof prisma = prisma) {
  const w = await db.driverWallet.findUnique({ where: { driverId } });
  const n = (v: Prisma.Decimal | undefined) => (v ?? new Decimal(0)).toNumber();
  return {
    availableFloatUsd: n(w?.availableFloatUsd),
    lockedFloatUsd: n(w?.lockedFloatUsd),
    withdrawableEarningsUsd: n(w?.withdrawableEarningsUsd),
  };
}
