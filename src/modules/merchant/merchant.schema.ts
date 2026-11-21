import { z } from 'zod';

const inboundItems = z
  .array(z.object({ offerId: z.string().uuid(), quantity: z.number().int().min(1).max(100_000) }))
  .min(1, 'Add at least one product')
  .max(200)
  .refine((list) => new Set(list.map((i) => i.offerId)).size === list.length, 'Each product may appear only once');

export const createInboundSchema = z.object({
  hubId: z.string().uuid(),
  expectedArrival: z.coerce.date().optional(),
  carrier: z.string().trim().max(80).optional(),
  notes: z.string().trim().max(500).optional(),
  items: inboundItems,
});

export const updateInboundSchema = createInboundSchema.omit({ hubId: true }).partial();

export const receiveInboundSchema = z.object({
  items: z.array(z.object({
    itemId: z.string().uuid(),
    received: z.number().int().min(0).max(100_000),
    damaged: z.number().int().min(0).max(100_000).default(0),
    /** Shelf / bin where the units were put away */
    bin: z.string().trim().max(30).optional(),
  })).min(1),
  notes: z.string().trim().max(500).optional(),
});

export const hubInboundQuerySchema = z.object({
  hubId: z.string().uuid().optional(),
  status: z.enum(['DRAFT', 'SUBMITTED', 'RECEIVED', 'CANCELLED']).optional(),
});

export const shipmentsQuerySchema = z.object({
  tab: z.enum(['to_dispatch', 'in_transit', 'delivered', 'cancelled', 'all']).default('to_dispatch'),
});

export const dispatchSchema = z.object({
  courierName: z.string().trim().min(2).max(80),
  trackingNumber: z.string().trim().max(80).optional(),
});

export const deliverSchema = z.object({ pin: z.string().regex(/^\d{6}$/, 'Enter the 6-digit PIN') });

export const requestPayoutSchema = z.object({
  currency: z.enum(['USD', 'ZWG']),
  /** Omit to withdraw everything available */
  amountUsd: z.number().positive().max(1_000_000).multipleOf(0.01).optional(),
});

export const statementQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const payoutListQuerySchema = z.object({
  status: z.enum(['REQUESTED', 'APPROVED', 'PAID', 'REJECTED']).optional(),
});

export const markPaidSchema = z.object({ externalRef: z.string().trim().min(3).max(100) });
export const rejectPayoutSchema = z.object({ note: z.string().trim().min(3).max(300) });
