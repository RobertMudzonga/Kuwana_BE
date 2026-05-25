import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { logger } from '../lib/logger';
import { errorResponse } from '../lib/response';

export class AppError extends Error {
  constructor(
    public message: string,
    public statusCode: number = 500,
    public isOperational: boolean = true,
  ) {
    super(message);
    this.name = 'AppError';
    Error.captureStackTrace(this, this.constructor);
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(`${resource} not found`, 404);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflict') {
    super(message, 409);
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Bad request') {
    super(message, 400);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(message, 403);
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function globalErrorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  // Zod validation errors
  if (err instanceof ZodError) {
    errorResponse(res, 'Validation failed', 422, err.flatten().fieldErrors);
    return;
  }

  // Our custom operational errors
  if (err instanceof AppError) {
    if (!err.isOperational) {
      logger.error('Non-operational error', { err });
    }
    errorResponse(res, err.message, err.statusCode);
    return;
  }

  // Prisma errors
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      // Unique constraint violation
      const fields = (err.meta?.target as string[])?.join(', ') ?? 'field';
      errorResponse(res, `A record with this ${fields} already exists`, 409);
      return;
    }
    if (err.code === 'P2025') {
      errorResponse(res, 'Record not found', 404);
      return;
    }
    logger.error('Prisma error', { code: err.code, meta: err.meta });
    errorResponse(res, 'Database error', 500);
    return;
  }

  // Unknown errors — do not leak stack traces
  logger.error('Unhandled error', { err: err.message, stack: err.stack });
  errorResponse(res, 'Internal server error', 500);
}
