import { Request, Response, NextFunction } from 'express';
import { AuditAction } from '@prisma/client';
import prisma from '../lib/prisma';
import { logger } from '../lib/logger';

interface AuditOptions {
  action: AuditAction;
  targetType?: string;
  /** If provided, reads target ID from this param name (e.g. 'id') */
  targetIdParam?: string;
  /** Static target ID override */
  targetId?: string;
}

/**
 * Middleware factory that writes an audit log after the response is sent.
 * Safe — logging failures never break the request.
 */
export function auditLog(options: AuditOptions) {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.on('finish', () => {
      // Only log on successful state-changing responses
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const targetId =
          options.targetId ??
          (options.targetIdParam ? req.params[options.targetIdParam] : undefined);

        prisma.auditLog
          .create({
            data: {
              actorId: req.user?.sub ?? null,
              action: options.action,
              targetType: options.targetType ?? null,
              targetId: targetId ?? null,
              metadata: { method: req.method, path: req.path },
              ipAddress: (req.headers['x-forwarded-for'] as string) ?? req.ip ?? null,
              userAgent: req.headers['user-agent'] ?? null,
            },
          })
          .catch((err: unknown) => {
            logger.warn('Failed to write audit log', { err, action: options.action });
          });
      }
    });
    next();
  };
}
