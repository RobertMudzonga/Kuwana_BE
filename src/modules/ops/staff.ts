import prisma from '../../lib/prisma';
import { ForbiddenError } from '../../middleware/error.middleware';

export interface StaffContext {
  id: string;
  role: 'ADMIN' | 'WAREHOUSE' | 'DRIVER' | 'PICKUP_AGENT';
  name: string;
  /** null for admins (all hubs) */
  hubId: string | null;
  pickupPointId: string | null;
  hub: { id: string; code: string; name: string } | null;
  pickupPoint: { id: string; code: string; name: string } | null;
}

const STAFF_ROLES = ['ADMIN', 'WAREHOUSE', 'DRIVER', 'PICKUP_AGENT'];

/** Who is acting and which hub / pickup point they work at. Staff without an assignment are refused. */
export async function staffContext(userId: string): Promise<StaffContext> {
  const u = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      id: true, role: true, hubId: true, pickupPointId: true, email: true,
      profile: { select: { fullName: true } },
      staffHub: { select: { id: true, code: true, name: true } },
      staffPickupPoint: { select: { id: true, code: true, name: true } },
    },
  });
  if (!STAFF_ROLES.includes(u.role)) throw new ForbiddenError('This area is for Kuwana staff');
  if (u.role === 'WAREHOUSE' && !u.hubId) throw new ForbiddenError('Ask an admin to assign you to a hub');
  if (u.role === 'PICKUP_AGENT' && !u.pickupPointId) throw new ForbiddenError('Ask an admin to link you to your pickup point');
  return {
    id: u.id,
    role: u.role as StaffContext['role'],
    name: u.profile?.fullName || u.email,
    hubId: u.role === 'ADMIN' ? null : u.hubId,
    pickupPointId: u.pickupPointId,
    hub: u.staffHub,
    pickupPoint: u.staffPickupPoint,
  };
}

/** Hub filter for queries: staff see their hub, admins see all (or the one they ask for) */
export function hubScope(ctx: StaffContext, requested?: string): string | undefined {
  if (ctx.role === 'ADMIN') return requested;
  if (requested && requested !== ctx.hubId) throw new ForbiddenError('You can only work on your own hub');
  return ctx.hubId ?? undefined;
}
