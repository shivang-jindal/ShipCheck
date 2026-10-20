/**
 * API router assembly (Part A / A7): everything lives under `/api/v1`.
 */

import { Router, type ErrorRequestHandler, type RequestHandler } from 'express';

import { deliveryReportQuerySchema, idParamSchema } from '@shipcheck/shared';
import { z } from 'zod';

import type { Services } from '../../container.js';
import { AppError } from '../../errors.js';
import {
  asyncHandler,
  requireAuth,
  requireAuthenticated,
  requireOrganization,
  requirePermission,
} from '../middleware.js';
import { validate } from '../validate.js';
import { authRouter } from './auth.js';
import { healthRouter } from './health.js';
import {
  exceptionRouter,
  exportRouter,
  importRouter,
  integrationRouter,
  settingsRouter,
  shipmentRouter,
} from './domain.js';
import { organizationRouter } from './organization.js';
import { publicRouter } from './public.js';

export function createApiRouter(services: Services): Router {
  const router = Router();

  router.use('/health', healthRouter(services));

  // Public routes are mounted before authentication on purpose.
  router.use('/public', publicRouter(services));

  // `requireAuth` only ATTACHES the principal; it never rejects. It must be
  // mounted before `/auth`, because a sub-router that handles a request never
  // falls through to middleware registered after it - so several `/auth`
  // routes (session, create organization, switch organization, accept
  // invitation) would otherwise run without a principal and always 401.
  router.use(requireAuth(services));
  router.use('/auth', authRouter(services));

  // Everything past this point requires a session. Sign-in and registration
  // are handled by `authRouter` above and stay reachable anonymously.
  router.use(requireAuthenticated());

  router.get(
    '/session/context',
    asyncHandler(async (req, res) => {
      res.json({
        user: req.principal!.user,
        memberships: await services.auth.membershipsFor(req.principal!.user.id),
        activeOrganizationId: req.principal!.activeOrganizationId,
      });
    }),
  );

  // mergeParams is required so `:organizationId` is visible to
  // `requireOrganization` and to route-level validation inside the sub-routers.
  const organizationScoped = Router({ mergeParams: true });
  organizationScoped.use(requireOrganization(services));

  organizationScoped.use('/shipments', shipmentRouter(services));
  organizationScoped.use('/exceptions', exceptionRouter(services));
  organizationScoped.use('/imports', importRouter(services));
  organizationScoped.use('/integrations', integrationRouter(services));
  organizationScoped.use('/settings', settingsRouter(services));
  organizationScoped.use('/exports', exportRouter(services));
  organizationScoped.use('/', organizationRouter(services));

  organizationScoped.get(
    '/dashboard',
    validate({ query: z.object({ from: z.string().max(10).optional(), to: z.string().max(10).optional() }) }),
    asyncHandler(async (req, res) => {
      const query = req.query as { from?: string; to?: string };
      res.json(
        await services.reports.dashboard(req.organization!.id, {
          ...(query.from ? { from: query.from } : {}),
          ...(query.to ? { to: query.to } : {}),
        }),
      );
    }),
  );

  organizationScoped.get(
    '/reports/delivery',
    requirePermission('report.view'),
    validate({ query: deliveryReportQuerySchema }),
    asyncHandler(async (req, res) => {
      res.json(await services.reports.deliveryReport(req.organization!.id, req.query as never));
    }),
  );

  router.use('/:organizationId', organizationScoped);

  return router;
}

export function notFoundHandler(): RequestHandler {
  return (req, res) => {
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: `No route matches ${req.method} ${req.path}.`,
        requestId: req.requestId,
      },
    });
  };
}

/** One error shape for the whole API; stack traces stay in the log only. */
export function errorHandler(services: Services): ErrorRequestHandler {
  return (error, req, res, _next) => {
    if (res.headersSent) return;

    if (error instanceof AppError) {
      if (error.status >= 500) {
        services.logger.error({ err: error, requestId: req.requestId }, 'request failed');
      } else {
        services.logger.debug(
          { code: error.code, requestId: req.requestId, path: req.path },
          'request rejected',
        );
      }
      res.status(error.status).json({
        error: {
          code: error.code,
          message: error.expose ? error.message : 'Something went wrong. Please try again.',
          ...(error.fields ? { fields: error.fields } : {}),
          ...(error.issues ? { issues: error.issues } : {}),
          requestId: req.requestId,
        },
      });
      return;
    }

    if (error && typeof error === 'object' && 'issues' in error) {
      const issues = (error as { issues: Array<{ path: unknown[]; message: string }> }).issues;
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Some of the values you entered are not valid.',
          issues: issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
          requestId: req.requestId,
        },
      });
      return;
    }

    if (error instanceof SyntaxError && 'body' in error) {
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request body is not valid JSON.',
          requestId: req.requestId,
        },
      });
      return;
    }

    services.logger.error({ err: error, requestId: req.requestId }, 'unhandled error');
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Something went wrong. Please try again.',
        requestId: req.requestId,
      },
    });
  };
}

export { idParamSchema };