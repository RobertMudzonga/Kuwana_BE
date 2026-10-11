import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import prisma from '../../lib/prisma';
import { env } from '../../config/env';
import {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
} from '../../middleware/auth.middleware';
import { ConflictError, AppError, NotFoundError, BadRequestError } from '../../middleware/error.middleware';
import { RegisterDto, LoginDto } from './auth.schema';
import { UserRole } from '@prisma/client';
import { toPublicUser } from '../../lib/serializers';
import { sendSms } from '../../lib/sms';
import { sendEmail } from '../../lib/mailer';

const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PHONE_CODE_TTL_MS = 10 * 60 * 1000;
const PHONE_CODE_COOLDOWN_MS = 60 * 1000;
const PHONE_CODES_PER_HOUR = 5;
const PHONE_CODE_MAX_ATTEMPTS = 5;
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
/** Codes are bound to the user and phone, so a code for one number can't verify another */
const hashPhoneCode = (userId: string, phone: string, code: string) =>
  crypto.createHmac('sha256', env.JWT_ACCESS_SECRET).update(`${userId}:${phone}:${code}`).digest('hex');

export class AuthService {
  async createUser(dto: RegisterDto) {
    const existing = await prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) throw new ConflictError('An account with this email already exists');

    const passwordHash = await bcrypt.hash(dto.password, env.BCRYPT_SALT_ROUNDS);

    const user = await prisma.user.create({
      data: {
        email: dto.email,
        phone: dto.phone,
        passwordHash,
        role: (dto.role ?? 'USER') as UserRole,
        profile: { create: { fullName: dto.fullName } },
      },
      include: { profile: true },
    });

    return toPublicUser(user);
  }

  private async issueTokens(user: { id: string; role: string; email: string }) {
    const tokenPayload = { sub: user.id, role: user.role, email: user.email };
    const accessToken = generateAccessToken(tokenPayload);
    const refreshToken = generateRefreshToken(tokenPayload);
    await prisma.refreshToken.create({
      data: { id: uuidv4(), userId: user.id, token: refreshToken, expiresAt: new Date(Date.now() + REFRESH_TTL_MS) },
    });
    return { accessToken, refreshToken };
  }

  /** Public sign-up always creates a buyer. Sellers onboard via /providers/onboard; drivers are created by admins. */
  async register(dto: RegisterDto) {
    const user = await this.createUser({ ...dto, role: 'USER' });
    return { ...(await this.issueTokens(user)), user };
  }

  async login(dto: LoginDto) {
    const user = await prisma.user.findUnique({
      where: { email: dto.email },
      include: { profile: true },
    });

    if (!user) throw new AppError('Invalid email or password', 401);
    if (user.status === 'SUSPENDED') throw new AppError('Account has been suspended', 403);

    const valid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!valid) throw new AppError('Invalid email or password', 401);

    return { ...(await this.issueTokens(user)), user: toPublicUser(user) };
  }

  async refresh(rawToken: string) {
    let payload: ReturnType<typeof verifyRefreshToken>;
    try {
      payload = verifyRefreshToken(rawToken);
    } catch {
      throw new AppError('Invalid or expired refresh token', 401);
    }

    const stored = await prisma.refreshToken.findUnique({ where: { token: rawToken } });
    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      throw new AppError('Refresh token revoked or expired', 401);
    }

    const user = await prisma.user.findUnique({ where: { id: payload.sub }, include: { profile: true } });
    if (!user) throw new NotFoundError('User');
    if (user.status === 'SUSPENDED') throw new AppError('Account has been suspended', 403);

    // Rotate: revoke old, issue new
    await prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
    return { ...(await this.issueTokens(user)), user: toPublicUser(user) };
  }

  async logout(rawToken: string) {
    await prisma.refreshToken.updateMany({
      where: { token: rawToken, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async me(userId: string) {
    const user = await prisma.user.findUnique({ where: { id: userId }, include: { profile: true } });
    if (!user) throw new NotFoundError('User');
    return toPublicUser(user);
  }

  // ── Passwords ───────────────────────────────────────────

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundError('User');
    if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
      throw new BadRequestError('Your current password is incorrect');
    }
    await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: { passwordHash: await bcrypt.hash(newPassword, env.BCRYPT_SALT_ROUNDS) },
      }),
      // Sign out other sessions
      prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
  }

  /** Always succeeds from the caller's point of view, so it can't be used to discover accounts */
  async forgotPassword(email: string) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || user.status === 'SUSPENDED') return;

    const token = crypto.randomBytes(32).toString('hex');
    await prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS) },
    });
    const link = `${env.APP_URL.replace(/\/$/, '')}/reset-password?token=${token}`;
    await sendEmail(
      user.email,
      'Reset your Kuwana password',
      `Someone asked to reset the password for your Kuwana account.\n\nOpen this link within 1 hour to choose a new password:\n${link}\n\nIf this wasn't you, you can ignore this email.`,
    );
  }

  async resetPassword(token: string, password: string) {
    const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash: sha256(token) } });
    if (!record || record.usedAt || record.expiresAt < new Date()) {
      throw new BadRequestError('This reset link is invalid or has expired. Please request a new one.');
    }
    await prisma.$transaction([
      prisma.user.update({
        where: { id: record.userId },
        data: { passwordHash: await bcrypt.hash(password, env.BCRYPT_SALT_ROUNDS) },
      }),
      prisma.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
      prisma.refreshToken.updateMany({ where: { userId: record.userId, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
  }

  // ── Phone verification ──────────────────────────────────

  async sendPhoneCode(userId: string, phone: string) {
    const takenBy = await prisma.user.findFirst({ where: { phone, phoneVerified: true, NOT: { id: userId } } });
    if (takenBy) throw new ConflictError('This number is already verified on another account');

    const recent = await prisma.phoneVerification.findMany({
      where: { userId, createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) } },
      orderBy: { createdAt: 'desc' },
    });
    if (recent[0] && Date.now() - recent[0].createdAt.getTime() < PHONE_CODE_COOLDOWN_MS) {
      throw new AppError('Please wait a minute before requesting another code', 429);
    }
    if (recent.length >= PHONE_CODES_PER_HOUR) {
      throw new AppError('Too many codes requested. Try again in an hour.', 429);
    }

    const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
    await prisma.phoneVerification.create({
      data: {
        userId,
        phone,
        codeHash: hashPhoneCode(userId, phone, code),
        expiresAt: new Date(Date.now() + PHONE_CODE_TTL_MS),
      },
    });
    await sendSms(phone, `Your Kuwana verification code is ${code}. It expires in 10 minutes.`);
  }

  async verifyPhone(userId: string, phone: string, code: string) {
    const record = await prisma.phoneVerification.findFirst({
      where: { userId, phone, usedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!record || record.expiresAt < new Date()) {
      throw new BadRequestError('This code has expired. Request a new one.');
    }
    if (record.attempts >= PHONE_CODE_MAX_ATTEMPTS) {
      throw new BadRequestError('Too many wrong attempts. Request a new code.');
    }

    const expected = Buffer.from(record.codeHash, 'hex');
    const actual = Buffer.from(hashPhoneCode(userId, phone, code), 'hex');
    if (!crypto.timingSafeEqual(expected, actual)) {
      await prisma.phoneVerification.update({ where: { id: record.id }, data: { attempts: { increment: 1 } } });
      throw new BadRequestError('That code is incorrect');
    }

    // Another account may hold this number unverified; release it so the unique constraint doesn't block
    await prisma.$transaction([
      prisma.user.updateMany({ where: { phone, phoneVerified: false, NOT: { id: userId } }, data: { phone: null } }),
      prisma.phoneVerification.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
      prisma.user.update({ where: { id: userId }, data: { phone, phoneVerified: true } }),
    ]);
    return this.me(userId);
  }
}

export const authService = new AuthService();
