import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { env } from '../config/env';
import { errorResponse } from '../lib/response';
import prisma from '../lib/prisma';

export interface JwtPayload {
  sub: string;       // user id
  role: string;
  email: string;
  iat?: number;
  exp?: number;
}

// Extend Express Request
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

export function authenticate(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    errorResponse(res, 'Authentication required', 401);
    return;
  }

  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as JwtPayload;
    req.user = payload;
    next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      errorResponse(res, 'Token expired', 401);
    } else {
      errorResponse(res, 'Invalid token', 401);
    }
  }
}

export function optionalAuthenticate(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      req.user = jwt.verify(token, env.JWT_ACCESS_SECRET) as JwtPayload;
    } catch {
      // silently ignore — optional auth
    }
  }
  next();
}

export function generateAccessToken(payload: Omit<JwtPayload, 'iat' | 'exp'>): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_EXPIRES_IN,
  } as jwt.SignOptions);
}

export function generateRefreshToken(payload: Omit<JwtPayload, 'iat' | 'exp'>): string {
  // jwtid makes every refresh token unique, even two issued in the same second
  return jwt.sign(payload, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_EXPIRES_IN,
    jwtid: randomUUID(),
  } as jwt.SignOptions);
}

export function verifyRefreshToken(token: string): JwtPayload {
  return jwt.verify(token, env.JWT_REFRESH_SECRET) as JwtPayload;
}

/**
 * Middleware that checks the user is not suspended.
 * Must be used after `authenticate`.
 */
export async function requireActiveUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.user) {
    errorResponse(res, 'Authentication required', 401);
    return;
  }
  const user = await prisma.user.findUnique({
    where: { id: req.user.sub },
    select: { status: true },
  });
  if (!user || user.status === 'SUSPENDED') {
    errorResponse(res, 'Account suspended or not found', 403);
    return;
  }
  next();
}
