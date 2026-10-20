/**
 * Typed application errors mapped to the documented API error envelope
 * (Part A / A7). Stack traces are never returned to clients.
 */

import type { ApiErrorCode, ApiFieldIssue } from '@shipcheck/shared';

export class AppError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly fields?: Record<string, string[]>;
  readonly issues?: ApiFieldIssue[];
  readonly meta: Record<string, unknown>;
  readonly expose: boolean;

  constructor(
    status: number,
    code: ApiErrorCode,
    message: string,
    options: {
      fields?: Record<string, string[]>;
      issues?: ApiFieldIssue[];
      meta?: Record<string, unknown>;
      expose?: boolean;
    } = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.fields = options.fields;
    this.issues = options.issues;
    this.meta = options.meta ?? {};
    this.expose = options.expose ?? true;
  }
}

export const badRequest = (message: string, fields?: Record<string, string[]>) =>
  new AppError(400, 'VALIDATION_ERROR', message, { fields });

export const validationError = (
  message: string,
  issues: ApiFieldIssue[],
  fields?: Record<string, string[]>,
) => new AppError(400, 'VALIDATION_ERROR', message, { issues, fields });

export const unauthenticated = (message = 'Sign in to continue.') =>
  new AppError(401, 'UNAUTHENTICATED', message);

export const forbidden = (message = 'You do not have permission to perform this action.') =>
  new AppError(403, 'FORBIDDEN', message);

export const notFound = (entity = 'Resource') =>
  new AppError(404, 'NOT_FOUND', `${entity} was not found.`);

/**
 * Used both for genuine conflicts (duplicate invoice number, replayed
 * idempotency key) and for records that exist but belong to another tenant.
 */
export const conflict = (message: string, meta?: Record<string, unknown>) =>
  new AppError(409, 'CONFLICT', message, { meta });

export const unprocessable = (message: string, fields?: Record<string, string[]>) =>
  new AppError(422, 'UNPROCESSABLE', message, { fields });

export const rateLimited = (message = 'Too many requests. Please slow down.') =>
  new AppError(429, 'RATE_LIMITED', message);

export const integrationUnavailable = (message: string, meta?: Record<string, unknown>) =>
  new AppError(503, 'INTEGRATION_UNAVAILABLE', message, { meta });

export const internalError = (message = 'Something went wrong. Please try again.') =>
  new AppError(500, 'INTERNAL_ERROR', message, { expose: false });