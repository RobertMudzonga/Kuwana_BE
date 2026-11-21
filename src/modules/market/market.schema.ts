import { z } from 'zod';
import { zwMobile } from '../auth/auth.schema';

const items = z
  .array(z.object({ offerId: z.string().uuid(), quantity: z.number().int().min(1).max(99) }))
  .min(1, 'Your cart is empty')
  .max(50, 'At most 50 different items per order')
  .refine((list) => new Set(list.map((i) => i.offerId)).size === list.length, 'Each offer may appear only once');

/** A one-off drop-off typed at checkout, e.g. a diaspora buyer sending a gift to family in Zimbabwe */
export const inlineAddressSchema = z
  .object({
    cityId: z.string().uuid(),
    suburbId: z.string().uuid().optional(),
    line1: z.string().trim().min(3).max(200),
    /** Directions where street numbers are ambiguous */
    landmark: z.string().trim().min(3, 'Add a landmark so the driver can find the place').max(200),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    instructions: z.string().trim().max(300).optional(),
  })
  .refine((v) => (v.lat === undefined) === (v.lng === undefined), { message: 'Send lat and lng together', path: ['lat'] });

const fulfilment = z.discriminatedUnion('mode', [
  /** Saved address (addressId) or a one-off address typed at checkout (address) */
  z.object({ mode: z.literal('DELIVERY'), addressId: z.string().uuid().optional(), address: inlineAddressSchema.optional() }),
  z.object({ mode: z.literal('PICKUP'), pickupPointId: z.string().uuid() }),
]);

const depositMethod = z.enum(['ECOCASH', 'INNBUCKS']);

const paymentMethod = z.enum(['ECOCASH', 'ONEMONEY', 'INNBUCKS', 'ZIMSWITCH', 'CARD', 'WALLET', 'CASH']);

const recipient = z.object({
  name: z.string().trim().min(2).max(100),
  phone: zwMobile,
  /** National ID / passport, checked at handover (diaspora gifts) */
  idNumber: z.string().trim().max(30).optional(),
});

const quoteBase = z.object({
  items,
  /** Omit on the cart page; required to price delivery */
  fulfilment: fulfilment.optional(),
  speed: z.enum(['STANDARD', 'EXPRESS']).default('STANDARD'),
  paymentCurrency: z.enum(['USD', 'ZWG']).default('USD'),
  paymentMethod: paymentMethod.optional(),
  /** Set when someone else receives the parcel (affects COD eligibility) */
  recipient: recipient.optional(),
});

const oneAddress = (v: { fulfilment?: { mode: string; addressId?: string; address?: unknown } }) =>
  !v.fulfilment || v.fulfilment.mode !== 'DELIVERY' || (!!v.fulfilment.addressId !== !!v.fulfilment.address);
const oneAddressMessage = { message: 'Choose a saved address or enter one, not both', path: ['fulfilment'] };

export const placeOrderSchema = z
  .object({
    items,
    fulfilment,
    speed: z.enum(['STANDARD', 'EXPRESS']).default('STANDARD'),
    paymentCurrency: z.enum(['USD', 'ZWG']),
    paymentMethod,
    /** Mobile money number to charge (EcoCash / OneMoney / InnBucks), also for a COD deposit */
    paymentPhone: zwMobile.optional(),
    /** Cash on delivery: how the upfront delivery-fee deposit is paid */
    depositMethod: depositMethod.optional(),
    recipient: recipient.optional(),
    notes: z.string().trim().max(500).optional(),
    /** Total the buyer saw on the quote; if prices moved, the order is refused so they can review */
    expectedTotalUsd: z.number().min(0),
  })
  .refine((v) => !['ECOCASH', 'ONEMONEY', 'INNBUCKS'].includes(v.paymentMethod) || !!v.paymentPhone, {
    message: 'Enter the mobile number to charge',
    path: ['paymentPhone'],
  })
  .refine(oneAddress, oneAddressMessage);

/** Retry a payment. For a COD order awaiting its deposit, only EcoCash / InnBucks apply. */
export const payOrderSchema = z.object({
  paymentMethod: z.enum(['ECOCASH', 'ONEMONEY', 'INNBUCKS', 'ZIMSWITCH', 'CARD', 'WALLET']),
  paymentPhone: zwMobile.optional(),
});

export const codOtpSchema = z.object({ code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') });

export const cancelOrderSchema = z.object({ reason: z.string().trim().max(300).optional() });

export const walletCreditSchema = z.object({
  userId: z.string().uuid(),
  amountUsd: z.number().positive().max(10_000).multipleOf(0.01),
  memo: z.string().trim().min(3).max(200),
});

export const quoteSchema = quoteBase.refine(oneAddress, oneAddressMessage);

export type QuoteDto = z.infer<typeof quoteSchema>;
export type PlaceOrderDto = z.infer<typeof placeOrderSchema>;
