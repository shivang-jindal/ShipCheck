/**
 * Shipments and tracking events (Part C / C3.2-C3.4, C4, C7).
 *
 * Invariants enforced here, never in the browser:
 *  - A tracking number is unique per (organization, carrier, tracking number).
 *    Tracking numbers are NOT globally unique: carriers reuse them (C7).
 *  - `event_at` (reported by the source) and `received_at` (recorded by
 *    ShipCheck) are stored separately, because carrier events arrive out of
 *    order.
 *  - An event with a known provider identity is inserted at most once.
 *  - Unknown carrier codes map to `unknown`; nothing is guessed.
 *  - The shipment status is DERIVED from the latest meaningful event using the
 *    documented precedence rules, never from arrival order.
 */

import { and, asc, count, desc, eq, gte, ilike, isNull, lte, ne, or, sql } from 'drizzle-orm';

import {
  CARRIER_CATALOGUE,
  STALLED_AFTER_HOURS,
  normalizeStatus,
  todayIso,
  type Paginated,
  type ShipmentListItem,
  type ShipmentStatus,
} from '@shipcheck/shared';

import type { AppDatabase } from '../db/client.js';
import { shipmentExceptions, shipments, trackingEvents, users } from '../db/schema.js';
import { conflict, notFound, unprocessable } from '../errors.js';
import { randomToken, sha256Hex } from '../lib/crypto.js';
import type { AuditService } from './audit.service.js';

export interface ShipmentInput {
  trackingNumber: string;
  carrierCode: string;
  orderReference?: string | null;
  publicReference?: string | null;
  customerName?: string | null;
  customerEmail?: string | null;
  destinationCountry?: string | null;
  shippedAt?: string | null;
  estimatedDeliveryAt?: string | null;
  internalNotes?: string | null;
}

export interface ShipmentListQuery {
  page: number;
  pageSize: number;
  q?: string;
  status: string;
  carrierCode?: string;
  destinationCountry?: string;
  hasException?: boolean;
  from?: string;
  to?: string;
  sort: string;
  order: 'asc' | 'desc';
}

export class ShipmentService {
  constructor(
    private readonly db: AppDatabase,
    private readonly audit: AuditService,
  ) {}

  /* ---------------------------------------------------------------------- */
  /* Reads                                                                  */
  /* ---------------------------------------------------------------------- */

  async list(organizationId: string, query: ShipmentListQuery): Promise<Paginated<ShipmentListItem>> {
    const filters = [eq(shipments.organizationId, organizationId), isNull(shipments.archivedAt)];
    if (query.status !== 'all') filters.push(eq(shipments.status, query.status));
    if (query.carrierCode) filters.push(eq(shipments.carrierCode, query.carrierCode));
    if (query.destinationCountry) filters.push(eq(shipments.destinationCountry, query.destinationCountry));
    if (query.from) filters.push(gte(shipments.createdAt, new Date(`${query.from}T00:00:00.000Z`)));
    if (query.to) filters.push(lte(shipments.createdAt, new Date(`${query.to}T23:59:59.999Z`)));
    if (query.q) {
      const needle = `%${query.q.replace(/[%_]/g, (match) => `\\${match}`)}%`;
      filters.push(
        or(
          ilike(shipments.trackingNumber, needle),
          ilike(shipments.orderReference, needle),
          ilike(shipments.publicReference, needle),
          ilike(shipments.customerName, needle),
        )!,
      );
    }
    if (query.hasException) {
      filters.push(
        sql`exists (
          select 1 from shipment_exceptions e
           where e.shipment_id = shipments.id
             and e.status in ('open','acknowledged')
        )`,
      );
    }

    const where = and(...filters);
    const orderColumn =
      query.sort === 'tracking_number'
        ? shipments.trackingNumber
        : query.sort === 'shipped_at'
          ? shipments.shippedAt
          : query.sort === 'estimated_delivery_at'
            ? shipments.estimatedDeliveryAt
            : query.sort === 'created_at'
              ? shipments.createdAt
              : shipments.lastEventAt;

    const rows = await this.db
      .select({
        id: shipments.id,
        trackingNumber: shipments.trackingNumber,
        carrierCode: shipments.carrierCode,
        orderReference: shipments.orderReference,
        publicReference: shipments.publicReference,
        customerName: shipments.customerName,
        destinationCountry: shipments.destinationCountry,
        status: shipments.status,
        lastCarrierStatus: shipments.lastCarrierStatus,
        shippedAt: shipments.shippedAt,
        estimatedDeliveryAt: shipments.estimatedDeliveryAt,
        deliveredAt: shipments.deliveredAt,
        lastEventAt: shipments.lastEventAt,
        lastEventDescription: shipments.lastEventDescription,
        lastPolledAt: shipments.lastPolledAt,
        createdAt: shipments.createdAt,
        openExceptions: sql<number>`(
          select count(*)::int from shipment_exceptions e
           where e.shipment_id = shipments.id and e.status in ('open','acknowledged')
        )`,
      })
      .from(shipments)
      .where(where)
      .orderBy(query.order === 'asc' ? asc(orderColumn) : desc(orderColumn))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    const countRows = await this.db
      .select({ total: count() })
      .from(shipments)
      .where(where);
    const total = countRows[0]?.total ?? 0;

    return {
      items: rows.map((row) => ({
        id: row.id,
        trackingNumber: row.trackingNumber,
        carrierCode: row.carrierCode,
        carrierName: carrierName(row.carrierCode),
        orderReference: row.orderReference,
        publicReference: row.publicReference,
        customerName: row.customerName,
        destinationCountry: row.destinationCountry,
        status: row.status as ShipmentStatus,
        lastCarrierStatus: (row.lastCarrierStatus as ShipmentStatus | null) ?? null,
        derivedStatus: row.status as ShipmentStatus,
        lastEventAt: row.lastEventAt?.toISOString() ?? null,
        lastEventDescription: row.lastEventDescription,
        shippedAt: row.shippedAt?.toISOString() ?? null,
        estimatedDeliveryAt: row.estimatedDeliveryAt?.toISOString() ?? null,
        deliveredAt: row.deliveredAt?.toISOString() ?? null,
        openExceptionCount: row.openExceptions ?? 0,
        lastPolledAt: row.lastPolledAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      })),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    };
  }

  async get(organizationId: string, shipmentId: string) {
    const rows = await this.db
      .select()
      .from(shipments)
      .where(
        and(
          eq(shipments.id, shipmentId),
          eq(shipments.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound('Shipment');
    return rows[0];
  }

  async detail(organizationId: string, shipmentId: string) {
    const shipment = await this.get(organizationId, shipmentId);

    const events = await this.db
      .select({
        id: trackingEvents.id,
        eventCode: trackingEvents.eventCode,
        normalizedStatus: trackingEvents.normalizedStatus,
        description: trackingEvents.description,
        locationText: trackingEvents.locationText,
        eventAt: trackingEvents.eventAt,
        receivedAt: trackingEvents.receivedAt,
        source: trackingEvents.source,
        providerEventId: trackingEvents.providerEventId,
        isCustomerVisible: trackingEvents.isCustomerVisible,
      })
      .from(trackingEvents)
      .where(eq(trackingEvents.shipmentId, shipmentId))
      // Timeline is ordered by the reported event time, newest first.
      .orderBy(desc(trackingEvents.eventAt), desc(trackingEvents.receivedAt));

    const exceptions = await this.db
      .select()
      .from(shipmentExceptions)
      .where(eq(shipmentExceptions.shipmentId, shipmentId))
      .orderBy(desc(shipmentExceptions.openedAt));

    const timeline = await this.audit.forEntity('shipment', shipmentId, 60);

    return {
      shipment: {
        ...shipment,
        carrierName: carrierName(shipment.carrierCode),
        status: shipment.status as ShipmentStatus,
        lastCarrierStatus: (shipment.lastCarrierStatus as ShipmentStatus | null) ?? null,
        derivedStatus: shipment.status as ShipmentStatus,
        publicLinkActive: Boolean(shipment.publicTokenHash) && !shipment.publicTokenRevokedAt,
        shippedAt: shipment.shippedAt?.toISOString() ?? null,
        estimatedDeliveryAt: shipment.estimatedDeliveryAt?.toISOString() ?? null,
        deliveredAt: shipment.deliveredAt?.toISOString() ?? null,
        lastEventAt: shipment.lastEventAt?.toISOString() ?? null,
        lastPolledAt: shipment.lastPolledAt?.toISOString() ?? null,
        createdAt: shipment.createdAt.toISOString(),
        updatedAt: shipment.updatedAt.toISOString(),
      },
      events: events.map((event) => ({
        ...event,
        normalizedStatus: event.normalizedStatus as ShipmentStatus,
        eventAt: event.eventAt.toISOString(),
        receivedAt: event.receivedAt.toISOString(),
        source: event.source as 'carrier' | 'manual' | 'import',
      })),
      exceptions: exceptions.map((exception) => ({
        ...exception,
        type: exception.type as string,
        severity: exception.severity as string,
        status: exception.status as string,
        openedAt: exception.openedAt.toISOString(),
        acknowledgedAt: exception.acknowledgedAt?.toISOString() ?? null,
        resolvedAt: exception.resolvedAt?.toISOString() ?? null,
        lastNotifiedAt: exception.lastNotifiedAt?.toISOString() ?? null,
        createdAt: exception.createdAt.toISOString(),
        updatedAt: exception.updatedAt.toISOString(),
      })),
      timeline,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Writes                                                                 */
  /* ---------------------------------------------------------------------- */

  async create(
    organizationId: string,
    actorUserId: string,
    input: ShipmentInput,
    context: { requestId?: string | null } = {},
  ) {
    await this.assertDuplicate(organizationId, input.carrierCode, input.trackingNumber);

    const publicToken = randomToken(32);

    const inserted = await this.db
      .insert(shipments)
      .values({
        organizationId,
        trackingNumber: input.trackingNumber.trim(),
        carrierCode: input.carrierCode,
        orderReference: input.orderReference ?? null,
        publicReference: input.publicReference ?? null,
        customerName: input.customerName ?? null,
        customerEmail: input.customerEmail ?? null,
        destinationCountry: input.destinationCountry ?? null,
        shippedAt: input.shippedAt ? new Date(`${input.shippedAt}T00:00:00.000Z`) : null,
        estimatedDeliveryAt: input.estimatedDeliveryAt
          ? new Date(`${input.estimatedDeliveryAt}T00:00:00.000Z`)
          : null,
        internalNotes: input.internalNotes ?? null,
        publicTokenHash: sha256Hex(publicToken),
        // A brand new shipment starts in "awaiting carrier data" (C4 step 3).
        status: 'label_created',
        lastCarrierStatus: null,
        source: 'manual',
        createdBy: actorUserId,
      })
      .returning();

    const shipment = inserted[0]!;

    // Every shipment starts with an explicit "created" event so the timeline
    // is never empty and the source is visible. It is flagged as bootstrap so
    // it can never out-rank a real tracking event on status derivation.
    await this.appendEvent(organizationId, shipment.id, {
      source: 'manual',
      isBootstrap: true,
      eventCode: 'label_created',
      description: 'Shipment added to ShipCheck. No carrier data received yet.',
      eventAt: new Date(),
      isCustomerVisible: true,
      createdBy: actorUserId,
    });

    await this.audit.record({
      organizationId,
      actorUserId,
      action: 'shipment.created',
      entityType: 'shipment',
      entityId: shipment.id,
      metadata: { trackingNumber: shipment.trackingNumber, carrierCode: shipment.carrierCode },
      requestId: context.requestId ?? null,
    });

    return { shipment, publicToken };
  }

  async update(
    organizationId: string,
    actorUserId: string,
    shipmentId: string,
    patch: Partial<Omit<ShipmentInput, 'trackingNumber' | 'carrierCode'>> & {
      carrierCode?: string;
    },
    context: { requestId?: string | null } = {},
  ) {
    const existing = await this.get(organizationId, shipmentId);

    if (patch.carrierCode && patch.carrierCode !== existing.carrierCode) {
      // Re-keying the carrier must not create a duplicate tracking identity.
      await this.assertDuplicate(organizationId, patch.carrierCode, existing.trackingNumber, shipmentId);
    }

    const updated = await this.db
      .update(shipments)
      .set({
        ...(patch.carrierCode ? { carrierCode: patch.carrierCode } : {}),
        ...(patch.orderReference !== undefined ? { orderReference: patch.orderReference } : {}),
        ...(patch.publicReference !== undefined ? { publicReference: patch.publicReference } : {}),
        ...(patch.customerName !== undefined ? { customerName: patch.customerName } : {}),
        ...(patch.customerEmail !== undefined ? { customerEmail: patch.customerEmail } : {}),
        ...(patch.destinationCountry !== undefined ? { destinationCountry: patch.destinationCountry } : {}),
        ...(patch.shippedAt !== undefined
          ? { shippedAt: patch.shippedAt ? new Date(`${patch.shippedAt}T00:00:00.000Z`) : null }
          : {}),
        ...(patch.estimatedDeliveryAt !== undefined
          ? {
              estimatedDeliveryAt: patch.estimatedDeliveryAt
                ? new Date(`${patch.estimatedDeliveryAt}T00:00:00.000Z`)
                : null,
            }
          : {}),
        ...(patch.internalNotes !== undefined ? { internalNotes: patch.internalNotes } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(shipments.id, shipmentId), eq(shipments.organizationId, organizationId)))
      .returning();

    await this.audit.record({
      organizationId,
      actorUserId,
      action: 'shipment.updated',
      entityType: 'shipment',
      entityId: shipmentId,
      metadata: { fields: Object.keys(patch) },
      requestId: context.requestId ?? null,
    });
    return updated[0]!;
  }

  async setArchived(
    organizationId: string,
    actorUserId: string,
    shipmentId: string,
    archived: boolean,
    context: { requestId?: string | null } = {},
  ) {
    const updated = await this.db
      .update(shipments)
      .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
      .where(and(eq(shipments.id, shipmentId), eq(shipments.organizationId, organizationId)))
      .returning();
    if (!updated[0]) throw notFound('Shipment');

    await this.audit.record({
      organizationId,
      actorUserId,
      action: archived ? 'shipment.archived' : 'shipment.restored',
      entityType: 'shipment',
      entityId: shipmentId,
      metadata: { reason: context.requestId ? undefined : undefined },
      requestId: context.requestId ?? null,
    });
    return updated[0]!;
  }

  async rotatePublicToken(organizationId: string, actorUserId: string, shipmentId: string) {
    const token = randomToken(32);
    const updated = await this.db
      .update(shipments)
      .set({
        publicTokenHash: sha256Hex(token),
        publicTokenRevokedAt: null,
        updatedAt: new Date(),
      })
      .where(and(eq(shipments.id, shipmentId), eq(shipments.organizationId, organizationId)))
      .returning({ id: shipments.id });
    if (!updated[0]) throw notFound('Shipment');

    await this.audit.record({
      organizationId,
      actorUserId,
      action: 'shipment.public_link_rotated',
      entityType: 'shipment',
      entityId: shipmentId,
    });
    return token;
  }

  async revokePublicToken(organizationId: string, actorUserId: string, shipmentId: string) {
    const updated = await this.db
      .update(shipments)
      .set({ publicTokenRevokedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(shipments.id, shipmentId), eq(shipments.organizationId, organizationId)))
      .returning({ id: shipments.id });
    if (!updated[0]) throw notFound('Shipment');
    await this.audit.record({
      organizationId,
      actorUserId,
      action: 'shipment.public_link_revoked',
      entityType: 'shipment',
      entityId: shipmentId,
    });
  }

  async findByPublicToken(token: string) {
    const rows = await this.db
      .select()
      .from(shipments)
      .where(
        and(eq(shipments.publicTokenHash, sha256Hex(token)), isNull(shipments.publicTokenRevokedAt)),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /* ---------------------------------------------------------------------- */
  /* Events                                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * Insert one tracking event and recompute the shipment status.
   * Returns `{ deduplicated: true }` when the event was already recorded.
   */
  async appendEvent(
    organizationId: string,
    shipmentId: string,
    input: {
      source: 'carrier' | 'manual' | 'import';
      providerEventId?: string | null;
      eventCode: string;
      description: string;
      locationText?: string | null;
      eventAt: Date;
      rawPayloadRedacted?: Record<string, unknown> | null;
      isCustomerVisible?: boolean;
      isBootstrap?: boolean;
      createdBy?: string | null;
    },
  ): Promise<{ eventId: string; deduplicated: boolean; statusChanged: boolean }> {
    const normalized = normalizeStatus(input.eventCode);

    if (input.providerEventId) {
      const existing = await this.db
        .select({ id: trackingEvents.id })
        .from(trackingEvents)
        .where(
          and(
            eq(trackingEvents.organizationId, organizationId),
            eq(trackingEvents.providerEventId, input.providerEventId),
          ),
        )
        .limit(1);
      if (existing[0]) {
        return { eventId: existing[0].id, deduplicated: true, statusChanged: false };
      }
    }

    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(trackingEvents)
        .values({
          organizationId,
          shipmentId,
          source: input.source,
          providerEventId: input.providerEventId ?? null,
          eventCode: input.eventCode,
          normalizedStatus: normalized,
          description: input.description,
          locationText: input.locationText ?? null,
          eventAt: input.eventAt,
          rawPayloadRedacted: input.rawPayloadRedacted ?? null,
          isCustomerVisible: input.isCustomerVisible ?? true,
          isBootstrap: input.isBootstrap ?? false,
          createdBy: input.createdBy ?? null,
        })
        .returning({ id: trackingEvents.id });

      const { status, statusChanged } = await this.recomputeStatus(tx, organizationId, shipmentId, normalized);
      return { eventId: inserted[0]!.id, deduplicated: false, statusChanged, status };
    });
  }

  /**
   * Recompute the derived status from the most recent MEANINGFUL event by
   * event time - not by arrival order (C4 step 7).
   */
  private async recomputeStatus(
    tx: Tx,
    organizationId: string,
    shipmentId: string,
    _justAdded: ShipmentStatus,
  ): Promise<{ status: ShipmentStatus; statusChanged: boolean }> {
    const rows = await tx
      .select()
      .from(shipments)
      .where(and(eq(shipments.id, shipmentId), eq(shipments.organizationId, organizationId)))
      .limit(1);
    const shipment = rows[0];
    if (!shipment) throw notFound('Shipment');

    // Order by event time, then by receive time as the tie-breaker.
    // The synthetic bootstrap event is skipped whenever a real tracking event
    // exists, so a backdated carrier event can still move the shipment on.
    const latest = await tx
      .select({
        normalizedStatus: trackingEvents.normalizedStatus,
        eventAt: trackingEvents.eventAt,
        description: trackingEvents.description,
        source: trackingEvents.source,
        isBootstrap: trackingEvents.isBootstrap,
      })
      .from(trackingEvents)
      .where(eq(trackingEvents.shipmentId, shipmentId))
      .orderBy(desc(trackingEvents.eventAt), desc(trackingEvents.receivedAt));

    const realEvents = latest.filter((candidate) => !candidate.isBootstrap);
    const event = realEvents[0] ?? latest[0];
    const derived = (event?.normalizedStatus as ShipmentStatus | undefined) ?? 'label_created';
    const previous = shipment.status as ShipmentStatus;

    // A carrier-sourced event also updates `last_carrier_status`; a manual
    // entry never masquerades as carrier-confirmed data.
    const carrierStatus =
      event?.source === 'carrier'
        ? ((event.normalizedStatus as ShipmentStatus) ?? shipment.lastCarrierStatus)
        : shipment.lastCarrierStatus;

    const deliveredAt =
      derived === 'delivered' ? (shipment.deliveredAt ?? event?.eventAt ?? null) : shipment.deliveredAt;

    await tx
      .update(shipments)
      .set({
        status: derived,
        lastCarrierStatus: carrierStatus,
        lastEventAt: event?.eventAt ?? shipment.lastEventAt,
        lastEventDescription: event?.description ?? shipment.lastEventDescription,
        deliveredAt,
        updatedAt: new Date(),
      })
      .where(eq(shipments.id, shipmentId));

    return { status: derived, statusChanged: derived !== previous };
  }

  async addManualEvent(
    organizationId: string,
    actorUserId: string,
    shipmentId: string,
    input: {
      eventCode: string;
      description: string;
      locationText?: string | null;
      occurredAt: string;
      isCustomerVisible: boolean;
    },
  ) {
    await this.get(organizationId, shipmentId);
    const eventAt = new Date(`${input.occurredAt}T12:00:00.000Z`);
    if (eventAt.getTime() > Date.now() + 86_400_000) {
      throw unprocessable('An event cannot be dated more than a day in the future.');
    }

    const result = await this.appendEvent(organizationId, shipmentId, {
      // Manual entries are always labelled "Manual update" in the UI.
      source: 'manual',
      eventCode: input.eventCode,
      description: input.description,
      locationText: input.locationText ?? null,
      eventAt,
      isCustomerVisible: input.isCustomerVisible,
      createdBy: actorUserId,
    });

    await this.audit.record({
      organizationId,
      actorUserId,
      action: 'shipment.event_added_manually',
      entityType: 'shipment',
      entityId: shipmentId,
      metadata: { eventCode: input.eventCode, statusChanged: result.statusChanged },
    });
    return result;
  }

  /** Set the derived status directly (used by the staleness scanner). */
  async markDerivedStatus(
    organizationId: string,
    shipmentId: string,
    status: ShipmentStatus,
  ): Promise<void> {
    await this.db
      .update(shipments)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(shipments.id, shipmentId), eq(shipments.organizationId, organizationId)));
  }

  async markPolled(organizationId: string, shipmentIds: string[], at: Date): Promise<void> {
    if (shipmentIds.length === 0) return;
    await this.db
      .update(shipments)
      .set({ lastPolledAt: at, updatedAt: at })
      .where(and(eq(shipments.organizationId, organizationId), inArrayIds(shipmentIds)));
  }

  /** Shipments that have not been updated since a cutoff (for stall scanning). */
  async staleSince(organizationId: string, cutoff: Date, limit = 200) {
    return this.db
      .select({
        id: shipments.id,
        trackingNumber: shipments.trackingNumber,
        status: shipments.status,
        lastEventAt: shipments.lastEventAt,
      })
      .from(shipments)
      .where(
        and(
          eq(shipments.organizationId, organizationId),
          isNull(shipments.archivedAt),
          inArrayStatus(['label_created', 'in_transit', 'out_for_delivery', 'exception']),
          or(isNull(shipments.lastEventAt), lte(shipments.lastEventAt, cutoff)),
        ),
      )
      .limit(limit);
  }

  async openExceptionsFor(organizationId: string, shipmentId: string) {
    return this.db
      .select()
      .from(shipmentExceptions)
      .where(
        and(
          eq(shipmentExceptions.organizationId, organizationId),
          eq(shipmentExceptions.shipmentId, shipmentId),
          inArrayExceptionStatus(['open', 'acknowledged']),
        ),
      );
  }

  private async assertDuplicate(
    organizationId: string,
    carrierCode: string,
    trackingNumber: string,
    excludeShipmentId?: string,
  ): Promise<void> {
    const filters = [
      eq(shipments.organizationId, organizationId),
      eq(shipments.carrierCode, carrierCode),
      eq(shipments.trackingNumber, trackingNumber.trim()),
      isNull(shipments.archivedAt),
    ];
    if (excludeShipmentId) filters.push(ne(shipments.id, excludeShipmentId));

    const existing = await this.db
      .select({ id: shipments.id })
      .from(shipments)
      .where(and(...filters))
      .limit(1);
    if (existing[0]) {
      throw conflict(
        `Tracking number ${trackingNumber} already exists for ${carrierName(carrierCode)} in this organization.`,
        { field: 'trackingNumber' },
      );
    }
  }

  async membersByIds(organizationId: string, ids: string[]) {
    if (ids.length === 0) return new Map<string, string>();
    const rows = await this.db
      .select({ id: users.id, displayName: users.displayName })
      .from(users)
      .where(and(inArrayUser(ids)));
    void organizationId;
    return new Map(rows.map((row) => [row.id, row.displayName]));
  }

  async countFor(organizationId: string): Promise<number> {
    const rows = await this.db
      .select({ total: count() })
      .from(shipments)
      .where(eq(shipments.organizationId, organizationId));
    return rows[0]?.total ?? 0;
  }
}

type Tx = Parameters<Parameters<AppDatabase['transaction']>[0]>[0];

function inArrayIds(ids: string[]) {
  return sql`${shipments.id} in ${ids}`;
}
function inArrayStatus(values: string[]) {
  return sql`${shipments.status} in ${values}`;
}
function inArrayExceptionStatus(values: string[]) {
  return sql`${shipmentExceptions.status} in ${values}`;
}
function inArrayUser(ids: string[]) {
  return sql`${users.id} in ${ids}`;
}

export function carrierName(code: string): string {
  return CARRIER_CATALOGUE.find((carrier) => carrier.code === code)?.displayName ?? code;
}

export { todayIso, STALLED_AFTER_HOURS };