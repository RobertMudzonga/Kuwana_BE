import { Request, Response, NextFunction } from 'express';
import { UserRole } from '@prisma/client';
import { errorResponse } from '../lib/response';

/**
 * Role-based access control middleware.
 * Usage: requireRoles('ADMIN') or requireRoles('ADMIN', 'PROVIDER')
 */
export function requireRoles(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      errorResponse(res, 'Authentication required', 401);
      return;
    }
    if (!roles.includes(req.user.role as UserRole)) {
      errorResponse(res, 'Insufficient permissions', 403);
      return;
    }
    next();
  };
}

/** Shorthand guards */
export const requireAdmin = requireRoles(UserRole.ADMIN);
export const requireProvider = requireRoles(UserRole.PROVIDER, UserRole.ADMIN);
export const requireUser = requireRoles(UserRole.USER, UserRole.PROVIDER, UserRole.ADMIN);
