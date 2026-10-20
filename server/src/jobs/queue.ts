/**
 * Database-backed background job queue (Part A / A2 / Phase 4).
 *
 * - `claimNext` uses `FOR UPDATE SKIP LOCKED` so several workers can share one
 *   queue without running the same job twice.
 * - Retries use bounded exponential backoff with jitter.
 * - `idempotencyKey` makes enqueueing safe to repeat.
 * - Exhausted jobs stay visible as `failed` for manual inspection.
 */

import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';

import { backgroundJobs, type BackgroundJob } from '../db/schema.js';
import type { AppDatabase } from '../db/client.js';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface EnqueueInput<T extends Record<string, unknown> = Record<string, unknown>> {
  jobType: string;
  payload: T;
  organizationId?: string | null;
  runAfter?: Date;
  maxAttempts?: number;
  idempotencyKey?: string | null;
}

export class JobQueue {
  constructor(private readonly db: AppDatabase) {}

  async enqueue(input: EnqueueInput): Promise<{ id: string; deduplicated: boolean }> {
    if (input.idempotencyKey) {
      const existing = await this.db
        .select({ id: backgroundJobs.id, status: backgroundJobs.status })
        .from(backgroundJobs)
        .where(eq(backgroundJobs.idempotencyKey, input.idempotencyKey))
        .limit(1);
      const found = existing[0];
      if (found) return { id: found.id, deduplicated: true };
    }

    const inserted = await this.db
      .insert(backgroundJobs)
      .values({
        organizationId: input.organizationId ?? null,
        jobType: input.jobType,
        payload: input.payload,
        status: 'queued',
        runAfter: input.runAfter ?? new Date(),
        maxAttempts: input.maxAttempts ?? 5,
        idempotencyKey: input.idempotencyKey ?? null,
      })
      .returning({ id: backgroundJobs.id });

    return { id: inserted[0]!.id, deduplicated: false };
  }

  /**
   * Atomically claim one due job. Returns `null` when the queue is empty.
   * The claim and the status update happen in a single transaction so a crashed
   * worker's lease can never hand the same job to two workers.
   */
  async claimNext(workerId: string): Promise<BackgroundJob | null> {
    return this.db.transaction(async (tx) => {
      const claimed = await tx.execute<{
        id: string;
        organization_id: string | null;
        job_type: string;
        payload_json: Record<string, unknown>;
        status: string;
        attempts: number;
        max_attempts: number;
        idempotency_key: string | null;
        run_after: Date;
      }>(sql`
        UPDATE background_jobs
           SET status = 'running',
               locked_at = now(),
               locked_by = ${workerId},
               attempts = attempts + 1
         WHERE id = (
           SELECT id FROM background_jobs
            WHERE status = 'queued' AND run_after <= now()
            ORDER BY run_after ASC, created_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 1
         )
        RETURNING id, organization_id, job_type, payload_json, status, attempts,
                  max_attempts, idempotency_key, run_after
      `);

      const row = claimed.rows[0];
      if (!row) return null;

      return {
        id: row.id,
        organizationId: row.organization_id,
        jobType: row.job_type,
        payload: row.payload_json ?? {},
        status: row.status as BackgroundJob['status'],
        attempts: row.attempts,
        maxAttempts: row.max_attempts,
        idempotencyKey: row.idempotency_key,
        runAfter: row.run_after,
        lockedAt: new Date(),
        lockedBy: workerId,
        completedAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        createdAt: row.run_after,
      } satisfies BackgroundJob;
    });
  }

  async markSucceeded(jobId: string): Promise<void> {
    await this.db
      .update(backgroundJobs)
      .set({
        status: 'succeeded',
        completedAt: new Date(),
        lockedAt: null,
        lockedBy: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      })
      .where(eq(backgroundJobs.id, jobId));
  }

  /** Retry with exponential backoff, or mark permanently failed. */
  async markFailed(
    jobId: string,
    error: { code: string; message: string },
    options: { retryable: boolean; baseDelayMs?: number },
  ): Promise<{ status: JobStatus; nextRunAt: Date | null }> {
    const rows = await this.db
      .select()
      .from(backgroundJobs)
      .where(eq(backgroundJobs.id, jobId))
      .limit(1);
    const job = rows[0];
    if (!job) return { status: 'failed', nextRunAt: null };

    const exhausted = job.attempts >= job.maxAttempts;
    if (!options.retryable || exhausted) {
      await this.db
        .update(backgroundJobs)
        .set({
          status: 'failed',
          completedAt: new Date(),
          lockedAt: null,
          lockedBy: null,
          lastErrorCode: error.code,
          lastErrorMessage: error.message.slice(0, 500),
        })
        .where(eq(backgroundJobs.id, jobId));
      return { status: 'failed', nextRunAt: null };
    }

    const base = options.baseDelayMs ?? 5_000;
    const backoff = Math.min(base * 2 ** (job.attempts - 1), 15 * 60_000);
    const jitter = Math.floor(Math.random() * Math.min(backoff, 30_000));
    const nextRunAt = new Date(Date.now() + backoff + jitter);

    await this.db
      .update(backgroundJobs)
      .set({
        status: 'queued',
        runAfter: nextRunAt,
        lockedAt: null,
        lockedBy: null,
        lastErrorCode: error.code,
        lastErrorMessage: error.message.slice(0, 500),
      })
      .where(eq(backgroundJobs.id, jobId));
    return { status: 'queued', nextRunAt };
  }

  /** Release stale leases so a crashed worker's jobs can be retried. */
  async reapStale(leaseMs = 300_000): Promise<number> {
    const result = await this.db
      .update(backgroundJobs)
      .set({ status: 'queued', lockedAt: null, lockedBy: null })
      .where(
        and(
          eq(backgroundJobs.status, 'running'),
          sql`${backgroundJobs.lockedAt} < now() - (${leaseMs} * interval '1 millisecond')`,
        ),
      )
      .returning({ id: backgroundJobs.id });
    return result.length;
  }

  async cancel(jobId: string): Promise<boolean> {
    const result = await this.db
      .update(backgroundJobs)
      .set({ status: 'cancelled', completedAt: new Date(), lockedAt: null, lockedBy: null })
      .where(
        and(
          eq(backgroundJobs.id, jobId),
          or(eq(backgroundJobs.status, 'queued'), eq(backgroundJobs.status, 'running')),
        ),
      )
      .returning({ id: backgroundJobs.id });
    return result.length > 0;
  }

  async stats(organizationId?: string | null) {
    const conditions = organizationId ? eq(backgroundJobs.organizationId, organizationId) : undefined;
    const rows = await this.db
      .select({ status: backgroundJobs.status, count: sql<number>`count(*)::int` })
      .from(backgroundJobs)
      .where(conditions ? and(conditions) : undefined)
      .groupBy(backgroundJobs.status);
    return Object.fromEntries(rows.map((row) => [row.status, row.count])) as Record<string, number>;
  }

  async listFailed(limit = 50) {
    return this.db
      .select()
      .from(backgroundJobs)
      .where(inArray(backgroundJobs.status, ['failed']))
      .orderBy(asc(backgroundJobs.runAfter))
      .limit(limit);
  }

  async retry(jobId: string): Promise<boolean> {
    const result = await this.db
      .update(backgroundJobs)
      .set({ status: 'queued', attempts: 0, runAfter: new Date(), lastErrorCode: null, lastErrorMessage: null })
      .where(eq(backgroundJobs.id, jobId))
      .returning({ id: backgroundJobs.id });
    return result.length > 0;
  }
}