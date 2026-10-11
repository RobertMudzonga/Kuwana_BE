import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';

type Db = Prisma.TransactionClient | typeof prisma;

/** Platform-wide fees. Stored as a single row with id 1, created on first use. */
export async function getSettings(db: Db = prisma) {
  return db.platformSetting.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
}

export async function updateSettings(dto: { commissionPercent?: number; serviceFee?: number; taxPercent?: number; currency?: string }) {
  await getSettings();
  return prisma.platformSetting.update({ where: { id: 1 }, data: dto });
}
