import { Router } from 'express';
import { z } from 'zod';

import type { ExceptionSeverity, ExceptionType } from '@shipcheck/shared';
import {
  archiveShipmentSchema,
  carrierIntegrationSchema,
  createExceptionSchema,
  createShipmentSchema,
  exceptionCommentSchema,
  exceptionListQuerySchema,
  exportShipmentsSchema,
  idParamSchema,
  importCommitSchema,
  importPreviewSchema,
  manualEventSchema,
  resolveExceptionSchema,
  shipmentListQuerySchema,
  updateOrganizationSettingsSchema,
  updateNotificationRulesSchema,
  updateShipmentSchema,
} from '@shipcheck/shared';

import type { Services } from '../../container.js';
import { asyncHandler, requirePermission } from '../middleware.js';
import { validate } from '../validate.js';

const shipmentParams = z.object({
  organizationId: idParamSchema.shape.id,
  shipmentId: idParamSchema.shape.id,
});

const exceptionParams = z.object({
  organizationId: idParamSchema.shape.id,
  exceptionId: idParamSchema.shape.id,
});

const importParams = z.object({
  organizationId: idParamSchema.shape.id,
  importId: idParamSchema.shape.id,
});

export function shipmentRouter(services: Services): Router {
  // mergeParams keeps `:organizationId` visible to route-level validation.
  const router = Router({ mergeParams: true });

  router.get(
    '/',
    validate({ query: shipmentListQuerySchema }),
    asyncHandler(async (req, res) => {
      res.json(await services.shipments.list(req.organization!.id, req.query as never));
    }),
  );

  router.post(
    '/',
    requirePermission('shipment.create'),
    validate({ body: createShipmentSchema }),
    asyncHandler(async (req, res) => {
      const { shipment, publicToken } = await services.shipments.create(
        req.organization!.id,
        req.principal!.user.id,
        req.body as never,
        { requestId: req.requestId },
      );
      res.status(201).json({
        shipment,
        publicUrl: `${services.config.appUrl}/track/${publicToken}`,
        note: 'The shipment was created with a "created" event. No carrier data has been received.',
      });
    }),
  );

  router.get(
    '/:shipmentId',
    validate({ params: shipmentParams }),
    asyncHandler(async (req, res) => {
      res.json(
        await services.shipments.detail(req.organization!.id, req.params.shipmentId as string),
      );
    }),
  );

  router.patch(
    '/:shipmentId',
    requirePermission('shipment.edit'),
    validate({ params: shipmentParams, body: updateShipmentSchema }),
    asyncHandler(async (req, res) => {
      const shipment = await services.shipments.update(
        req.organization!.id,
        req.principal!.user.id,
        req.params.shipmentId as string,
        req.body as never,
        { requestId: req.requestId },
      );
      res.json({ shipment });
    }),
  );

  router.post(
    '/:shipmentId/archive',
    requirePermission('shipment.archive'),
    validate({ params: shipmentParams, body: archiveShipmentSchema }),
    asyncHandler(async (req, res) => {
      const shipment = await services.shipments.setArchived(
        req.organization!.id,
        req.principal!.user.id,
        req.params.shipmentId as string,
        (req.body as { archived: boolean }).archived,
        { requestId: req.requestId },
      );
      res.json({ shipment });
    }),
  );

  router.get(
    '/:shipmentId/events',
    validate({ params: shipmentParams }),
    asyncHandler(async (req, res) => {
      const detail = await services.shipments.detail(
        req.organization!.id,
        req.params.shipmentId as string,
      );
      res.json({ events: detail.events });
    }),
  );

  router.post(
    '/:shipmentId/events/manual',
    requirePermission('shipment.event.manual'),
    validate({ params: shipmentParams, body: manualEventSchema }),
    asyncHandler(async (req, res) => {
      const result = await services.shipments.addManualEvent(
        req.organization!.id,
        req.principal!.user.id,
        req.params.shipmentId as string,
        req.body as never,
      );
      const detail = await services.shipments.detail(
        req.organization!.id,
        req.params.shipmentId as string,
      );

      // A delivery event closes open delivery exceptions and closes the loop.
      if (detail.shipment.status === 'delivered') {
        await services.jobs.enqueue({
          jobType: 'exceptions.auto_close',
          organizationId: req.organization!.id,
          payload: { organizationId: req.organization!.id, shipmentId: req.params.shipmentId },
          idempotencyKey: `auto-close:${req.params.shipmentId}:${result.eventId}`,
        });
      }

      res.status(201).json({
        ...result,
        status: detail.shipment.status,
        note: 'This event was recorded manually. It is not carrier-confirmed data.',
      });
    }),
  );

  router.post(
    '/:shipmentId/refresh',
    requirePermission('shipment.edit'),
    validate({ params: shipmentParams }),
    asyncHandler(async (req, res) => {
      const shipmentId = req.params.shipmentId as string;
      await services.shipments.get(req.organization!.id, shipmentId);

      const integrations = await services.integrations.list(req.organization!.id);
      const shipment = await services.shipments.get(req.organization!.id, shipmentId);

      res.status(503).json({
        error: {
          code: 'INTEGRATION_UNAVAILABLE',
          message:
            integrations.length === 0 || shipment.carrierCode === 'manual'
              ? 'This shipment has no configured carrier adapter, so ShipCheck cannot refresh it. Add tracking events manually or import them from CSV.'
              : `ShipCheck does not implement a live adapter for ${shipment.carrierCode}. No carrier data was fetched and no status was changed.`,
          requestId: req.requestId,
        },
      });
    }),
  );

  router.post(
    '/:shipmentId/public-link/rotate',
    requirePermission('shipment.edit'),
    validate({ params: shipmentParams }),
    asyncHandler(async (req, res) => {
      const token = await services.shipments.rotatePublicToken(
        req.organization!.id,
        req.principal!.user.id,
        req.params.shipmentId as string,
      );
      res.json({ publicUrl: `${services.config.appUrl}/track/${token}` });
    }),
  );

  router.post(
    '/:shipmentId/public-link/revoke',
    requirePermission('shipment.edit'),
    validate({ params: shipmentParams }),
    asyncHandler(async (req, res) => {
      await services.shipments.revokePublicToken(
        req.organization!.id,
        req.principal!.user.id,
        req.params.shipmentId as string,
      );
      res.status(204).end();
    }),
  );

  return router;
}

export function exceptionRouter(services: Services): Router {
  const router = Router({ mergeParams: true });

  router.get(
    '/',
    validate({ query: exceptionListQuerySchema }),
    asyncHandler(async (req, res) => {
      const query = req.query as unknown as {
        page: number;
        pageSize: number;
        status: string;
        type: string;
        severity: string;
        shipmentId?: string;
        assignedToMe?: string;
      };
      res.json(await services.exceptions.list(req.organization!.id, query));
    }),
  );

  router.post(
    '/',
    requirePermission('exception.resolve'),
    validate({ body: createExceptionSchema }),
    asyncHandler(async (req, res) => {
      const body = req.body as {
        shipmentId: string;
        type: ExceptionType;
        severity: ExceptionSeverity;
        detail?: string | null;
      };
      const result = await services.exceptions.open(req.organization!.id, {
        ...body,
        createdBy: req.principal!.user.id,
      });
      res.status(result.created ? 201 : 200).json(result);
    }),
  );

  router.get(
    '/:exceptionId',
    validate({ params: exceptionParams }),
    asyncHandler(async (req, res) => {
      res.json(await services.exceptions.detail(req.organization!.id, req.params.exceptionId as string));
    }),
  );

  router.post(
    '/:exceptionId/assign',
    requirePermission('exception.resolve'),
    validate({ params: exceptionParams, body: z.object({ assignedUserId: z.string().uuid().nullable() }) }),
    asyncHandler(async (req, res) => {
      const exception = await services.exceptions.assign(
        req.organization!.id,
        req.principal!.user.id,
        req.params.exceptionId as string,
        (req.body as { assignedUserId: string | null }).assignedUserId,
      );
      res.json({ exception });
    }),
  );

  router.post(
    '/:exceptionId/acknowledge',
    requirePermission('exception.resolve'),
    validate({ params: exceptionParams }),
    asyncHandler(async (req, res) => {
      const exception = await services.exceptions.acknowledge(
        req.organization!.id,
        req.principal!.user.id,
        req.params.exceptionId as string,
      );
      res.json({ exception });
    }),
  );

  router.post(
    '/:exceptionId/comments',
    requirePermission('exception.comment'),
    validate({ params: exceptionParams, body: exceptionCommentSchema }),
    asyncHandler(async (req, res) => {
      const comment = await services.exceptions.comment(
        req.organization!.id,
        req.principal!.user.id,
        req.params.exceptionId as string,
        req.body as never,
      );
      res.status(201).json({ comment });
    }),
  );

  router.post(
    '/:exceptionId/resolve',
    requirePermission('exception.resolve'),
    validate({ params: exceptionParams, body: resolveExceptionSchema }),
    asyncHandler(async (req, res) => {
      const exception = await services.exceptions.resolve(
        req.organization!.id,
        req.principal!.user.id,
        req.params.exceptionId as string,
        req.body as never,
      );
      res.json({ exception });
    }),
  );

  return router;
}

export function importRouter(services: Services): Router {
  const router = Router({ mergeParams: true });

  router.post(
    '/shipments/preview',
    requirePermission('import.run'),
    validate({ body: importPreviewSchema }),
    asyncHandler(async (req, res) => {
      const body = req.body as { filename: string; content: string; mapping: Record<string, string> };
      res.json(
        await services.imports.preview({
          organizationId: req.organization!.id,
          actorUserId: req.principal!.user.id,
          ...body,
        }),
      );
    }),
  );

  router.post(
    '/shipments/commit',
    requirePermission('import.run'),
    validate({ body: importCommitSchema }),
    asyncHandler(async (req, res) => {
      const body = req.body as { filename: string; content: string; mapping: Record<string, string> };
      res.json(
        await services.imports.commit({
          organizationId: req.organization!.id,
          actorUserId: req.principal!.user.id,
          ...body,
        }),
      );
    }),
  );

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      res.json({ imports: await services.imports.list(req.organization!.id) });
    }),
  );

  router.get(
    '/:importId',
    validate({ params: importParams }),
    asyncHandler(async (req, res) => {
      res.json(await services.imports.status(req.organization!.id, req.params.importId as string));
    }),
  );

  router.get(
    '/:importId/errors.csv',
    validate({ params: importParams }),
    asyncHandler(async (req, res) => {
      const csv = await services.imports.errorReportCsv(
        req.organization!.id,
        req.params.importId as string,
      );
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="shipcheck-import-errors.csv"');
      res.send(csv);
    }),
  );

  return router;
}

export function integrationRouter(services: Services): Router {
  const router = Router({ mergeParams: true });

  router.get(
    '/carriers',
    asyncHandler(async (req, res) => {
      res.json({
        integrations: await services.integrations.list(req.organization!.id),
        syncRuns: await services.integrations.recentSyncRuns(req.organization!.id),
      });
    }),
  );

  router.put(
    '/carriers/:carrierCode',
    requirePermission('integration.manage'),
    validate({
      params: z.object({ organizationId: idParamSchema.shape.id, carrierCode: z.string().trim().min(1).max(32) }),
      body: carrierIntegrationSchema.omit({ carrierCode: true }),
    }),
    asyncHandler(async (req, res) => {
      const integration = await services.integrations.save({
        organizationId: req.organization!.id,
        carrierCode: (req.params.carrierCode as string).toLowerCase(),
        actorUserId: req.principal!.user.id,
        ...(req.body as { credentials: Record<string, string>; enabled: boolean }),
      });
      res.json({ integration });
    }),
  );

  router.post(
    '/carriers/:carrierCode/test',
    requirePermission('integration.manage'),
    validate({
      params: z.object({ organizationId: idParamSchema.shape.id, carrierCode: z.string().trim().min(1).max(32) }),
    }),
    asyncHandler(async (req, res) => {
      const result = await services.integrations.test(
        req.organization!.id,
        (req.params.carrierCode as string).toLowerCase(),
        req.principal!.user.id,
      );
      res.json(result);
    }),
  );

  router.delete(
    '/carriers/:carrierCode',
    requirePermission('integration.manage'),
    validate({
      params: z.object({ organizationId: idParamSchema.shape.id, carrierCode: z.string().trim().min(1).max(32) }),
    }),
    asyncHandler(async (req, res) => {
      await services.integrations.disconnect(
        req.organization!.id,
        (req.params.carrierCode as string).toLowerCase(),
        req.principal!.user.id,
      );
      res.status(204).end();
    }),
  );

  return router;
}

export function settingsRouter(services: Services): Router {
  const router = Router({ mergeParams: true });

  router.get(
    '/notifications',
    asyncHandler(async (req, res) => {
      const verification = await services.emailAdapter.verifyConfiguration();
      res.json({
        rules: await services.organizations.listNotificationRules(req.organization!.id),
        settings: await services.organizations.getSettings(req.organization!.id),
        email: {
          provider: services.emailAdapter.name,
          deliversMessages: services.emailAdapter.deliversMessages,
          detail: verification.detail,
          setupHint: services.emailAdapter.setupHint,
        },
        outbox: await services.email.outbox(req.organization!.id, 25),
        note: 'A message marked "sent" means the provider accepted it. ShipCheck never claims an email was delivered.',
      });
    }),
  );

  router.patch(
    '/notifications',
    requirePermission('notification.manage'),
    validate({ body: updateNotificationRulesSchema }),
    asyncHandler(async (req, res) => {
      res.json({
        rules: await services.organizations.updateNotificationRules(
          req.organization!.id,
          req.principal!.user.id,
          (req.body as { rules: Array<{ eventType: string; enabled: boolean; cooldownMinutes: number }> }).rules,
        ),
      });
    }),
  );

  router.patch(
    '/organization',
    requirePermission('settings.manage'),
    validate({ body: updateOrganizationSettingsSchema }),
    asyncHandler(async (req, res) => {
      res.json({
        settings: await services.organizations.updateSettings(
          req.organization!.id,
          req.principal!.user.id,
          req.body as never,
        ),
      });
    }),
  );

  return router;
}

export function exportRouter(services: Services): Router {
  const router = Router({ mergeParams: true });

  router.post(
    '/shipments',
    requirePermission('report.export'),
    validate({ body: exportShipmentsSchema }),
    asyncHandler(async (req, res) => {
      const result = await services.exports.shipmentsCsv({
        organizationId: req.organization!.id,
        actorUserId: req.principal!.user.id,
        includeCustomerEmail: (req.body as { includeCustomerEmail: boolean }).includeCustomerEmail,
        requestId: req.requestId,
      });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
      res.setHeader('X-Row-Count', String(result.rowCount));
      res.send(result.csv);
    }),
  );

  router.post(
    '/events',
    requirePermission('report.export'),
    asyncHandler(async (req, res) => {
      const result = await services.exports.eventsCsv({
        organizationId: req.organization!.id,
        actorUserId: req.principal!.user.id,
        requestId: req.requestId,
      });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
      res.send(result.csv);
    }),
  );

  router.post(
    '/exceptions',
    requirePermission('report.export'),
    asyncHandler(async (req, res) => {
      const result = await services.exports.exceptionsCsv({
        organizationId: req.organization!.id,
        actorUserId: req.principal!.user.id,
        requestId: req.requestId,
      });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
      res.send(result.csv);
    }),
  );

  return router;
}