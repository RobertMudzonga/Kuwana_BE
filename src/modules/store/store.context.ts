import prisma from '../../lib/prisma';
import { ForbiddenError } from '../../middleware/error.middleware';
import { JwtPayload } from '../../middleware/auth.middleware';

/** Who is acting in the store portal and which branches they can see */
export interface StoreContext {
  userId: string;
  sellerId: string;
  storeName: string;
  kycStatus: string;
  /** Owners see every branch; staff only their own */
  branchIds: string[];
  isOwner: boolean;
}

export async function storeContext(user: JwtPayload): Promise<StoreContext> {
  if (user.role === 'STORE_STAFF') {
    const me = await prisma.user.findUnique({
      where: { id: user.sub },
      select: { status: true, staffBranch: { select: { id: true, isActive: true, seller: { select: { id: true, businessName: true, kycStatus: true } } } } },
    });
    const branch = me?.staffBranch;
    if (!branch || me.status !== 'ACTIVE') throw new ForbiddenError('You are not assigned to a store branch');
    if (!branch.isActive) throw new ForbiddenError('Your branch is closed');
    return {
      userId: user.sub, sellerId: branch.seller.id, storeName: branch.seller.businessName, kycStatus: branch.seller.kycStatus,
      branchIds: [branch.id], isOwner: false,
    };
  }
  const seller = await prisma.sellerProfile.findUnique({
    where: { userId: user.sub },
    select: { id: true, businessName: true, kycStatus: true, branches: { select: { id: true } } },
  });
  if (!seller) throw new ForbiddenError('Set up a store first');
  return {
    userId: user.sub, sellerId: seller.id, storeName: seller.businessName, kycStatus: seller.kycStatus,
    branchIds: seller.branches.map((b) => b.id), isOwner: true,
  };
}

export function assertOwner(ctx: StoreContext) {
  if (!ctx.isOwner) throw new ForbiddenError('Only the store owner can do this');
}
