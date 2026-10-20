/**
 * Carrier integrations (Part C / C3.6, C7).
 *
 * ShipCheck ships NO carrier adapter. A carrier only becomes "connected" when an
 * operator stores verified credentials AND a real verification call succeeds.
 * Until then the UI says "Not connected" and manual tracking is used.
 *
 * The adapter contract below is the boundary a real adapter must satisfy. It is
 * documented here so an integrator knows exactly what is required; nothing in
 * this repository pretends to implement a carrier lookup.
 */

import { and, desc, eq, sql } from 'drizzle-orm';

import { CARRIER_CATALOGUE, type ShipmentStatus } from '@shipcheck/shared';

import type { AppDatabase } from '../db/client.js';
import { carrierIntegrations, integrationSyncRuns } from '../db/schema.js';
import { integrationUnavailable, notFound, unprocessable } from '../errors.js';
import { maskSecret, openCredentials, sealCredentials } from '../lib/crypto.js';
import type { AuditService } from './audit.service.js';

export interface CarrierEvent {
  /** The carrier's own event identifier, used for deduplication. */
  providerEventId: string;
  eventCode: string;
  description: string;
  locationText?: string | null;
  eventAt: Date;
  rawPayloadRedacted?: Record<string, unknown>;
}

export interface CarrierPollResult {
  statusCode: number;
  events: CarrierEvent[];
  estimatedDeliveryAt?: Date | null;
}

/**
 * The contract a real carrier adapter must implement (C3.6).
 * ShipCheck does not currently ship an implementation of this interface.
 */
export interface CarrierAdapter {
  readonly carrierCode: string;
  readonly displayName: string;
  /** Documented provider quota, when published. */
  readonly documentedRateLimit?: { requestsPerHour: number; notes: string };
  testConnection(): Promise<{ ok: boolean; detail: string; failureCode?: string }>;
  poll(shipments: Array<{ trackingNumber: string }>): Promise<CarrierPollResult>;
  /** HTTP statuses and errors that are worth retrying. */
  isRetryable(failureCode: string): boolean;
}

export interface IntegrationStatusView {
  carrierCode: string;
  displayName: string;
  /** `implemented` is false for every carrier until an adapter ships. */
  implemented: boolean;
  status: 'not_configured' | 'configured' | 'error' | 'disabled';
  enabled: boolean;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  pollIntervalMinutes: number;
  maskedKeys: Array<{ key: string; masked: string }>;
  supportedEvents: string[];
  documentedRateLimit: string | null;
  setupGuide: string[];
  limitations: string[];
}

export class IntegrationService {
  constructor(
    private readonly db: AppDatabase,
    private readonly audit: AuditService,
    private readonly encryptionKey: Buffer | null,
  ) {}

  async list(organizationId: string): Promise<IntegrationStatusView[]> {
    const rows = await this.db
      .select()
      .from(carrierIntegrations)
      .where(eq(carrierIntegrations.organizationId, organizationId));

    const views: IntegrationStatusView[] = [];
    for (const carrier of CARRIER_CATALOGUE) {
      if (carrier.code === 'manual') continue;
      const row = rows.find((entry) => entry.carrierCode === carrier.code);
      views.push({
        carrierCode: carrier.code,
        displayName: carrier.displayName,
        implemented: false,
        status: (row?.status as IntegrationStatusView['status']) ?? 'not_configured',
        enabled: row?.enabled ?? false,
        lastCheckedAt: row?.lastCheckedAt?.toISOString() ?? null,
        lastSuccessAt: row?.lastSuccessAt?.toISOString() ?? null,
        lastErrorCode: row?.lastErrorCode ?? null,
        lastErrorMessage: row?.lastErrorMessage ?? null,
        pollIntervalMinutes: row?.pollIntervalMinutes ?? 60,
        maskedKeys: row ? await this.describeKeys(organizationId, carrier.code) : [],
        supportedEvents: [
          'ShipCheck does not currently implement this carrier. Manual event entry and CSV import remain available.',
        ],
        documentedRateLimit: null,
        setupGuide: [
          'ShipCheck does not ship a live carrier adapter for this carrier yet. Nothing you enter will make ShipCheck call the carrier API.',
          'Manual tracking works today: add the shipment, then add tracking events by hand or import them from CSV.',
          "To add this carrier, implement the CarrierAdapter interface in server/src/services/integration.service.ts against the carrier's documented API, and document its authentication, scopes, pagination, rate limits and retryable errors.",
          'A carrier is only reported as connected after a real verification call succeeds.',
        ],
        limitations: [
          'No automated polling runs for this carrier. ShipCheck never fabricates carrier lookup results.',
          'A tracking number alone does not guarantee carrier-side tracking access; the carrier account must be authorised for it.',
        ],
      });
    }
    return views;
  }

  async save(input: {
    organizationId: string;
    carrierCode: string;
    actorUserId: string;
    credentials: Record<string, string>;
    enabled: boolean;
  }): Promise<IntegrationStatusView> {
    if (Object.keys(input.credentials).length > 0 && !this.encryptionKey) {
      throw unprocessable(
        'ENCRYPTION_KEY is not configured on the server, so credentials cannot be stored safely. Set ENCRYPTION_KEY and restart the API.',
      );
    }

    const existing = (
      await this.db
        .select()
        .from(carrierIntegrations)
        .where(
          and(
            eq(carrierIntegrations.organizationId, input.organizationId),
            eq(carrierIntegrations.carrierCode, input.carrierCode),
          ),
        )
        .limit(1)
    )[0];

    const sealed =
      Object.keys(input.credentials).length > 0 && this.encryptionKey
        ? sealCredentials(this.encryptionKey, input.credentials)
        : (existing?.encryptedCredentials ?? null);

    const values = {
      encryptedCredentials: sealed,
      // Honest status: storing credentials alone is not a connection.
      status: sealed ? ('configured' as const) : ('not_configured' as const),
      enabled: input.enabled,
      updatedAt: new Date(),
      lastErrorCode: null,
      lastErrorMessage: null,
    };

    if (existing) {
      await this.db.update(carrierIntegrations).set(values).where(eq(carrierIntegrations.id, existing.id));
    } else {
      await this.db.insert(carrierIntegrations).values({
        organizationId: input.organizationId,
        carrierCode: input.carrierCode,
        ...values,
      });
    }

    await this.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: 'integration.updated',
      entityType: 'integration',
      entityId: input.carrierCode,
      metadata: { keys: Object.keys(input.credentials), enabled: input.enabled },
    });

    const views = await this.list(input.organizationId);
    return views.find((view) => view.carrierCode === input.carrierCode)!;
  }

  /**
   * Real verification. With no adapter implemented this can never report
   * success - it says exactly why.
   */
  async test(
    organizationId: string,
    carrierCode: string,
    actorUserId: string,
  ): Promise<{ ok: boolean; detail: string; status: IntegrationStatusView['status'] }> {
    const detail =
      'ShipCheck has no implemented adapter for this carrier, so there is nothing to verify against. Manual tracking and CSV import are unaffected.';

    const existing = (
      await this.db
        .select()
        .from(carrierIntegrations)
        .where(
          and(
            eq(carrierIntegrations.organizationId, organizationId),
            eq(carrierIntegrations.carrierCode, carrierCode),
          ),
        )
        .limit(1)
    )[0];

    const values = {
      lastCheckedAt: new Date(),
      lastErrorCode: 'adapter_not_implemented',
      lastErrorMessage: detail,
      status: 'not_configured' as const,
      updatedAt: new Date(),
    };
    if (existing) {
      await this.db.update(carrierIntegrations).set(values).where(eq(carrierIntegrations.id, existing.id));
    } else {
      await this.db.insert(carrierIntegrations).values({
        organizationId,
        carrierCode,
        enabled: false,
        ...values,
      });
    }

    await this.audit.record({
      organizationId,
      actorUserId,
      action: 'integration.tested',
      entityType: 'integration',
      entityId: carrierCode,
      metadata: { ok: false, reason: 'adapter_not_implemented' },
    });

    return { ok: false, detail, status: 'not_configured' };
  }

  async disconnect(organizationId: string, carrierCode: string, actorUserId: string) {
    const updated = await this.db
      .update(carrierIntegrations)
      .set({
        encryptedCredentials: null,
        status: 'not_configured',
        enabled: false,
        lastErrorCode: null,
        lastErrorMessage: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(carrierIntegrations.organizationId, organizationId),
          eq(carrierIntegrations.carrierCode, carrierCode),
        ),
      )
      .returning({ id: carrierIntegrations.id });
    if (!updated[0]) throw notFound('Integration');
    await this.audit.record({
      organizationId,
      actorUserId,
      action: 'integration.disconnected',
      entityType: 'integration',
      entityId: carrierCode,
    });
  }

  /**
   * Called by the worker. Refuses loudly rather than pretending to poll.
   */
  async pollCarrier(organizationId: string, carrierCode: string) {
    throw integrationUnavailable(
      `ShipCheck has no implemented adapter for ${carrierCode}; automatic polling is unavailable. No shipment was marked delayed.`,
      { carrierCode },
    );
  }

  async recordSyncRun(input: {
    organizationId: string;
    carrierCode: string;
    status: 'running' | 'succeeded' | 'failed' | 'skipped';
    fetchedCount?: number;
    insertedCount?: number;
    duplicateCount?: number;
    errorCode?: string | null;
    safeErrorMessage?: string | null;
  }) {
    await this.db.insert(integrationSyncRuns).values({
      organizationId: input.organizationId,
      carrierCode: input.carrierCode,
      status: input.status,
      fetchedCount: input.fetchedCount ?? 0,
      insertedCount: input.insertedCount ?? 0,
      duplicateCount: input.duplicateCount ?? 0,
      errorCode: input.errorCode ?? null,
      safeErrorMessage: input.safeErrorMessage?.slice(0, 300) ?? null,
      finishedAt: input.status === 'running' ? null : new Date(),
    });
  }

  async recentSyncRuns(organizationId: string, limit = 20) {
    return this.db
      .select()
      .from(integrationSyncRuns)
      .where(eq(integrationSyncRuns.organizationId, organizationId))
      .orderBy(desc(integrationSyncRuns.startedAt))
      .limit(limit);
  }

  async stats(organizationId: string) {
    const rows = await this.db
      .select({ status: carrierIntegrations.status, count: sql<number>`count(*)::int` })
      .from(carrierIntegrations)
      .where(eq(carrierIntegrations.organizationId, organizationId))
      .groupBy(carrierIntegrations.status);
    return Object.fromEntries(rows.map((row) => [row.status, row.count]));
  }

  private async describeKeys(organizationId: string, carrierCode: string) {
    const values = await this.credentials(organizationId, carrierCode);
    return Object.entries(values).map(([key, value]) => ({ key, masked: maskSecret(value) ?? '' }));
  }

  async credentials(organizationId: string, carrierCode: string): Promise<Record<string, string>> {
    if (!this.encryptionKey) return {};
    const rows = await this.db
      .select()
      .from(carrierIntegrations)
      .where(
        and(
          eq(carrierIntegrations.organizationId, organizationId),
          eq(carrierIntegrations.carrierCode, carrierCode),
        ),
      )
      .limit(1);
    const sealed = rows[0]?.encryptedCredentials;
    if (!sealed) return {};
    try {
      return openCredentials(this.encryptionKey, sealed);
    } catch {
      return {};
    }
  }
}

export type { ShipmentStatus };