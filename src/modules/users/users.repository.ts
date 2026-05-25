import prisma from '../../lib/prisma';
import { UpdateProfileDto } from './users.schema';

export class UsersRepository {
  async findById(id: string) {
    return prisma.user.findUnique({
      where: { id },
      include: { profile: true },
    });
  }

  async findByIdSafe(id: string) {
    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        phone: true,
        role: true,
        status: true,
        emailVerified: true,
        createdAt: true,
        updatedAt: true,
        profile: true,
      },
    });
    return user;
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const { fullName, phone, avatarUrl, address, city, country, lat, lng } = dto;

    return prisma.$transaction(async (tx) => {
      if (phone) {
        await tx.user.update({ where: { id: userId }, data: { phone } });
      }
      return tx.userProfile.upsert({
        where: { userId },
        update: { fullName, avatarUrl, address, city, country, lat, lng },
        create: { userId, fullName: fullName ?? 'User', avatarUrl, address, city, country: country ?? 'ZW', lat, lng },
      });
    });
  }

  async findMany(opts: {
    skip: number;
    take: number;
    role?: string;
    status?: string;
    search?: string;
  }) {
    const where: Record<string, unknown> = {};
    if (opts.role) where.role = opts.role;
    if (opts.status) where.status = opts.status;
    if (opts.search) {
      where.OR = [
        { email: { contains: opts.search, mode: 'insensitive' } },
        { profile: { fullName: { contains: opts.search, mode: 'insensitive' } } },
      ];
    }

    const [data, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip: opts.skip,
        take: opts.take,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, email: true, phone: true, role: true, status: true,
          emailVerified: true, createdAt: true, profile: { select: { fullName: true, avatarUrl: true } },
        },
      }),
      prisma.user.count({ where }),
    ]);

    return { data, total };
  }

  async updateStatus(id: string, status: 'ACTIVE' | 'SUSPENDED') {
    return prisma.user.update({ where: { id }, data: { status } });
  }
}

export const usersRepository = new UsersRepository();
