import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type { Permission, Role } from '@shipcheck/shared';

import type { AppConfig } from '../config.js';
import type { Services } from '../container.js';
import type { AuthenticatedPrincipal } from '../services/auth.service.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Correlation id echoed in logs, errors and the audit trail. */
      requestId: string;
      clientIp: string | null;
      userAgent: string | null;
      principal?: AuthenticatedPrincipal;
      /** Set by `requireOrganization` on every tenant-scoped request. */
      organization?: {
        id: string;
        name: string;
        slug: string;
        baseCurrency: string;
        timezone: string;
        countryCode: string;
        logoUrl: string | null;
      };
      organizationRole?: Role;
      permissions?: Permission[];
    }
  }
}

/** Never let a full stack trace reach the client (Part A / A7). */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

export function requestContext(config: AppConfig): RequestHandler {
  return (req, _res, next) => {
    req.requestId =
      (req.header('x-request-id')?.slice(0, 80) || randomRequestId());
    req.clientIp = clientIpOf(req);
    req.userAgent = req.header('user-agent')?.slice(0, 300) ?? null;
    void config;
    next();
  };
}

function clientIpOf(req: Request): string | null {
  const forwarded = req.header('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]?.trim() ?? null;
  return req.ip ?? null;
}

function randomRequestId(): string {
  return `req_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

/** Canonical RFC 4122 textual UUID form accepted by every identifier column. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Reads the session from the HTTP-only cookie or a Bearer token. */
export function requireAuth(services: Services): RequestHandler {
  return asyncHandler(async (req, _res, next) => {
    const token = sessionTokenOf(req, services.config.session.cookieName);
    const principal = await services.auth.authenticate(token);
    if (!principal) {
      req.principal = undefined;
      next();
      return;
    }
    req.principal = principal;
    next();
  });
}

/** Rejects anonymous requests with 401. */
export function requireAuthenticated(): RequestHandler {
  return (req, res, next) => {
    if (!req.principal) {
      res.status(401).json({
        error: {
          code: 'UNAUTHENTICATED',
          message: 'Sign in to continue.',
          requestId: req.requestId,
        },
      });
      return;
    }
    next();
  };
}

export function sessionTokenOf(req: Request, cookieName: string): string | undefined {
  const header = req.header('authorization');
  if (header?.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }
  const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
  return cookies?.[cookieName];
}

/**
 * Resolves the organization from `:organizationId` and verifies membership.
 * A record belonging to another tenant is reported as 404, never 403, so the
 * API cannot be used to probe for the existence of foreign identifiers.
 */
export function requireOrganization(services: Services): RequestHandler {
  return asyncHandler(async (req, res, next) => {
    const userId = req.principal?.user.id;
    if (!userId) {
      next();
      return;
    }
    const organizationId = req.params.organizationId;
    if (!organizationId) {
      next();
      return;
    }
    // Reject a malformed id before it reaches PostgreSQL. Without this the uuid
    // cast fails inside the driver and the caller sees an opaque 500 instead
    // of the same 400 every other invalid identifier produces.
    if (!UUID_PATTERN.test(organizationId)) {
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'organizationId must be a UUID.',
          requestId: req.requestId,
        },
      });
      return;
    }
    const organization = await services.organizations.get(organizationId);
    const membership = await services.organizations.requireMembership(organizationId, userId);

    req.organization = {
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      baseCurrency: organization.baseCurrency,
      timezone: organization.timezone,
      countryCode: organization.countryCode,
      logoUrl: organization.logoUrl,
    };
    req.organizationRole = membership.role;
    req.permissions = services.permissionsFor(membership.role);
    next();
  });
}

export function requirePermission(permission: Permission): RequestHandler {
  return (req, res, next) => {
    if (!req.principal) {
      res.status(401).json({
        error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.', requestId: req.requestId },
      });
      return;
    }
    if (!req.permissions?.includes(permission)) {
      res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: `Your role does not allow this action (${permission}).`,
          requestId: req.requestId,
        },
      });
      return;
    }
    next();
  };
}