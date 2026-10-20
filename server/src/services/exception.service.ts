/**
 * Delivery exceptions (Part C / C3.5, C4 exception management, C7).
 *
 * Rules:
 *  - At most ONE active exception per (shipment, type).
 *  - Resolution requires a reason and writes an audit record.
 *  - A resolved exception only reopens when a NEW event arrives that still
 *    satisfies the rule, and the reopen is counted and audited (C4 step 7).
 *  - A carrier outage never opens a shipment exception: the scan is driven by
 *    shipment staleness, not by poll failure.
 */

import { and, asc, count, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';

import {
  EXCEPTION_STATUSES,
  EXCEPTION_TYPE_LABELS,
  type ExceptionSeverity,
  type ExceptionType,
  type Paginated,
  type ShipmentExceptionView,
} from '@shipcheck/shared';

import type { AppDatabase } from '../db/client.js';
import { exceptionComments, shipmentExceptions, shipments, users } from '../db/schema.js';
import { notFound, unprocessable } from '../errors.js';
import type { AuditService } from './audit.service.js';

export interface ExceptionInput {
  shipmentId: string;
  type: ExceptionType;
  severity: ExceptionSeverity;
  detail?: string | null;
}

export class ExceptionService {
  constructor(
    private readonly db: AppDatabase,
    private readonly audit: AuditService,
  ) {}

  async list(
    organizationId: string,
    query: {
      page: number;
      pageSize: number;
      status: string;
      type: string;
      severity: string;
      shipmentId?: string;
      assignedToMe?: string;
    },
  ): Promise<Paginated<ShipmentExceptionView>> {
    const filters = [eq(shipmentExceptions.organizationId, organizationId)];
    if (query.status === 'all') {
      filters.push(inArray(shipmentExceptions.status, EXCEPTION_STATUSES));
    } else {
      filters.push(eq(shipmentExceptions.status, query.status));
    }
    if (query.type !== 'all') filters.push(eq(shipmentExceptions.type, query.type));
    if (query.severity !== 'all') filters.push(eq(shipmentExceptions.severity, query.severity));
    if (query.shipmentId) filters.push(eq(shipmentExceptions.shipmentId, query.shipmentId));
    if (query.assignedToMe) filters.push(eq(shipmentExceptions.assignedUserId, query.assignedToMe));

    const where = and(...filters);
    const rows = await this.db
      .select({
        id: shipmentExceptions.id,
        shipmentId: shipmentExceptions.shipmentId,
        type: shipmentExceptions.type,
        severity: shipmentExceptions.severity,
        status: shipmentExceptions.status,
        detail: shipmentExceptions.detail,
        assignedUserId: shipmentExceptions.assignedUserId,
        assignedUserName: users.displayName,
        openedAt: shipmentExceptions.openedAt,
        resolvedAt: shipmentExceptions.resolvedAt,
        resolutionReason: shipmentExceptions.resolutionReason,
        trackingNumber: shipments.trackingNumber,
        customerName: shipments.customerName,
        lastEventAt: shipments.lastEventAt,
      })
      .from(shipmentExceptions)
      .innerJoin(shipments, eq(shipments.id, shipmentExceptions.shipmentId))
      .leftJoin(users, eq(users.id, shipmentExceptions.assignedUserId))
      .where(where)
      .orderBy(asc(shipmentExceptions.severity), desc(shipmentExceptions.openedAt))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    const countRows = await this.db
      .select({ total: count() })
      .from(shipmentExceptions)
      .where(where);
    const total = countRows[0]?.total ?? 0;

    return {
      items: rows.map((row) => ({
        id: row.id,
        shipmentId: row.shipmentId,
        trackingNumber: row.trackingNumber,
        customerName: row.customerName,
        type: row.type as ExceptionType,
        typeLabel: EXCEPTION_TYPE_LABELS[row.type as ExceptionType] ?? row.type,
        severity: row.severity as ExceptionSeverity,
        status: row.status as ShipmentExceptionView['status'],
        detail: row.detail,
        assignedUserId: row.assignedUserId,
        assignedUserName: row.assignedUserName,
        openedAt: row.openedAt.toISOString(),
        resolvedAt: row.resolvedAt?.toISOString() ?? null,
        resolutionReason: row.resolutionReason,
        ageHours: Math.max(
          0,
          Math.round(((row.resolvedAt ?? new Date()).getTime() - row.openedAt.getTime()) / 3_600_000),
        ),
        lastEventAt: row.lastEventAt?.toISOString() ?? null,
      })),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    };
  }

  async get(organizationId: string, exceptionId: string) {
    const rows = await this.db
      .select()
      .from(shipmentExceptions)
      .where(
        and(
          eq(shipmentExceptions.id, exceptionId),
          eq(shipmentExceptions.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound('Exception');
    return rows[0];
  }

  async detail(organizationId: string, exceptionId: string) {
    const exception = await this.get(organizationId, exceptionId);
    const comments = await this.db
      .select({
        id: exceptionComments.id,
        comment: exceptionComments.comment,
        visibility: exceptionComments.visibility,
        createdAt: exceptionComments.createdAt,
        author: users.displayName,
      })
      .from(exceptionComments)
      .leftJoin(users, eq(users.id, exceptionComments.userId))
      .where(eq(exceptionComments.exceptionId, exceptionId))
      .orderBy(asc(exceptionComments.createdAt));
    const timeline = await this.audit.forEntity('exception', exceptionId, 40);

    return {
      exception: {
        ...exception,
        typeLabel: EXCEPTION_TYPE_LABELS[exception.type as ExceptionType] ?? exception.type,
        openedAt: exception.openedAt.toISOString(),
        acknowledgedAt: exception.acknowledgedAt?.toISOString() ?? null,
        resolvedAt: exception.resolvedAt?.toISOString() ?? null,
        lastNotifiedAt: exception.lastNotifiedAt?.toISOString() ?? null,
      },
      comments: comments.map((comment) => ({
        ...comment,
        visibility: comment.visibility as 'internal' | 'customer',
        createdAt: comment.createdAt.toISOString(),
      })),
      timeline,
    };
  }

  /** Create, or update the severity/detail of, the active exception for a shipment. */
  async open(
    organizationId: string,
    input: ExceptionInput & { createdBy?: string | null; lastEventId?: string | null },
  ): Promise<{ id: string; created: boolean }> {
    const shipment = (
      await this.db
        .select({ id: shipments.id })
        .from(shipments)
        .where(
          and(eq(shipments.id, input.shipmentId), eq(shipments.organizationId, organizationId)),
        )
        .limit(1)
    )[0];
    if (!shipment) throw notFound('Shipment');

    const existing = (
      await this.db
        .select()
        .from(shipmentExceptions)
        .where(
          and(
            eq(shipmentExceptions.organizationId, organizationId),
            eq(shipmentExceptions.shipmentId, input.shipmentId),
            eq(shipmentExceptions.type, input.type),
            inArray(shipmentExceptions.status, ['open', 'acknowledged']),
          ),
        )
        .limit(1)
    )[0];

    if (existing) {
      await this.db
        .update(shipmentExceptions)
        .set({
          severity: input.severity,
          detail: input.detail ?? existing.detail,
          lastEventId: input.lastEventId ?? existing.lastEventId,
          updatedAt: new Date(),
        })
        .where(eq(shipmentExceptions.id, existing.id));
      return { id: existing.id, created: false };
    }

    const inserted = await this.db
      .insert(shipmentExceptions)
      .values({
        organizationId,
        shipmentId: input.shipmentId,
        type: input.type,
        severity: input.severity,
        status: 'open',
        detail: input.detail ?? null,
        lastEventId: input.lastEventId ?? null,
      })
      .returning({ id: shipmentExceptions.id });

    await this.audit.record({
      organizationId,
      actorUserId: input.createdBy ?? null,
      action: 'exception.opened',
      entityType: 'exception',
      entityId: inserted[0]!.id,
      metadata: { shipmentId: input.shipmentId, type: input.type, severity: input.severity },
    });
    return { id: inserted[0]!.id, created: true };
  }

  /**
   * Reopen a resolved exception because a NEW event still matches the rule.
   * Only called from the event pipeline, never from a UI action.
   */
  async reopenIfStillRelevant(
    organizationId: string,
    shipmentId: string,
    type: ExceptionType,
    lastEventId: string,
  ): Promise<boolean> {
    const resolved = (
      await this.db
        .select()
        .from(shipmentExceptions)
        .where(
          and(
            eq(shipmentExceptions.organizationId, organizationId),
            eq(shipmentExceptions.shipmentId, shipmentId),
            eq(shipmentExceptions.type, type),
            inArray(shipmentExceptions.status, ['resolved', 'dismissed']),
          ),
        )
        .orderBy(desc(shipmentExceptions.resolvedAt))
        .limit(1)
    )[0];
    if (!resolved) return false;

    await this.db
      .update(shipmentExceptions)
      .set({
        status: 'open',
        resolvedAt: null,
        resolutionReason: null,
        acknowledgedAt: null,
        reopenCount: resolved.reopenCount + 1,
        lastEventId,
        updatedAt: new Date(),
      })
      .where(eq(shipmentExceptions.id, resolved.id));

    await this.audit.record({
      organizationId,
      actorUserId: null,
      action: 'exception.reopened_by_new_event',
      entityType: 'exception',
      entityId: resolved.id,
      metadata: { shipmentId, type, reopenCount: resolved.reopenCount + 1 },
    });
    return true;
  }

  async assign(
    organizationId: string,
    actorUserId: string,
    exceptionId: string,
    assigneeId: string | null,
  ) {
    await this.get(organizationId, exceptionId);

    if (assigneeId) {
      const member = await this.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, assigneeId))
        .limit(1);
      if (!member[0]) throw notFound('Member');
    }

    const updated = await this.db
      .update(shipmentExceptions)
      .set({ assignedUserId: assigneeId, updatedAt: new Date() })
      .where(
        and(
          eq(shipmentExceptions.id, exceptionId),
          eq(shipmentExceptions.organizationId, organizationId),
        ),
      )
      .returning();

    await this.audit.record({
      organizationId,
      actorUserId,
      action: 'exception.assigned',
      entityType: 'exception',
      entityId: exceptionId,
      metadata: { assignedUserId: assigneeId },
    });
    return updated[0]!;
  }

  async comment(
    organizationId: string,
    actorUserId: string,
    exceptionId: string,
    input: { comment: string; visibility: 'internal' | 'customer' },
  ) {
    await this.get(organizationId, exceptionId);
    const inserted = await this.db
      .insert(exceptionComments)
      .values({
        organizationId,
        exceptionId,
        userId: actorUserId,
        comment: input.comment,
        visibility: input.visibility,
      })
      .returning();

    await this.audit.record({
      organizationId,
      actorUserId,
      action: 'exception.commented',
      entityType: 'exception',
      entityId: exceptionId,
      metadata: { visibility: input.visibility },
    });
    return inserted[0]!;
  }

  async resolve(
    organizationId: string,
    actorUserId: string | null,
    exceptionId: string,
    input: { status: 'resolved' | 'dismissed'; reason: string },
  ) {
    const exception = await this.get(organizationId, exceptionId);
    if (exception.status === 'resolved' || exception.status === 'dismissed') {
      throw unprocessable('This exception is already closed.');
    }

    const updated = await this.db
      .update(shipmentExceptions)
      .set({
        status: input.status,
        resolvedAt: new Date(),
        resolutionReason: input.reason,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(shipmentExceptions.id, exceptionId),
          eq(shipmentExceptions.organizationId, organizationId),
        ),
      )
      .returning();

    await this.audit.record({
      organizationId,
      actorUserId,
      action: input.status === 'resolved' ? 'exception.resolved' : 'exception.dismissed',
      entityType: 'exception',
      entityId: exceptionId,
      metadata: { reason: input.reason, previousStatus: exception.status },
    });
    return updated[0]!;
  }

  async acknowledge(organizationId: string, actorUserId: string, exceptionId: string) {
    const exception = await this.get(organizationId, exceptionId);
    if (exception.status !== 'open') {
      throw unprocessable('Only an open exception can be acknowledged.');
    }
    const updated = await this.db
      .update(shipmentExceptions)
      .set({ status: 'acknowledged', acknowledgedAt: new Date(), assignedUserId: actorUserId, updatedAt: new Date() })
      .where(eq(shipmentExceptions.id, exceptionId))
      .returning();
    await this.audit.record({
      organizationId,
      actorUserId,
      action: 'exception.acknowledged',
      entityType: 'exception',
      entityId: exceptionId,
    });
    return updated[0]!;
  }

  /** Counts used by the operations dashboard. */
  async summary(organizationId: string) {
    const rows = await this.db
      .select({
        status: shipmentExceptions.status,
        severity: shipmentExceptions.severity,
        count: sql<number>`count(*)::int`,
      })
      .from(shipmentExceptions)
      .where(eq(shipmentExceptions.organizationId, organizationId))
      .groupBy(shipmentExceptions.status, shipmentExceptions.severity);

    const byStatus: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};
    let oldestOpenHours = 0;

    for (const row of rows) {
      byStatus[row.status] = (byStatus[row.status] ?? 0) + row.count;
      if (row.status === 'open' || row.status === 'acknowledged') {
        bySeverity[row.severity] = (bySeverity[row.severity] ?? 0) + row.count;
      }
    }

    const oldest = (
      await this.db
        .select({ openedAt: shipmentExceptions.openedAt })
        .from(shipmentExceptions)
        .where(
          and(
            eq(shipmentExceptions.organizationId, organizationId),
            inArray(shipmentExceptions.status, ['open', 'acknowledged']),
          ),
        )
        .orderBy(asc(shipmentExceptions.openedAt))
        .limit(1)
    )[0];
    if (oldest) {
      oldestOpenHours = Math.round((Date.now() - oldest.openedAt.getTime()) / 3_600_000);
    }

    return { byStatus, bySeverity, oldestOpenHours };
  }

  /** Exceptions opened between two instants (for the analytics screen). */
  async openedBetween(organizationId: string, from: Date, to: Date) {
    return this.db
      .select({
        type: shipmentExceptions.type,
        severity: shipmentExceptions.severity,
        status: shipmentExceptions.status,
        openedAt: shipmentExceptions.openedAt,
        resolvedAt: shipmentExceptions.resolvedAt,
        carrierCode: shipments.carrierCode,
      })
      .from(shipmentExceptions)
      .innerJoin(shipments, eq(shipments.id, shipmentExceptions.shipmentId))
      .where(
        and(
          eq(shipmentExceptions.organizationId, organizationId),
          gte(shipmentExceptions.openedAt, from),
          lte(shipmentExceptions.openedAt, to),
        ),
      );
  }
}