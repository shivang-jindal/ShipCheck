/**
 * CSV export (Part C / C3.2, C8).
 *
 * Exports are permission-checked and audited, escape formula-leading cells and
 * omit customer email addresses unless the operator explicitly asks for them.
 */

import { asc, desc, eq, sql } from 'drizzle-orm';

import { toCsv } from '@shipcheck/shared';

import type { AppDatabase } from '../db/client.js';
import { shipmentExceptions, shipments, trackingEvents } from '../db/schema.js';
import type { AuditService } from './audit.service.js';
import { carrierName } from './shipment.service.js';

export class ExportService {
  constructor(
    private readonly db: AppDatabase,
    private readonly audit: AuditService,
  ) {}

  async shipmentsCsv(input: {
    organizationId: string;
    actorUserId: string;
    includeCustomerEmail: boolean;
    requestId?: string | null;
  }): Promise<{ filename: string; csv: string; rowCount: number }> {
    const rows = await this.db
      .select({
        trackingNumber: shipments.trackingNumber,
        carrierCode: shipments.carrierCode,
        orderReference: shipments.orderReference,
        publicReference: shipments.publicReference,
        customerName: shipments.customerName,
        customerEmail: shipments.customerEmail,
        destinationCountry: shipments.destinationCountry,
        status: shipments.status,
        lastCarrierStatus: shipments.lastCarrierStatus,
        shippedAt: shipments.shippedAt,
        estimatedDeliveryAt: shipments.estimatedDeliveryAt,
        deliveredAt: shipments.deliveredAt,
        lastEventAt: shipments.lastEventAt,
        lastEventDescription: shipments.lastEventDescription,
        eventCount: sql<number>`(select count(*)::int from tracking_events e where e.shipment_id = shipments.id)`,
        openExceptions: sql<number>`(select count(*)::int from shipment_exceptions e where e.shipment_id = shipments.id and e.status in ('open','acknowledged'))`,
      })
      .from(shipments)
      .where(eq(shipments.organizationId, input.organizationId))
      .orderBy(asc(shipments.createdAt));

    const stamp = new Date().toISOString().slice(0, 10);
    const header = [
      'tracking_number',
      'carrier',
      'order_reference',
      'public_reference',
      'customer_name',
      ...(input.includeCustomerEmail ? ['customer_email'] : []),
      'destination_country',
      'status',
      'last_carrier_status',
      'shipped_at',
      'estimated_delivery_at',
      'delivered_at',
      'last_event_at',
      'last_event_description',
      'event_count',
      'open_exceptions',
    ];

    const csv = toCsv(
      rows.map((row) => [
        row.trackingNumber,
        carrierName(row.carrierCode),
        row.orderReference ?? '',
        row.publicReference ?? '',
        row.customerName ?? '',
        ...(input.includeCustomerEmail ? [row.customerEmail ?? ''] : []),
        row.destinationCountry ?? '',
        row.status,
        row.lastCarrierStatus ?? '',
        row.shippedAt?.toISOString().slice(0, 10) ?? '',
        row.estimatedDeliveryAt?.toISOString().slice(0, 10) ?? '',
        row.deliveredAt?.toISOString().slice(0, 10) ?? '',
        row.lastEventAt?.toISOString() ?? '',
        row.lastEventDescription ?? '',
        String(row.eventCount),
        String(row.openExceptions),
      ]),
      header,
    );

    await this.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: 'export.generated',
      entityType: 'organization',
      entityId: input.organizationId,
      metadata: { dataset: 'shipments', rowCount: rows.length, includeCustomerEmail: input.includeCustomerEmail },
      requestId: input.requestId ?? null,
    });

    return { filename: `shipcheck-shipments-${stamp}.csv`, csv, rowCount: rows.length };
  }

  async eventsCsv(input: {
    organizationId: string;
    actorUserId: string;
    requestId?: string | null;
  }): Promise<{ filename: string; csv: string; rowCount: number }> {
    const rows = await this.db
      .select({
        trackingNumber: shipments.trackingNumber,
        eventCode: trackingEvents.eventCode,
        normalizedStatus: trackingEvents.normalizedStatus,
        description: trackingEvents.description,
        locationText: trackingEvents.locationText,
        eventAt: trackingEvents.eventAt,
        receivedAt: trackingEvents.receivedAt,
        source: trackingEvents.source,
      })
      .from(trackingEvents)
      .innerJoin(shipments, eq(shipments.id, trackingEvents.shipmentId))
      .where(eq(trackingEvents.organizationId, input.organizationId))
      .orderBy(desc(trackingEvents.eventAt));

    const stamp = new Date().toISOString().slice(0, 10);
    await this.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: 'export.generated',
      entityType: 'organization',
      entityId: input.organizationId,
      metadata: { dataset: 'events', rowCount: rows.length },
      requestId: input.requestId ?? null,
    });

    return {
      filename: `shipcheck-events-${stamp}.csv`,
      rowCount: rows.length,
      csv: toCsv(
        rows.map((row) => [
          row.trackingNumber,
          row.eventCode,
          row.normalizedStatus,
          row.description,
          row.locationText ?? '',
          row.eventAt.toISOString(),
          row.receivedAt.toISOString(),
          row.source,
        ]),
        [
          'tracking_number',
          'event_code',
          'normalized_status',
          'description',
          'location',
          'event_at',
          'received_at',
          'source',
        ],
      ),
    };
  }

  async exceptionsCsv(input: {
    organizationId: string;
    actorUserId: string;
    requestId?: string | null;
  }): Promise<{ filename: string; csv: string; rowCount: number }> {
    const rows = await this.db
      .select({
        trackingNumber: shipments.trackingNumber,
        type: shipmentExceptions.type,
        severity: shipmentExceptions.severity,
        status: shipmentExceptions.status,
        detail: shipmentExceptions.detail,
        openedAt: shipmentExceptions.openedAt,
        resolvedAt: shipmentExceptions.resolvedAt,
        resolutionReason: shipmentExceptions.resolutionReason,
      })
      .from(shipmentExceptions)
      .innerJoin(shipments, eq(shipments.id, shipmentExceptions.shipmentId))
      .where(eq(shipmentExceptions.organizationId, input.organizationId))
      .orderBy(desc(shipmentExceptions.openedAt));

    const stamp = new Date().toISOString().slice(0, 10);
    await this.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: 'export.generated',
      entityType: 'organization',
      entityId: input.organizationId,
      metadata: { dataset: 'exceptions', rowCount: rows.length },
      requestId: input.requestId ?? null,
    });

    return {
      filename: `shipcheck-exceptions-${stamp}.csv`,
      rowCount: rows.length,
      csv: toCsv(
        rows.map((row) => [
          row.trackingNumber,
          row.type,
          row.severity,
          row.status,
          row.detail ?? '',
          row.openedAt.toISOString(),
          row.resolvedAt?.toISOString() ?? '',
          row.resolutionReason ?? '',
        ]),
        [
          'tracking_number',
          'type',
          'severity',
          'status',
          'detail',
          'opened_at',
          'resolved_at',
          'resolution_reason',
        ],
      ),
    };
  }
}