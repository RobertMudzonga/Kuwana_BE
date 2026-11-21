import { Prisma } from '@prisma/client';
import { z } from 'zod';
import prisma from '../../lib/prisma';
import { BadRequestError, ConflictError, NotFoundError } from '../../middleware/error.middleware';
import { invalidateFeeBands } from '../catalog/buybox.service';

/**
 * Admin location engine: cities, suburbs, per-city pricing zones, the zone pricing matrix and pickup points.
 * Any change that affects delivery prices clears the pricing cache.
 */

const Decimal = Prisma.Decimal;
const HARARE_OFFSET_MS = 2 * 60 * 60 * 1000;
const usd = z.number().min(0).max(1000).multipleOf(0.01);
const lat = z.number().min(-23).max(-15);
const lng = z.number().min(25).max(34);

const slugify = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Midnight today, Africa/Harare, as a UTC instant */
export function harareDayStart(now = new Date()): Date {
  const local = new Date(now.getTime() + HARARE_OFFSET_MS);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() - HARARE_OFFSET_MS);
}

function harareMonthStart(now = new Date()): Date {
  const local = new Date(now.getTime() + HARARE_OFFSET_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - HARARE_OFFSET_MS);
}

// ── Schemas ─────────────────────────────────────────────

export const citySchema = z.object({
  name: z.string().trim().min(2).max(60),
  province: z.string().trim().min(2).max(60),
  zone: z.enum(['METRO', 'INTERCITY']).default('INTERCITY'),
  codEligible: z.boolean().default(false),
  lat: lat.optional(),
  lng: lng.optional(),
  sortOrder: z.number().int().min(0).max(999).default(0),
  isActive: z.boolean().default(true),
});
export const cityUpdateSchema = citySchema.partial();

export const suburbSchema = z.object({
  name: z.string().trim().min(2).max(60),
  lat: lat.nullable().optional(),
  lng: lng.nullable().optional(),
  zoneId: z.string().uuid().nullable().optional(),
  isActive: z.boolean().default(true),
});
export const suburbUpdateSchema = suburbSchema.partial();

export const zoneSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{2,30}$/, 'Use letters, digits and _ (e.g. ZONE_1_INNER)'),
  name: z.string().trim().min(2).max(60),
  sortOrder: z.number().int().min(0).max(99).default(0),
});
export const zoneUpdateSchema = zoneSchema.partial();

export const assignZoneSchema = z.object({
  zoneId: z.string().uuid().nullable(),
  suburbIds: z.array(z.string().uuid()).min(1).max(500),
});

export const matrixSchema = z.object({
  rules: z
    .array(
      z.object({
        originZoneId: z.string().uuid(),
        destinationZoneId: z.string().uuid(),
        vehicleClass: z.enum(['BIKE', 'CAR', 'BAKKIE']),
        customerFeeUsd: usd,
        driverPayoutUsd: usd,
        customerPerKmUsd: z.number().min(0).max(20).multipleOf(0.01).default(0),
        driverPerKmUsd: z.number().min(0).max(20).multipleOf(0.01).default(0),
      }),
    )
    .max(500),
});

export const pickupPointSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{3,20}$/, 'Use letters, digits and - (e.g. PP-HRE-AVD)'),
  name: z.string().trim().min(2).max(80),
  type: z.enum(['PARTNER_SHOP', 'MALL', 'BUS_DEPOT', 'COURIER_DEPOT']),
  cityId: z.string().uuid(),
  suburbId: z.string().uuid().nullable().optional(),
  address: z.string().trim().min(3).max(200),
  landmark: z.string().trim().max(200).nullable().optional(),
  lat: lat.nullable().optional(),
  lng: lng.nullable().optional(),
  phone: z.string().regex(/^\+263\d{9}$/, 'Phone as +263…').nullable().optional(),
  operatingHours: z.string().trim().max(120).nullable().optional(),
  agentFeeUsd: usd.default(0),
  maxDailyParcels: z.number().int().min(1).max(10_000).nullable().optional(),
  isActive: z.boolean().default(true),
});
export const pickupPointUpdateSchema = pickupPointSchema.partial();

type CityDto = z.infer<typeof citySchema>;
type SuburbDto = z.infer<typeof suburbSchema>;
type ZoneDto = z.infer<typeof zoneSchema>;
type PickupDto = z.infer<typeof pickupPointSchema>;

function uniqueViolation(err: unknown, message: string): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ConflictError(message);
  throw err;
}

async function assertZoneInCity(zoneId: string | null | undefined, cityId: string) {
  if (!zoneId) return;
  const zone = await prisma.pricingZone.findUnique({ where: { id: zoneId }, select: { cityId: true } });
  if (!zone || zone.cityId !== cityId) throw new BadRequestError('That zone belongs to another town');
}

// ── Pickup-point load (also used by checkout) ─────────────

const LIVE_ORDER_STATUSES = ['PENDING_PAYMENT', 'AWAITING_COD_OTP', 'AWAITING_DEPOSIT', 'CONFIRMED', 'COMPLETED'] as const;

/** Orders booked to each pickup point today (Harare day) */
export async function pickupLoadToday(pointIds: string[]): Promise<Map<string, number>> {
  if (!pointIds.length) return new Map();
  const rows = await prisma.marketOrder.groupBy({
    by: ['pickupPointId'],
    where: { pickupPointId: { in: pointIds }, createdAt: { gte: harareDayStart() }, status: { in: [...LIVE_ORDER_STATUSES] } },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.pickupPointId!, r._count._all]));
}

/** Throws when a pickup point has no room left today */
export async function assertPickupCapacity(point: { id: string; name: string; maxDailyParcels: number | null }) {
  if (!point.maxDailyParcels) return;
  const used = (await pickupLoadToday([point.id])).get(point.id) ?? 0;
  if (used >= point.maxDailyParcels) {
    throw new BadRequestError(`${point.name} is full for today. Choose another pickup point or home delivery.`);
  }
}

// ── Service ──────────────────────────────────────────────

export const locationsService = {
  /** Every town (active or not) with its zones and suburbs */
  async listCities() {
    const cities = await prisma.city.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: {
        pricingZones: { orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }], include: { _count: { select: { suburbs: true } } } },
        suburbs: { orderBy: { name: 'asc' }, include: { _count: { select: { branches: true } } } },
        _count: { select: { pickupPoints: true, storeBranches: true } },
      },
    });
    return cities.map((c) => ({
      id: c.id, name: c.name, slug: c.slug, province: c.province, zone: c.zone, codEligible: c.codEligible,
      lat: c.lat, lng: c.lng, sortOrder: c.sortOrder, isActive: c.isActive,
      pickupPointCount: c._count.pickupPoints, branchCount: c._count.storeBranches,
      zones: c.pricingZones.map((z) => ({ id: z.id, code: z.code, name: z.name, sortOrder: z.sortOrder, suburbCount: z._count.suburbs })),
      suburbs: c.suburbs.map((s) => ({ id: s.id, name: s.name, lat: s.lat, lng: s.lng, zoneId: s.zoneId, isActive: s.isActive, branchCount: s._count.branches })),
      unzonedSuburbs: c.suburbs.filter((s) => s.isActive && !s.zoneId).length,
    }));
  },

  async getCity(id: string) {
    const city = (await this.listCities()).find((c) => c.id === id);
    if (!city) throw new NotFoundError('Town');
    return city;
  },

  async createCity(dto: CityDto) {
    const city = await prisma.city.create({ data: { ...dto, slug: slugify(dto.name) } }).catch((e) => uniqueViolation(e, 'A town with that name already exists'));
    return this.getCity(city.id);
  },

  async updateCity(id: string, dto: Partial<CityDto>) {
    await prisma.city
      .update({ where: { id }, data: { ...dto, ...(dto.name ? { slug: slugify(dto.name) } : {}) } })
      .catch((e) => uniqueViolation(e, 'A town with that name already exists'));
    invalidateFeeBands();
    return this.getCity(id);
  },

  async createSuburb(cityId: string, dto: SuburbDto) {
    await assertZoneInCity(dto.zoneId, cityId);
    await prisma.suburb.create({ data: { ...dto, cityId } }).catch((e) => uniqueViolation(e, 'That suburb already exists in this town'));
    invalidateFeeBands();
    return this.getCity(cityId);
  },

  async updateSuburb(id: string, dto: Partial<SuburbDto>) {
    const sub = await prisma.suburb.findUnique({ where: { id } });
    if (!sub) throw new NotFoundError('Suburb');
    await assertZoneInCity(dto.zoneId, sub.cityId);
    await prisma.suburb.update({ where: { id }, data: dto }).catch((e) => uniqueViolation(e, 'That suburb already exists in this town'));
    invalidateFeeBands();
    return this.getCity(sub.cityId);
  },

  /** Put many suburbs in one zone (or take them out with zoneId null) */
  async assignZone(cityId: string, dto: z.infer<typeof assignZoneSchema>) {
    await assertZoneInCity(dto.zoneId, cityId);
    const { count } = await prisma.suburb.updateMany({ where: { id: { in: dto.suburbIds }, cityId }, data: { zoneId: dto.zoneId } });
    if (count !== dto.suburbIds.length) throw new BadRequestError('Some suburbs are not in this town');
    invalidateFeeBands();
    return this.getCity(cityId);
  },

  async createZone(cityId: string, dto: ZoneDto) {
    if (!(await prisma.city.findUnique({ where: { id: cityId } }))) throw new NotFoundError('Town');
    await prisma.pricingZone.create({ data: { ...dto, cityId } }).catch((e) => uniqueViolation(e, `Zone ${dto.code} already exists in this town`));
    return this.getCity(cityId);
  },

  async updateZone(id: string, dto: Partial<ZoneDto>) {
    const zone = await prisma.pricingZone.findUnique({ where: { id } });
    if (!zone) throw new NotFoundError('Zone');
    await prisma.pricingZone.update({ where: { id }, data: dto }).catch((e) => uniqueViolation(e, `Zone ${dto.code} already exists in this town`));
    return this.getCity(zone.cityId);
  },

  /** Deleting a zone unzones its suburbs (they fall back to distance bands) and drops its rules */
  async deleteZone(id: string) {
    const zone = await prisma.pricingZone.findUnique({ where: { id } });
    if (!zone) throw new NotFoundError('Zone');
    await prisma.pricingZone.delete({ where: { id } });
    invalidateFeeBands();
    return this.getCity(zone.cityId);
  },

  /** A town's zone matrix */
  async getMatrix(cityId: string) {
    const zones = await prisma.pricingZone.findMany({ where: { cityId }, orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] });
    const ids = zones.map((z) => z.id);
    const rules = await prisma.zonePricingRule.findMany({ where: { originZoneId: { in: ids }, destinationZoneId: { in: ids } } });
    return {
      cityId,
      zones: zones.map((z) => ({ id: z.id, code: z.code, name: z.name })),
      rules: rules.map((r) => ({
        originZoneId: r.originZoneId, destinationZoneId: r.destinationZoneId, vehicleClass: r.vehicleClass,
        customerFeeUsd: r.customerFeeUsd.toNumber(), driverPayoutUsd: r.driverPayoutUsd.toNumber(),
        customerPerKmUsd: r.customerPerKmUsd.toNumber(), driverPerKmUsd: r.driverPerKmUsd.toNumber(),
        marginUsd: r.customerFeeUsd.minus(r.driverPayoutUsd).toNumber(),
      })),
    };
  },

  /** Replace a town's whole matrix. A→B also prices B→A unless B→A is set too. */
  async replaceMatrix(cityId: string, dto: z.infer<typeof matrixSchema>) {
    const zones = await prisma.pricingZone.findMany({ where: { cityId }, select: { id: true, code: true } });
    const code = new Map(zones.map((z) => [z.id, z.code]));
    const seen = new Set<string>();
    for (const r of dto.rules) {
      if (!code.has(r.originZoneId) || !code.has(r.destinationZoneId)) throw new BadRequestError('Every rule must use this town’s zones');
      const label = `${code.get(r.originZoneId)} → ${code.get(r.destinationZoneId)} (${r.vehicleClass.toLowerCase()})`;
      const key = `${r.originZoneId}:${r.destinationZoneId}:${r.vehicleClass}`;
      if (seen.has(key)) throw new BadRequestError(`${label} is listed twice`);
      seen.add(key);
      if (r.driverPayoutUsd > r.customerFeeUsd) throw new BadRequestError(`${label}: driver payout can't exceed the customer fee`);
      if (r.driverPerKmUsd > r.customerPerKmUsd) throw new BadRequestError(`${label}: driver per-km can't exceed the customer per-km`);
    }
    const ids = [...code.keys()];
    await prisma.$transaction([
      prisma.zonePricingRule.deleteMany({ where: { OR: [{ originZoneId: { in: ids } }, { destinationZoneId: { in: ids } }] } }),
      prisma.zonePricingRule.createMany({ data: dto.rules }),
    ]);
    invalidateFeeBands();
    return this.getMatrix(cityId);
  },

  // ── Pickup points ──

  async listPickupPoints() {
    const points = await prisma.pickupPoint.findMany({
      orderBy: [{ city: { sortOrder: 'asc' } }, { name: 'asc' }],
      include: { city: { select: { id: true, name: true } }, suburbArea: { select: { id: true, name: true } } },
    });
    const ids = points.map((p) => p.id);
    const [today, month] = await Promise.all([
      pickupLoadToday(ids),
      prisma.shipment.groupBy({
        by: ['orderId'],
        where: { status: 'COLLECTED', deliveredAt: { gte: harareMonthStart() }, order: { pickupPointId: { in: ids } } },
        _count: { _all: true },
      }).then(async (rows) => {
        const orders = await prisma.marketOrder.findMany({ where: { id: { in: rows.map((r) => r.orderId) } }, select: { id: true, pickupPointId: true } });
        const byOrder = new Map(orders.map((o) => [o.id, o.pickupPointId!]));
        const counts = new Map<string, number>();
        for (const r of rows) {
          const pid = byOrder.get(r.orderId)!;
          counts.set(pid, (counts.get(pid) ?? 0) + r._count._all);
        }
        return counts;
      }),
    ]);
    return points.map((p) => {
      const handed = month.get(p.id) ?? 0;
      return {
        id: p.id, code: p.code, name: p.name, type: p.type, city: p.city, suburb: p.suburbArea ?? (p.suburb ? { id: null, name: p.suburb } : null),
        address: p.address, landmark: p.landmark, lat: p.lat, lng: p.lng, phone: p.phone, operatingHours: p.operatingHours,
        agentFeeUsd: p.agentFeeUsd.toNumber(), maxDailyParcels: p.maxDailyParcels, isActive: p.isActive,
        bookedToday: today.get(p.id) ?? 0,
        collectedThisMonth: handed,
        agentFeesThisMonthUsd: p.agentFeeUsd.times(handed).toNumber(),
      };
    });
  },

  async savePickupPoint(id: string | null, dto: Partial<PickupDto>) {
    const existing = id ? await prisma.pickupPoint.findUnique({ where: { id } }) : null;
    if (id && !existing) throw new NotFoundError('Pickup point');
    const cityId = dto.cityId ?? existing?.cityId;
    let suburbName: string | null | undefined;
    if (dto.suburbId !== undefined) {
      if (dto.suburbId) {
        const sub = await prisma.suburb.findUnique({ where: { id: dto.suburbId } });
        if (!sub || sub.cityId !== cityId) throw new BadRequestError('That suburb is not in the selected town');
        suburbName = sub.name;
      } else suburbName = null;
    }
    const data = {
      ...dto,
      ...(suburbName !== undefined ? { suburb: suburbName } : {}),
      ...(dto.agentFeeUsd !== undefined ? { agentFeeUsd: new Decimal(dto.agentFeeUsd) } : {}),
    };
    const saved = id
      ? await prisma.pickupPoint.update({ where: { id }, data }).catch((e) => uniqueViolation(e, 'That code is taken'))
      : await prisma.pickupPoint.create({ data: data as Prisma.PickupPointUncheckedCreateInput }).catch((e) => uniqueViolation(e, 'That code is taken'));
    return (await this.listPickupPoints()).find((p) => p.id === saved.id)!;
  },
};
