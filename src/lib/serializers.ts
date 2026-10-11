import { Prisma } from '@prisma/client';

/**
 * Response shapes shared with the mobile app (see the app's src/hooks/*.ts types).
 * Keep these in sync with docs/API_CONTRACT.md in the app repo.
 */

// ── Users ────────────────────────────────────────────────

type UserWithProfile = {
  id: string;
  email: string;
  phone: string | null;
  phoneVerified: boolean;
  emailVerified: boolean;
  role: string;
  status: string;
  profile?: { fullName: string; avatarUrl: string | null } | null;
};

/** The signed-in user as the app stores it — never includes the password hash */
export function toPublicUser(user: UserWithProfile) {
  return {
    id: user.id,
    email: user.email,
    phone: user.phone ?? undefined,
    phoneVerified: user.phoneVerified,
    emailVerified: user.emailVerified,
    role: user.role,
    status: user.status,
    fullName: user.profile?.fullName ?? '',
    avatarUrl: user.profile?.avatarUrl ?? undefined,
  };
}

// ── Services ─────────────────────────────────────────────

export const serviceInclude = {
  provider: {
    select: { id: true, businessName: true, city: true, rating: true, isVerified: true, isOpen: true, logoUrl: true },
  },
  optionGroups: {
    orderBy: { sortOrder: 'asc' },
    include: { options: { orderBy: { sortOrder: 'asc' } } },
  },
} satisfies Prisma.ServiceInclude;

// ── Providers ────────────────────────────────────────────

/** Public store fields. Deliberately excludes the owner's personal email/phone. */
export const publicProviderSelect = {
  id: true,
  businessName: true,
  description: true,
  category: true,
  address: true,
  city: true,
  lat: true,
  lng: true,
  phone: true,
  website: true,
  logoUrl: true,
  approvalStatus: true,
  isVerified: true,
  rating: true,
  reviewCount: true,
  isOpen: true,
  openingHours: true,
  deliveryFee: true,
  minOrder: true,
  deliveryRadiusKm: true,
  estimatedPrepMinutes: true,
  offersDelivery: true,
  offersCollection: true,
  createdAt: true,
} satisfies Prisma.ProviderSelect;

// ── Orders ───────────────────────────────────────────────

export const orderInclude = {
  items: true,
  provider: { select: { id: true, businessName: true, phone: true, address: true, city: true } },
  user: { select: { id: true, phone: true, profile: { select: { fullName: true } } } },
  statusHistory: { orderBy: { at: 'asc' } },
  review: { select: { rating: true, comment: true } },
  delivery: { include: { driver: { select: { phone: true, profile: { select: { fullName: true } } } } } },
} satisfies Prisma.OrderInclude;

export type OrderWithRelations = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;

export function toOrderDto(order: OrderWithRelations) {
  const delivery = order.delivery;
  const hasDriver = !!delivery?.driverId && delivery.status !== 'CANCELLED';
  return {
    id: order.id,
    reference: order.reference,
    status: order.status,
    fulfilment: order.fulfilment,
    provider: {
      id: order.provider.id,
      businessName: order.provider.businessName,
      phone: order.provider.phone ?? undefined,
      address: [order.provider.address, order.provider.city].filter(Boolean).join(', ') || undefined,
    },
    buyer: {
      id: order.user.id,
      fullName: order.user.profile?.fullName ?? 'Customer',
      phone: order.user.phone ?? undefined,
    },
    items: order.items.map((i) => ({
      id: i.id,
      serviceId: i.serviceId,
      title: i.title,
      imageUrl: i.imageUrl ?? undefined,
      unitPrice: i.unitPrice,
      quantity: i.quantity,
      options: i.options,
      notes: i.notes ?? undefined,
    })),
    currency: order.currency,
    subtotal: order.subtotal,
    deliveryFee: order.deliveryFee,
    serviceFee: order.serviceFee,
    tax: order.tax,
    discount: order.discount,
    total: order.totalAmount,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    address: order.address,
    scheduledFor: order.scheduledAt,
    estimatedReadyAt: order.estimatedReadyAt,
    notes: order.notes ?? undefined,
    cancelReason: order.cancelReason ?? undefined,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    statusHistory: order.statusHistory.map((h) => ({ status: h.status, at: h.at })),
    driver: hasDriver
      ? {
          fullName: delivery!.driver?.profile?.fullName ?? 'Driver',
          phone: delivery!.driver?.phone ?? undefined,
          lat: delivery!.driverLat ?? undefined,
          lng: delivery!.driverLng ?? undefined,
        }
      : null,
    review: order.review,
  };
}
