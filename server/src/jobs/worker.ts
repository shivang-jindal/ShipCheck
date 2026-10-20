/**
 * Background worker (Part A / A2, Phase 4).
 *
 * Runs as its own process. Claims jobs with a database lease so several workers
 * can share the queue, applies bounded exponential backoff to retryable
 * failures, and leaves permanently failed jobs visible for inspection.
 */

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { isNull } from 'drizzle-orm';

import type { Services } from '../container.js';
import { organizations } from '../db/schema.js';
import { enqueueRecurringFor, resolveHandler, type JobOutcome } from './handlers.js';

const RECURRING_INTERVAL_MS = 15 * 60_000;

export interface WorkerHandle {
  stop: () => Promise<void>;
  readonly workerId: string;
}

export async function startWorker(
  services: Services,
  options: { once?: boolean } = {},
): Promise<WorkerHandle> {
  const workerId = `worker-${randomUUID().slice(0, 8)}`;
  let stopping = false;
  services.logger.info({ workerId }, 'shipcheck worker started');

  const reapTimer = setInterval(() => {
    void services.jobs.reapStale().catch((error: unknown) => {
      services.logger.warn({ err: error }, 'could not reap stale job leases');
    });
  }, 60_000);
  reapTimer.unref();

  const recurringTimer = setInterval(() => {
    void enqueueRecurring(services).catch((error: unknown) => {
      services.logger.warn({ err: error }, 'could not enqueue recurring jobs');
    });
  }, RECURRING_INTERVAL_MS);
  recurringTimer.unref();

  await enqueueRecurring(services);

  let processed = 0;
  do {
    processed += await drainOnce(services, workerId);
    if (!processed && !options.once) await sleep(services.config.worker.pollIntervalMs);
  } while (!stopping && !options.once);

  clearInterval(reapTimer);
  clearInterval(recurringTimer);
  if (options.once) services.logger.info({ workerId, processed }, 'worker run finished');

  return {
    workerId,
    stop: async () => {
      stopping = true;
      clearInterval(reapTimer);
      clearInterval(recurringTimer);
      services.logger.info({ workerId, processed }, 'worker stopped');
    },
  };
}

export async function drainOnce(services: Services, workerId: string): Promise<number> {
  let processed = 0;
  const parallel: Array<Promise<boolean>> = [];

  for (let index = 0; index < services.config.worker.concurrency; index += 1) {
    parallel.push(
      (async () => {
        const job = await services.jobs.claimNext(workerId);
        if (!job) return false;

        const handler = resolveHandler(job.jobType);
        if (!handler) {
          await services.jobs.markFailed(
            job.id,
            { code: 'unknown_job_type', message: `No handler for ${job.jobType}` },
            { retryable: false },
          );
          services.logger.error({ jobId: job.id, jobType: job.jobType }, 'unknown job type');
          return true;
        }

        try {
          const outcome: JobOutcome = await handler(services, job.payload ?? {});
          await services.jobs.markSucceeded(job.id);
          services.logger.debug({ jobId: job.id, jobType: job.jobType, message: outcome.message }, 'job completed');
        } catch (error) {
          const code = error instanceof Error ? error.name || 'error' : 'error';
          const message = error instanceof Error ? error.message : String(error);
          services.logger.warn({ jobId: job.id, jobType: job.jobType, code }, 'job failed');
          await services.jobs.markFailed(job.id, { code, message }, { retryable: true });
        }
        return true;
      })(),
    );
  }

  for (const result of await Promise.all(parallel)) if (result) processed += 1;
  return processed;
}

async function enqueueRecurring(services: Services): Promise<void> {
  const bucket = Math.floor(Date.now() / RECURRING_INTERVAL_MS);

  await services.jobs.enqueue({
    jobType: 'maintenance.cleanup',
    payload: {},
    idempotencyKey: `maintenance.cleanup:${bucket}`,
  });

  const orgs = await services.db
    .select({ id: organizations.id })
    .from(organizations)
    .where(isNull(organizations.deletedAt));

  for (const organization of orgs) {
    await enqueueRecurringFor(services, organization.id, bucket);
  }
}