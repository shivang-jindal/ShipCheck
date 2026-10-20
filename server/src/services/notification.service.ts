/**
 * Customer shipment notifications (Part C / C3.7, C4).
 *
 * A notification is queued only for a meaningful state TRANSITION, and the log
 * carries a unique idempotency key built from
 * (shipment, eventType, event id) plus the rule cooldown window, so a duplicate
 * carrier event never produces a second customer message.
 */

import { and, desc, eq, gte, sql } from 'drizzle-orm';

import {
  EXCEPTION_TYPE_LABELS,
  SHIPMENT_STATUS_LABELS,
  type ShipmentStatus,
} from '@shipcheck/shared';

import type { AppDatabase } from '../db/client.js';
import { notificationLogs, notificationRules, organizations, shipmentExceptions, shipments } from '../db/schema.js';
import { sha256Hex } from '../lib/crypto.js';
import type { ShipmentTemplateContext } from '../integrations/email/templates.js';
import type { EmailService } from './email.service.js';
import type { JobQueue } from '../jobs/queue.js';
import { carrierName } from './shipment.service.js';

export interface NotificationRow {
  id: string;
  shipmentId: string;
  eventId: string | null;
  recipientHash: string;
  eventType: string;
  status: string;
  attempts: number;
  providerMessageId: string | null;
  failureCode: string | null;
  safeFailureMessage: string | null;
  sentAt: string | null;
  createdAt: string;
  idempotencyKey: string;
}

export class NotificationService {
  constructor(
    private readonly db: AppDatabase,
    private readonly email: EmailService,
    private readonly jobs: JobQueue,
  ) {}

  /** Queue notifications for meaningful transitions that are inside cooldown. */
  async queueForTransitions(input: {
    organizationId: string;
    shipmentId: string;
    fromStatus: ShipmentStatus | null;
    toStatus: ShipmentStatus;
    eventId: string | null;
  }): Promise<{ queued: number; skipped: string[] }> {
    const skipped: string[] = [];
    if (input.fromStatus === input.toStatus) {
      skipped.push('no_status_change');
      return { queued: 0, skipped };
    }

    const shipment = (
      await this.db
        .select()
        .from(shipments)
        .where(
          and(
            eq(shipments.id, input.shipmentId),
            eq(shipments.organizationId, input.organizationId),
          ),
        )
        .limit(1)
    )[0];
    if (!shipment) return { queued: 0, skipped: ['shipment_not_found'] };
    if (!shipment.customerEmail) {
      skipped.push('no_customer_email');
      return { queued: 0, skipped };
    }

    const eventType = toEventType(input.toStatus);
    if (!eventType) {
      skipped.push('status_not_notifiable');
      return { queued: 0, skipped };
    }

    const rule = (
      await this.db
        .select()
        .from(notificationRules)
        .where(
          and(
            eq(notificationRules.organizationId, input.organizationId),
            eq(notificationRules.eventType, eventType),
          ),
        )
        .limit(1)
    )[0];
    if (!rule || !rule.enabled) {
      skipped.push('rule_disabled');
      return { queued: 0, skipped };
    }

    // Cooldown: never message the same customer twice inside the window.
    if (rule.cooldownMinutes > 0) {
      const since = new Date(Date.now() - rule.cooldownMinutes * 60_000);
      const recent = await this.db
        .select({ id: notificationLogs.id })
        .from(notificationLogs)
        .where(
          and(
            eq(notificationLogs.organizationId, input.organizationId),
            eq(notificationLogs.shipmentId, input.shipmentId),
            eq(notificationLogs.eventType, eventType),
            gte(notificationLogs.createdAt, since),
          ),
        )
        .limit(1);
      if (recent[0]) {
        skipped.push('inside_cooldown');
        return { queued: 0, skipped };
      }
    }

    const organization = (
      await this.db
        .select()
        .from(organizations)
        .where(eq(organizations.id, input.organizationId))
        .limit(1)
    )[0];

    const openException = (
      await this.db
        .select({ type: shipmentExceptions.type })
        .from(shipmentExceptions)
        .where(
          and(
            eq(shipmentExceptions.organizationId, input.organizationId),
            eq(shipmentExceptions.shipmentId, input.shipmentId),
            sql`${shipmentExceptions.status} in ('open','acknowledged')`,
          ),
        )
        .orderBy(desc(shipmentExceptions.openedAt))
        .limit(1)
    )[0];

    const lastEvent = input.eventId
      ? (
          await this.db.execute<{ event_at: Date; description: string; location_text: string | null }>(
            sql`select event_at, description, location_text from tracking_events where id = ${input.eventId}`,
          )
        ).rows[0]
      : undefined;

    const context: ShipmentTemplateContext = {
      organizationName: organization?.name ?? 'Your sender',
      trackingNumber: shipment.trackingNumber,
      publicReference: shipment.publicReference ?? '',
      carrierName: carrierName(shipment.carrierCode),
      statusLabel: SHIPMENT_STATUS_LABELS[input.toStatus] ?? input.toStatus,
      statusMessage: lastEvent?.description ?? '',
      locationText: lastEvent?.location_text ?? '',
      occurredAt: lastEvent?.event_at?.toISOString() ?? new Date().toISOString(),
      estimatedDelivery: shipment.estimatedDeliveryAt?.toISOString().slice(0, 10) ?? '',
      publicUrl: '',
      exceptionTypeLabel: openException
        ? (EXCEPTION_TYPE_LABELS[openException.type as never] ?? openException.type)
        : '',
      nextAction: openException ? 'Please check the address and contact the sender.' : 'No action is needed.',
    };

    const idempotencyKey = `${input.organizationId}:${input.shipmentId}:${eventType}:${input.eventId ?? 'na'}`;

    const inserted = await this.db
      .insert(notificationLogs)
      .values({
        organizationId: input.organizationId,
        shipmentId: input.shipmentId,
        eventId: input.eventId,
        recipientHash: sha256Hex(shipment.customerEmail.toLowerCase()),
        eventType,
        status: 'queued',
        idempotencyKey,
      })
      .returning({ id: notificationLogs.id });

    if (!inserted[0]) {
      skipped.push('duplicate_notification');
      return { queued: 0, skipped };
    }

    const message = await this.email.queueInvoice({
      organizationId: input.organizationId,
      to: shipment.customerEmail,
      templateType: rule.templateId,
      context,
      relatedShipmentId: input.shipmentId,
      idempotencyKey: `email:${idempotencyKey}`,
    });

    await this.jobs.enqueue({
      jobType: 'notifications.dispatch',
      organizationId: input.organizationId,
      payload: {
        messageId: message.messageId,
        notificationLogId: inserted[0].id,
      },
      idempotencyKey: `dispatch:${inserted[0].id}`,
    });

    return { queued: 1, skipped };
  }

  async deliverNotification(messageId: string, notificationLogId: string) {
    const result = await this.email.deliver(messageId);
    await this.db
      .update(notificationLogs)
      .set({
        status: result.status,
        attempts: sql`${notificationLogs.attempts} + 1`,
        sentAt: result.status === 'sent' ? new Date() : null,
        providerMessageId: result.providerMessageId,
        failureCode: result.status === 'failed' ? 'send_failed' : null,
        safeFailureMessage: result.status === 'failed' ? result.message.slice(0, 300) : null,
      })
      .where(eq(notificationLogs.id, notificationLogId));
    return result;
  }

  async history(organizationId: string, shipmentId?: string, limit = 50) {
    return this.db
      .select()
      .from(notificationLogs)
      .where(
        shipmentId
          ? and(
              eq(notificationLogs.organizationId, organizationId),
              eq(notificationLogs.shipmentId, shipmentId),
            )
          : eq(notificationLogs.organizationId, organizationId),
      )
      .orderBy(desc(notificationLogs.createdAt))
      .limit(limit);
  }

  async retry(notificationLogId: string) {
    const rows = await this.db
      .select()
      .from(notificationLogs)
      .where(eq(notificationLogs.id, notificationLogId))
      .limit(1);
    const log = rows[0];
    if (!log) return false;
    await this.jobs.enqueue({
      jobType: 'notifications.dispatch',
      organizationId: log.organizationId,
      payload: { notificationLogId: log.id },
      idempotencyKey: `dispatch-retry:${log.id}:${log.attempts + 1}`,
    });
    return true;
  }
}

function toEventType(status: ShipmentStatus): string | null {
  switch (status) {
    case 'label_created':
      return 'shipment_created';
    case 'in_transit':
      return 'in_transit';
    case 'out_for_delivery':
      return 'out_for_delivery';
    case 'delivered':
      return 'delivered';
    case 'exception':
    case 'returned_to_sender':
      return 'exception';
    default:
      return null;
  }
}