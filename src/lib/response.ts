import { Response } from 'express';

export interface ApiResponse<T = unknown> {
  success: boolean;
  message: string;
  data?: T;
  meta?: PaginationMeta;
  errors?: unknown;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export function successResponse<T>(
  res: Response,
  data: T,
  message = 'Success',
  statusCode = 200,
  meta?: PaginationMeta,
): Response {
  const body: ApiResponse<T> = { success: true, message, data };
  if (meta) body.meta = meta;
  return res.status(statusCode).json(body);
}

export function createdResponse<T>(res: Response, data: T, message = 'Created'): Response {
  return successResponse(res, data, message, 201);
}

export function errorResponse(
  res: Response,
  message: string,
  statusCode = 500,
  errors?: unknown,
): Response {
  const body: ApiResponse = { success: false, message };
  if (errors) body.errors = errors;
  return res.status(statusCode).json(body);
}

export function buildPaginationMeta(
  total: number,
  page: number,
  limit: number,
): PaginationMeta {
  const totalPages = Math.ceil(total / limit);
  return {
    page,
    limit,
    total,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
  };
}

export function parsePagination(
  query: Record<string, unknown>,
  maxLimit = 100,
): { page: number; limit: number; skip: number } {
  const page = Math.max(1, parseInt(String(query.page ?? 1), 10));
  const limit = Math.min(maxLimit, Math.max(1, parseInt(String(query.limit ?? 20), 10)));
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}
