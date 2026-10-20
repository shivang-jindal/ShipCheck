/**
 * Public, unauthenticated routes.
 *
 * The tracking page exposes only safe data: a public reference, the carrier,
 * the status, the customer-visible timeline and any estimate the sender
 * supplied. Internal notes, staff names, full addresses, the customer's email
 * and raw provider payloads are never included (C3.8, C7).
 */

import { Router } from 'express';
import { and, desc, eq, sql } from 'drizzle-orm';
import rateLimit from 'express-rate-limit';

import { SHIPMENT_STATUS_LABELS } from '@shipcheck/shared';

import type { Services } from '../../container.js';
import { shipmentExceptions, trackingEvents } from '../../db/schema.js';
import { asyncHandler } from '../middleware.js';
import { carrierName } from '../../services/shipment.service.js';

export function publicRouter(services: Services): Router {
  const router = Router();

  const publicLimit = rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: {
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many tracking requests. Please wait a moment and try again.',
      },
    },
  });

  router.get(
    '/tracking/:token',
    publicLimit,
    asyncHandler(async (req, res) => {
      const token = req.params.token as string;
      if (!/^[A-Za-z0-9_-]{32,64}$/.test(token)) {
        res.status(404).json({
          error: { code: 'NOT_FOUND', message: 'This tracking link is not valid.', requestId: req.requestId },
        });
        return;
      }

      const shipment = await services.shipments.findByPublicToken(token);
      if (!shipment) {
        res.status(404).json({
          error: {
            code: 'NOT_FOUND',
            message: 'This tracking link is not valid or has been revoked.',
            requestId: req.requestId,
          },
        });
        return;
      }

      const events = await services.db
        .select({
          eventCode: trackingEvents.eventCode,
          normalizedStatus: trackingEvents.normalizedStatus,
          description: trackingEvents.description,
          locationText: trackingEvents.locationText,
          eventAt: trackingEvents.eventAt,
          source: trackingEvents.source,
        })
        .from(trackingEvents)
        .where(
          and(eq(trackingEvents.shipmentId, shipment.id), eq(trackingEvents.isCustomerVisible, true)),
        )
        .orderBy(desc(trackingEvents.eventAt), desc(trackingEvents.receivedAt));

      const openExceptions = await services.db
        .select({ type: shipmentExceptions.type })
        .from(shipmentExceptions)
        .where(
          and(
            eq(shipmentExceptions.organizationId, shipment.organizationId),
            eq(shipmentExceptions.shipmentId, shipment.id),
            sql`${shipmentExceptions.status} in ('open','acknowledged')`,
          ),
        )
        .limit(1);

      const organization = (
        await services.db.execute<{ name: string }>(
          sql`select name from organizations where id = ${shipment.organizationId}`,
        )
      ).rows[0];

      res.json({
        // Only these fields are intentionally public.
        sender: organization?.name ?? 'The sender',
        shipment: {
          publicReference: shipment.publicReference,
          carrier: carrierName(shipment.carrierCode),
          status: shipment.status,
          statusLabel: SHIPMENT_STATUS_LABELS[shipment.status as never] ?? shipment.status,
          shippedAt: shipment.shippedAt?.toISOString().slice(0, 10) ?? null,
          estimatedDeliveryAt: shipment.estimatedDeliveryAt?.toISOString().slice(0, 10) ?? null,
          deliveredAt: shipment.deliveredAt?.toISOString().slice(0, 10) ?? null,
          lastUpdatedAt: shipment.updatedAt.toISOString(),
          estimateSource: 'Provided by the sender. It is an estimate, not a guarantee.',
        },
        events: events.map((event) => ({
          eventCode: event.eventCode,
          status: event.normalizedStatus,
          description: event.description,
          locationText: event.locationText,
          occurredAt: event.eventAt.toISOString(),
          // Manual entries are labelled so nobody mistakes them for carrier data.
          source: event.source === 'manual' ? 'Recorded manually by the sender' : event.source,
        })),
        attention: openExceptions[0]
          ? 'The sender is aware of a problem with this shipment and is working on it.'
          : null,
        disclaimer:
          'ShipCheck reports what the carrier published or what the sender recorded. It cannot guarantee a delivery date.',
      });
    }),
  );

  return router;
}