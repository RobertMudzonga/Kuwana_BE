import bcrypt from 'bcryptjs';
import { z } from 'zod';
import prisma from '../../lib/prisma';
import { env } from '../../config/env';
import { BadRequestError, ConflictError, NotFoundError } from '../../middleware/error.middleware';
import { passwordRule, zwMobile } from '../auth/auth.schema';
import { StoreContext, assertOwner } from './store.context';

export const createStaffSchema = z.object({
  fullName: z.string().trim().min(2).max(100),
  email: z.string().trim().toLowerCase().email(),
  phone: zwMobile.optional(),
  /** Temporary password the owner shares; staff can change it later */
  password: passwordRule,
  branchId: z.string().uuid(),
});

export const updateStaffSchema = z.object({
  branchId: z.string().uuid().optional(),
  /** Suspend to remove access (e.g. staff left) */
  active: z.boolean().optional(),
});

const select = {
  id: true, email: true, phone: true, status: true, createdAt: true,
  profile: { select: { fullName: true } },
  staffBranch: { select: { id: true, code: true, name: true } },
} as const;

type StaffRow = { id: string; email: string; phone: string | null; status: string; createdAt: Date; profile: { fullName: string } | null; staffBranch: { id: string; code: string; name: string } | null };
const dto = (u: StaffRow) => ({
  id: u.id, fullName: u.profile?.fullName ?? u.email, email: u.email, phone: u.phone, active: u.status === 'ACTIVE', branch: u.staffBranch, createdAt: u.createdAt,
});

/** Branch staff accounts, managed by the store owner. Staff log in and see only their branch's orders. */
export const storeStaffService = {
  async list(ctx: StoreContext) {
    assertOwner(ctx);
    const rows = await prisma.user.findMany({ where: { role: 'STORE_STAFF', storeBranchId: { in: ctx.branchIds } }, select, orderBy: { createdAt: 'asc' } });
    return rows.map(dto);
  },

  async create(ctx: StoreContext, input: z.infer<typeof createStaffSchema>) {
    assertOwner(ctx);
    if (!ctx.branchIds.includes(input.branchId)) throw new BadRequestError('Choose one of your branches');
    if (await prisma.user.findUnique({ where: { email: input.email }, select: { id: true } })) throw new ConflictError('That email already has a Kuwana account');
    if (input.phone && (await prisma.user.findUnique({ where: { phone: input.phone }, select: { id: true } }))) throw new ConflictError('That phone number already has a Kuwana account');
    const user = await prisma.user.create({
      data: {
        email: input.email, phone: input.phone, role: 'STORE_STAFF', storeBranchId: input.branchId,
        passwordHash: await bcrypt.hash(input.password, env.BCRYPT_SALT_ROUNDS), emailVerified: true,
        profile: { create: { fullName: input.fullName } },
      },
      select,
    });
    return dto(user);
  },

  async update(ctx: StoreContext, staffId: string, input: z.infer<typeof updateStaffSchema>) {
    assertOwner(ctx);
    const existing = await prisma.user.findUnique({ where: { id: staffId }, select: { role: true, storeBranchId: true } });
    if (!existing || existing.role !== 'STORE_STAFF' || !existing.storeBranchId || !ctx.branchIds.includes(existing.storeBranchId)) throw new NotFoundError('Staff member');
    if (input.branchId && !ctx.branchIds.includes(input.branchId)) throw new BadRequestError('Choose one of your branches');
    const user = await prisma.user.update({
      where: { id: staffId },
      data: {
        ...(input.branchId ? { storeBranchId: input.branchId } : {}),
        ...(input.active !== undefined ? { status: input.active ? 'ACTIVE' : 'SUSPENDED' } : {}),
      },
      select,
    });
    // Suspended staff are signed out everywhere
    if (input.active === false) await prisma.refreshToken.deleteMany({ where: { userId: staffId } });
    return dto(user);
  },
};
