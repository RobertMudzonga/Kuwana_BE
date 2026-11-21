import { z } from 'zod';
import { zwMobile } from '../auth/auth.schema';

export const hubQueueSchema = z.object({
  tab: z.enum(['to_pick', 'packed', 'out', 'done']).default('to_pick'),
  hubId: z.string().uuid().optional(),
});
export const hubOnlySchema = z.object({ hubId: z.string().uuid().optional() });

export const dispatchSchema = z.object({
  driverId: z.string().uuid().optional(),
  courierName: z.string().trim().min(2).max(80).optional(),
  trackingNumber: z.string().trim().max(80).optional(),
});

export const binSchema = z.object({ bin: z.string().trim().max(30).nullable() });

export const handoverSchema = z.object({
  pin: z.string().regex(/^\d{6}$/, 'Enter the 6-digit PIN'),
  /** Required for cash orders, in the order's currency */
  cashCollected: z.number().min(0).max(1_000_000).multipleOf(0.01).optional(),
});

export const failSchema = z.object({
  reason: z.enum(['NOT_HOME', 'REFUSED', 'WRONG_ADDRESS', 'OTHER']),
  note: z.string().trim().max(300).optional(),
});

export const codListSchema = z.object({
  status: z.enum(['COLLECTED', 'VERIFIED', 'DISCREPANCY']).optional(),
  hubId: z.string().uuid().optional(),
});

export const codVerifySchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
  counted: z.object({ USD: z.number().min(0).optional(), ZWG: z.number().min(0).optional() }),
  note: z.string().trim().max(300).optional(),
});

export const returnsListSchema = z.object({
  status: z.enum(['APPROVED', 'DROPPED_OFF', 'RECEIVED', 'REFUNDED', 'REJECTED', 'CANCELLED']).optional(),
});

export const inspectSchema = z.object({
  approve: z.boolean(),
  note: z.string().trim().min(3).max(500),
  sellerAtFault: z.boolean().optional(),
  resellableItemIds: z.array(z.string().uuid()).optional(),
});

export const createReturnSchema = z
  .object({
    orderId: z.string().uuid(),
    items: z.array(z.object({ orderItemId: z.string().uuid(), quantity: z.number().int().min(1).max(99) })).min(1).max(50),
    reason: z.enum(['DEFECTIVE', 'WRONG_ITEM', 'DAMAGED_IN_TRANSIT', 'NOT_AS_DESCRIBED']),
    details: z.string().trim().max(1000).optional(),
    method: z.enum(['DROP_OFF', 'COURIER_COLLECTION']),
    pickupPointId: z.string().uuid().optional(),
    refundDestination: z.enum(['WALLET', 'ORIGINAL']),
  })
  .refine((v) => v.method !== 'DROP_OFF' || !!v.pickupPointId, { message: 'Choose a pickup point', path: ['pickupPointId'] });

export const analyticsSchema = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });

export const staffSchema = z.object({
  email: z.string().email(),
  fullName: z.string().trim().min(2).max(100),
  phone: zwMobile.optional(),
  password: z.string().min(8).max(100).optional(),
  role: z.enum(['WAREHOUSE', 'DRIVER', 'PICKUP_AGENT']),
  hubId: z.string().uuid().optional(),
  pickupPointId: z.string().uuid().optional(),
});
