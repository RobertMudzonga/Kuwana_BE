import prisma from '../../lib/prisma';
import { NotFoundError } from '../../middleware/error.middleware';

/** What an admin needs to approve a store: identity, payout accounts and each branch's map pin */
export const storesKycService = {
  async packet(sellerId: string) {
    const s = await prisma.sellerProfile.findUnique({
      where: { id: sellerId },
      include: {
        user: { select: { email: true, phone: true, phoneVerified: true, profile: { select: { fullName: true } } } },
        city: { select: { name: true } },
        branches: { include: { city: { select: { name: true } }, suburb: { select: { name: true } } }, orderBy: { createdAt: 'asc' } },
      },
    });
    if (!s) throw new NotFoundError('Store');
    const usd = (s.usdPayoutDetails ?? null) as Record<string, string> | null;
    const zig = (s.zigPayoutDetails ?? null) as Record<string, string> | null;
    const branches = s.branches.map((b) => ({
      id: b.id, code: b.code, name: b.name, address: b.address, landmark: b.landmark, city: b.city.name, suburb: b.suburb?.name ?? null,
      lat: b.lat, lng: b.lng, phone: b.phone, isActive: b.isActive,
      mapUrl: `https://www.google.com/maps/search/?api=1&query=${b.lat},${b.lng}`,
      locationVerifiedAt: b.locationVerifiedAt,
    }));
    const checklist = [
      { key: 'ID', label: s.kycTier === 'REGISTERED' ? 'National ID and ZIMRA BP number' : 'National ID', ok: !!s.nationalId && (s.kycTier !== 'REGISTERED' || !!s.taxNumber) },
      { key: 'PHONE', label: 'Verified phone number', ok: s.user.phoneVerified },
      { key: 'PAYOUT', label: 'A payout account (USD bank or ZiG/EcoCash)', ok: !!(usd && Object.keys(usd).length) || !!(zig && Object.keys(zig).length) },
      { key: 'BRANCH', label: 'At least one branch', ok: branches.length > 0 },
      { key: 'PINS', label: 'Every active branch pin checked on the map', ok: branches.length > 0 && branches.filter((b) => b.isActive).every((b) => !!b.locationVerifiedAt) },
    ];
    return {
      id: s.id, businessName: s.businessName, slug: s.slug, kycTier: s.kycTier, kycStatus: s.kycStatus, rejectionNote: s.rejectionNote,
      owner: { name: s.user.profile?.fullName ?? null, email: s.user.email, phone: s.user.phone, phoneVerified: s.user.phoneVerified },
      nationalId: s.nationalId, taxNumber: s.taxNumber, city: s.city?.name ?? null,
      payout: { usd, zig },
      payoutHold: s.payoutHoldAt ? { at: s.payoutHoldAt, reason: s.payoutHoldReason } : null,
      slaScore: s.slaScore.toNumber(), disputeRate: s.disputeRate.toNumber(),
      branches,
      checklist,
      readyToApprove: checklist.every((c) => c.ok),
      createdAt: s.createdAt,
    };
  },

  async verifyBranchLocation(branchId: string, verified: boolean) {
    const b = await prisma.storeBranch.findUnique({ where: { id: branchId }, select: { sellerId: true } });
    if (!b) throw new NotFoundError('Branch');
    await prisma.storeBranch.update({ where: { id: branchId }, data: { locationVerifiedAt: verified ? new Date() : null } });
    return this.packet(b.sellerId);
  },
};
