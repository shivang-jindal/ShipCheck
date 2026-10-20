/**
 * Request validation. The same Zod schemas are used by the browser for inline
 * validation and re-run here, so nothing from the client is trusted
 * (Part A / A4.7).
 */

import type { RequestHandler } from 'express';
import type { ZodTypeAny, z } from 'zod';

import { validationError } from '../errors.js';

export interface ValidationSchemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

export function validate(schemas: ValidationSchemas): RequestHandler {
  return (req, _res, next) => {
    for (const part of ['body', 'query', 'params'] as const) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.safeParse(req[part]);
      if (!result.success) {
        const fields: Record<string, string[]> = {};
        for (const issue of result.error.issues) {
          const path = issue.path.length > 0 ? issue.path.join('.') : part;
          (fields[path] ??= []).push(issue.message);
        }
        next(
          validationError(
            'Some of the values you entered are not valid.',
            result.error.issues.map((issue) => ({
              path: issue.path.length > 0 ? issue.path.join('.') : part,
              message: issue.message,
            })),
            fields,
          ),
        );
        return;
      }
      // Express 5 exposes `req.query` as a getter; assign through a cast.
      (req as unknown as Record<string, unknown>)[part] = result.data;
    }
    next();
  };
}

export function parseBody<T extends ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  return schema.parse(value);
}