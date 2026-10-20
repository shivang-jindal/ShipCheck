/**
 * ShipCheck audit trail (Part A / A5).
 */

import { and, desc, eq, sql } from 'drizzle-orm';

import type { Paginated } from '@shipcheck/shared';

import type { AppDatabase } from '../db/client.js';
import { auditEvents } from '../db/schema.js';
import { redactObject } from '../logger.js';

export interface AuditInput {
  organizationId: string;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  requestId?: string | null;
  ipAddress?: string | null;
}

export class AuditService {
  constructor(private readonly db: AppDatabase) {}

  async record(input: AuditInput): Promise<void> {
    await this.db.insert(auditEvents).values({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      metadata: input.metadata ? redactObject(input.metadata) : null,
      requestId: input.requestId ?? null,
      ipAddress: input.ipAddress ?? null,
    });
  }

  async list(
    organizationId: string,
    query: { page: number; pageSize: number; entityType?: string; action?: string },
  ): Promise<Paginated<typeof auditEvents.$inferSelect>> {
    const filters = [eq(auditEvents.organizationId, organizationId)];
    if (query.entityType) filters.push(eq(auditEvents.entityType, query.entityType));
    if (query.action) filters.push(eq(auditEvents.action, query.action));
    const where = and(...filters);

    const rows = await this.db
      .select()
      .from(auditEvents)
      .where(where)
      .orderBy(desc(auditEvents.createdAt))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    const countRows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(auditEvents)
      .where(where);
    const total = countRows[0]?.count ?? 0;

    return {
      items: rows,
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    };
  }

  async forEntity(entityType: string, entityId: string, limit = 60) {
    return this.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityType, entityType), eq(auditEvents.entityId, entityId)))
      .orderBy(desc(auditEvents.createdAt))
      .limit(limit);
  }
}