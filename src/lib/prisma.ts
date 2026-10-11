import { PrismaClient, Prisma } from '@prisma/client';
import { env } from '../config/env';

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

// Money columns are Decimal; send them to clients as JSON numbers (12.5), not strings ("12.50")
(Prisma.Decimal.prototype as unknown as { toJSON: () => number }).toJSON = function (this: Prisma.Decimal) {
  return this.toNumber();
};

// Prevent multiple instances during hot-reload in development
const prisma = global.__prisma ?? new PrismaClient({
  log: env.NODE_ENV === 'development'
    ? ['query', 'info', 'warn', 'error']
    : ['warn', 'error'],
});

if (env.NODE_ENV !== 'production') {
  global.__prisma = prisma;
}

export default prisma;
