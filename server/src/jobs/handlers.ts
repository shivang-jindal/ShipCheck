/**
 * Job handlers (Part C / C4).
 *
 * Every handler reports a retryable/non-retryable outcome so the queue can
 * distinguish a transient failure from a permanent configuration problem.
 */

import { sql } from 'drizzle-orm';

import type { ExceptionType } from '@shipcheck/shared';

import type { Services } from '../container.js';

export interface JobOutcome {
  retryable: boolean;
  code: string;
  message: string;
}

export type JobHandler = (
  services: Services,
  payload: Record<string, unknown>,
) => Promise<JobOutcome>;

const ok = (message: string): JobOutcome => ({ retryable: false, code: 'ok', message });

const handlers: Record<string, JobHandler> = {
  /**
   * Poll a carrier. ShipCheck ships no adapter, so this handler records an
   * honest "not implemented" sync run and never touches shipment statuses.
   */
  'carrier.poll': async (services, payload) => {
    const organizationId = String(payload.organizationId ?? '');
    const carrierCode = String(payload.carrierCode ?? '');
    if (!organizationId || !carrierCode) {
      return { retryable: false, code: 'bad_payload', message: 'organizationId and carrierCode are required' };
    }

    await services.integrations.recordSyncRun({ organizationId, carrierCode, status: 'running' });
    try {
      await services.integrations.pollCarrier(organizationId, carrierCode);
      await services.integrations.recordSyncRun({ organizationId, carrierCode, status: 'succeeded' });
      return ok('Polling succeeded.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await services.integrations.recordSyncRun({
        organizationId,
        carrierCode,
        status: 'failed',
        errorCode: 'adapter_not_implemented',
        safeErrorMessage: message,
      });
      // Permanent: retrying an unimplemented adapter only produces noise.
      return {
        retryable: false,
        code: 'adapter_not_implemented',
        message: 'No carrier adapter is implemented. No shipment was marked delayed.',
      };
    }
  },

  /** Deliver one queued customer notification. */
  'notifications.dispatch': async (services, payload) => {
    const messageId = payload.messageId ? String(payload.messageId) : null;
    const notificationLogId = String(payload.notificationLogId ?? '');
    if (!messageId) return { retryable: false, code: 'bad_payload', message: 'messageId is required' };

    const result = await services.notifications.deliverNotification(messageId, notificationLogId);
    if (result.status === 'sent') return ok(result.message);

    return { retryable: result.retryable, code: 'email_send_failed', message: result.message };
  },

  /**
   * Open or refresh exceptions for shipments that stopped moving.
   *
   * Driven by SHIPMENT STALENESS only. A carrier outage or a missed polling job
   * never marks a shipment as delayed (C7).
   */
  'exceptions.scan': async (services, payload) => {
    const organizationId = String(payload.organizationId ?? '');
    if (!organizationId) return ok('No organization supplied.');

    const settings = await services.organizations.getSettings(organizationId);
    if (!settings?.autoOpenExceptions) {
      return ok('Automatic exception scanning is disabled for this organization.');
    }

    const cutoff = new Date(Date.now() - settings.stalledAfterHours * 3_600_000);
    const candidates = await services.shipments.staleSince(organizationId, cutoff, 200);

    let opened = 0;
    for (const candidate of candidates) {
      const result = await services.exceptions.open(organizationId, {
        shipmentId: candidate.id,
        type: 'stalled' as ExceptionType,
        severity: 'medium',
        detail:
          candidate.status === 'label_created'
            ? 'No carrier data has been received. ShipCheck does not treat that as a carrier delay.'
            : `No tracking event for ${settings.stalledAfterHours} hours.`,
        createdBy: null,
      });
      if (result.created) opened += 1;
      await services.shipments.markDerivedStatus(organizationId, candidate.id, 'exception');
    }

    return ok(`Scanned ${candidates.length} stale shipment(s); opened ${opened} new exception(s).`);
  },

  /** Close delivery-related exceptions once the shipment is delivered. */
  'exceptions.auto_close': async (services, payload) => {
    const organizationId = String(payload.organizationId ?? '');
    const shipmentId = String(payload.shipmentId ?? '');
    if (!organizationId || !shipmentId) return ok('Nothing to do.');

    const shipment = await services.shipments.get(organizationId, shipmentId);
    if (shipment.status !== 'delivered') return ok('Shipment is not delivered yet.');

    const open = await services.db
      .select({ id: sql<string>`id` })
      .from(sql`shipment_exceptions`)
      .where(
        sql`organization_id = ${organizationId} and shipment_id = ${shipmentId} and type in ('failed_delivery','delivery_exception','address_issue','returned_to_sender')`,
      );

    let closed = 0;
    for (const row of open) {
      await services.exceptions.resolve(organizationId, null, row.id, {
        status: 'resolved',
        reason: 'Automatically closed: the carrier reported delivery.',
      });
      closed += 1;
    }
    return ok(`Closed ${closed} delivery exception(s) after delivery.`);
  },

  'maintenance.cleanup': async (services) => {
    await services.db.execute({
      text: "delete from sessions where expires_at < now() or (revoked_at is not null and revoked_at < now() - interval '30 days')",
      values: [],
    } as never);
    await services.db.execute({
      text: 'delete from password_reset_tokens where expires_at < now()',
      values: [],
    } as never);
    return ok('Cleanup complete.');
  },
};

export function resolveHandler(jobType: string): JobHandler | null {
  return handlers[jobType] ?? null;
}

export function knownJobTypes(): string[] {
  return Object.keys(handlers);
}

export { enqueueRecurringFor as _enqueueRecurringFor };

/** Enqueue the recurring work for one organization. */
export async function enqueueRecurringFor(
  services: Services,
  organizationId: string,
  bucket: number,
): Promise<void> {
  await services.jobs.enqueue({
    jobType: 'exceptions.scan',
    organizationId,
    payload: { organizationId },
    idempotencyKey: `exceptions.scan:${organizationId}:${bucket}`,
  });

  const integrations = await services.integrations.list(organizationId);
  for (const integration of integrations) {
    if (integration.status !== 'configured' || !integration.enabled) continue;
    await services.jobs.enqueue({
      jobType: 'carrier.poll',
      organizationId,
      payload: { organizationId, carrierCode: integration.carrierCode },
      idempotencyKey: `carrier.poll:${integration.carrierCode}:${bucket}`,
    });
  }
}