import { Prisma, FulfilmentType, PaymentMethod } from '@prisma/client';
import prisma from '../../lib/prisma';
import { haversineDistanceKm } from '../../lib/geo';
import { getSettings } from '../settings/settings.service';

type Db = Prisma.TransactionClient | typeof prisma;

export interface CheckoutRequest {
  items: { serviceId: string; quantity: number; optionIds: string[]; notes?: string }[];
  fulfilment: FulfilmentType;
  addressId?: string;
  paymentMethod: PaymentMethod;
  paymentPhone?: string;
  scheduledFor?: string | null;
  promoCode?: string;
  notes?: string;
}

export interface PlannedLine {
  serviceId: string;
  title: string;
  imageUrl: string | null;
  unitPriceCents: number;
  quantity: number;
  options: { groupId: string; groupName: string; optionId: string; name: string; price: number }[];
  notes?: string;
  stockTracked: boolean;
}

export interface PlannedVendor {
  providerId: string;
  providerName: string;
  prepMinutes: number | null;
  lines: PlannedLine[];
  subtotalCents: number;
  deliveryFeeCents: number;
  serviceFeeCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  commissionCents: number;
}

export interface CheckoutPlan {
  currency: string;
  vendors: PlannedVendor[];
  address: Prisma.InputJsonValue | null;
  scheduledAt: Date | null;
  promoCode: string | null;
  /** Units per stock-tracked service, for the stock decrement */
  stockNeeded: Map<string, { quantity: number; title: string }>;
}

const toCents = (v: Prisma.Decimal | number) => Math.round(Number(v) * 100);
const fromCents = (c: number) => Math.round(c) / 100;
const money = (c: number, currency: string) => `${currency} ${fromCents(c).toFixed(2)}`;

/** Spread `total` cents across `weights` proportionally; the last share absorbs rounding */
function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!sum || !total) return weights.map(() => 0);
  let remaining = total;
  return weights.map((w, i) => {
    if (i === weights.length - 1) return remaining;
    const share = Math.floor((total * w) / sum);
    remaining -= share;
    return share;
  });
}

/**
 * Price a cart. Never trusts client prices: everything is recalculated from the database.
 * `errors` holds problems that must block ordering; a bad promo code is reported separately
 * in `promoError` so the customer can still order without it.
 */
export async function buildQuote(db: Db, userId: string, req: CheckoutRequest) {
  const errors: string[] = [];
  const serviceIds = [...new Set(req.items.map((i) => i.serviceId))];

  const [services, settings, address] = await Promise.all([
    db.service.findMany({
      where: { id: { in: serviceIds } },
      include: { provider: true, optionGroups: { include: { options: true }, orderBy: { sortOrder: 'asc' } } },
    }),
    getSettings(db),
    req.fulfilment === 'DELIVERY' && req.addressId
      ? db.address.findFirst({ where: { id: req.addressId, userId } })
      : Promise.resolve(null),
  ]);
  const byId = new Map(services.map((s) => [s.id, s]));

  // ── Lines ─────────────────────────────────────────────
  const vendors = new Map<string, PlannedVendor & { provider: (typeof services)[number]['provider'] }>();
  const stockNeeded = new Map<string, { quantity: number; title: string }>();
  const currencies = new Set<string>();

  for (const item of req.items) {
    const service = byId.get(item.serviceId);
    if (!service || !service.isActive) {
      errors.push('An item in your cart is no longer sold. Remove it to continue.');
      continue;
    }
    const provider = service.provider;
    if (provider.approvalStatus !== 'APPROVED') {
      errors.push(`${provider.businessName} is not taking orders.`);
      continue;
    }
    if (provider.userId === userId) {
      errors.push("You can't order from your own store.");
      continue;
    }
    if (!service.isAvailable) errors.push(`${service.title} is currently unavailable.`);
    currencies.add(service.currency);

    // Options: each id must belong to this service; required groups and limits respected
    const chosen: PlannedLine['options'] = [];
    const optionIds = new Set(item.optionIds);
    let optionsValid = true;
    for (const group of service.optionGroups) {
      const picked = group.options.filter((o) => optionIds.has(o.id));
      picked.forEach((o) => optionIds.delete(o.id));
      if (group.required && picked.length === 0) {
        errors.push(`Choose ${group.name.toLowerCase()} for ${service.title}.`);
        optionsValid = false;
      }
      if (picked.length > group.maxSelect) {
        errors.push(`Choose at most ${group.maxSelect} ${group.name.toLowerCase()} for ${service.title}.`);
        optionsValid = false;
      }
      picked.forEach((o) => chosen.push({ groupId: group.id, groupName: group.name, optionId: o.id, name: o.name, price: Number(o.price) }));
    }
    if (optionIds.size > 0) {
      errors.push(`Some choices for ${service.title} have changed. Remove it and add it again.`);
      optionsValid = false;
    }
    if (!optionsValid) continue;

    if (service.stock !== null) {
      const prev = stockNeeded.get(service.id)?.quantity ?? 0;
      stockNeeded.set(service.id, { quantity: prev + item.quantity, title: service.title });
    }

    let vendor = vendors.get(provider.id);
    if (!vendor) {
      vendor = {
        provider,
        providerId: provider.id,
        providerName: provider.businessName,
        prepMinutes: provider.estimatedPrepMinutes,
        lines: [],
        subtotalCents: 0, deliveryFeeCents: 0, serviceFeeCents: 0, discountCents: 0, taxCents: 0, totalCents: 0, commissionCents: 0,
      };
      vendors.set(provider.id, vendor);
    }
    const unitPriceCents = toCents(service.price) + chosen.reduce((sum, o) => sum + toCents(o.price), 0);
    vendor.lines.push({
      serviceId: service.id,
      title: service.title,
      imageUrl: service.imageUrl,
      unitPriceCents,
      quantity: item.quantity,
      options: chosen,
      notes: item.notes?.trim() || undefined,
      stockTracked: service.stock !== null,
    });
    vendor.subtotalCents += unitPriceCents * item.quantity;
  }

  for (const [serviceId, need] of stockNeeded) {
    const stock = byId.get(serviceId)!.stock!;
    if (need.quantity > stock) {
      errors.push(stock === 0 ? `${need.title} is sold out.` : `Only ${stock} × ${need.title} left.`);
    }
  }

  if (currencies.size > 1) errors.push('Items priced in different currencies must be ordered separately.');
  const currency = [...currencies][0] ?? settings.currency;

  // ── Fulfilment & address ──────────────────────────────
  if (req.fulfilment === 'DELIVERY') {
    if (!req.addressId) errors.push('Choose a delivery address.');
    else if (!address) errors.push('That delivery address was not found. Choose another.');
  }

  let scheduledAt: Date | null = null;
  if (req.scheduledFor) {
    scheduledAt = new Date(req.scheduledFor);
    const now = Date.now();
    if (scheduledAt.getTime() < now) errors.push('The scheduled time has passed. Choose a later time.');
    if (scheduledAt.getTime() > now + 7 * 24 * 60 * 60 * 1000) errors.push('Orders can be scheduled up to 7 days ahead.');
  }

  const vendorList = [...vendors.values()];
  for (const v of vendorList) {
    const p = v.provider;
    if (!p.isOpen) errors.push(`${p.businessName} is closed right now.`);
    if (req.fulfilment === 'DELIVERY' && !p.offersDelivery) errors.push(`${p.businessName} doesn't deliver. Choose collection.`);
    if (req.fulfilment === 'COLLECTION' && !p.offersCollection) errors.push(`${p.businessName} doesn't offer collection. Choose delivery.`);
    const minOrder = toCents(p.minOrder);
    if (minOrder > 0 && v.subtotalCents < minOrder) {
      errors.push(`${p.businessName} has a minimum order of ${money(minOrder, currency)}.`);
    }
    if (req.fulfilment === 'DELIVERY') {
      v.deliveryFeeCents = toCents(p.deliveryFee);
      if (address?.lat != null && address?.lng != null && p.lat != null && p.lng != null && p.deliveryRadiusKm) {
        const km = haversineDistanceKm({ lat: p.lat, lng: p.lng }, { lat: address.lat, lng: address.lng });
        if (km > p.deliveryRadiusKm) {
          errors.push(`Your address is ${km.toFixed(1)} km away, outside ${p.businessName}'s ${p.deliveryRadiusKm} km delivery area.`);
        }
      }
    }
  }

  // ── Promo code ────────────────────────────────────────
  const subtotalCents = vendorList.reduce((sum, v) => sum + v.subtotalCents, 0);
  let promoError: string | null = null;
  let appliedPromo: string | null = null;
  let discountCents = 0;
  if (req.promoCode) {
    const code = req.promoCode.trim().toUpperCase();
    const promo = await db.promoCode.findUnique({ where: { code } });
    if (!promo || !promo.isActive) promoError = 'That promo code is not valid.';
    else if (promo.expiresAt && promo.expiresAt < new Date()) promoError = 'That promo code has expired.';
    else if (promo.maxUses !== null && promo.usedCount >= promo.maxUses) promoError = 'That promo code has been fully used.';
    else if (subtotalCents < toCents(promo.minSubtotal)) {
      promoError = `Spend at least ${money(toCents(promo.minSubtotal), currency)} to use this code.`;
    } else {
      discountCents = promo.type === 'PERCENT'
        ? Math.round((subtotalCents * Number(promo.value)) / 100)
        : Math.min(toCents(promo.value), subtotalCents);
      appliedPromo = promo.code;
    }
  }

  // ── Fees, tax, totals ─────────────────────────────────
  const discounts = allocate(discountCents, vendorList.map((v) => v.subtotalCents));
  const serviceFeeCents = vendorList.length ? toCents(settings.serviceFee) : 0;
  const taxPercent = Number(settings.taxPercent);
  const commissionPercent = Number(settings.commissionPercent);
  vendorList.forEach((v, i) => {
    v.discountCents = discounts[i];
    v.serviceFeeCents = i === 0 ? serviceFeeCents : 0; // charged once per checkout
    v.taxCents = Math.round(((v.subtotalCents - v.discountCents) * taxPercent) / 100);
    v.totalCents = v.subtotalCents - v.discountCents + v.deliveryFeeCents + v.serviceFeeCents + v.taxCents;
    v.commissionCents = Math.round((v.subtotalCents * commissionPercent) / 100);
  });

  const sum = (key: keyof PlannedVendor) => vendorList.reduce((acc, v) => acc + (v[key] as number), 0);
  const quote = {
    currency,
    subtotal: fromCents(subtotalCents),
    deliveryFee: fromCents(sum('deliveryFeeCents')),
    serviceFee: fromCents(sum('serviceFeeCents')),
    tax: fromCents(sum('taxCents')),
    discount: fromCents(sum('discountCents')),
    total: fromCents(sum('totalCents')),
    vendors: vendorList.map((v) => ({
      providerId: v.providerId,
      providerName: v.providerName,
      subtotal: fromCents(v.subtotalCents),
      deliveryFee: fromCents(v.deliveryFeeCents),
    })),
    promoCode: appliedPromo,
    promoError,
    errors: [...new Set(errors)],
  };

  const plan: CheckoutPlan = {
    currency,
    vendors: vendorList.map(({ provider: _p, ...v }) => v),
    address: address
      ? { id: address.id, label: address.label, line1: address.line1, line2: address.line2, city: address.city, lat: address.lat, lng: address.lng, instructions: address.instructions }
      : null,
    scheduledAt,
    promoCode: appliedPromo,
    stockNeeded,
  };

  return { quote, plan };
}

export { fromCents };
