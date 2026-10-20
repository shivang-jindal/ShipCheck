# ShipCheck — Operations

Running the deployed system: jobs, health, logs, backups, deployment, rollback,
monitoring and the incident runbook.

Everything here describes behaviour implemented in `server/src/**`. Where a
procedure has **not** been exercised in this repository's environment, it says
so.

---

## 1. Processes

| Process | Command (production) | Needs a port | Notes |
| --- | --- | --- | --- |
| API | `node server/dist/index.js` | `PORT` (4000) | Applies pending migrations on start |
| Worker | `node server/dist/worker.js` | none | Applies pending migrations on start |
| Web | static files from `client/dist` | 80/443 | Any CDN or static host |

The API can host the worker in-process with `WORKER_IN_API=true`, which is read
directly from `process.env` in `server/src/index.ts`. That is only acceptable
for a **single-instance** deployment: with two instances the embedded worker and
the separate worker would both drain the same queue. `FOR UPDATE SKIP LOCKED`
makes that *safe* (no job runs twice), but it wastes a connection slot and
doubles the API process's memory. Recommended layout: one API instance, one
worker instance, `WORKER_IN_API` unset.

---

## 2. Background jobs

### 2.1 The model

| Property | Value | Source |
| --- | --- | --- |
| Queue | `background_jobs` table | `server/src/db/schema.ts` |
| Claim | `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)` inside one transaction | `server/src/jobs/queue.ts` `claimNext` |
| Concurrency per worker | `WORKER_CONCURRENCY` (default 3) claims per pass | `server/src/jobs/worker.ts` `drainOnce` |
| Idle poll | `WORKER_POLL_INTERVAL_MS` (default 2000 ms) | same |
| Lease | `locked_at` + `locked_by` | `background_jobs` |
| Lease recovery | every 60 s, `running` rows whose `locked_at` is older than 300 s return to `queued` | `reapStale` |
| Max attempts | 5 (`max_attempts`) | `JobQueue.enqueue` default |
| Success | `status='succeeded'`, `completed_at` set, lock cleared | `markSucceeded` |

### 2.2 Job types

| `job_type` | Enqueued by | Idempotency key | Effect |
| --- | --- | --- | --- |
| `exceptions.scan` | worker, every 15-minute bucket, per organization | `exceptions.scan:<orgId>:<bucket>` | Opens or refreshes `stalled` exceptions for shipments with no event inside `stalledAfterHours`, when `autoOpenExceptions` is on |
| `maintenance.cleanup` | worker, every 15-minute bucket | `maintenance.cleanup:<bucket>` | Deletes expired sessions, revoked sessions older than 30 days, and expired password-reset tokens |
| `carrier.poll` | worker, every 15-minute bucket, for integrations with `status='configured'` **and** `enabled` | `carrier.poll:<carrierCode>:<bucket>` | Records a sync run and then fails permanently — no adapter exists |
| `notifications.dispatch` | `NotificationService.queueForTransitions` (currently never called) | `dispatch:<notificationLogId>` | Hands one `email_messages` row to the configured adapter |
| `exceptions.auto_close` | `POST /shipments/:id/events/manual` when the status becomes `delivered` | `auto-close:<shipmentId>:<eventId>` | Resolves delivery exceptions on a delivered shipment |

An unknown job type fails immediately with `retryable: false` and
`lastErrorCode = 'unknown_job_type'`.

`BACKGROUND_JOB_TYPES` in `shared/src/constants.ts` does **not** list
`exceptions.auto_close`. The constant is not imported anywhere; the registry in
`jobs/handlers.ts` is the real list. See
[ARCHITECTURE.md §8.1](ARCHITECTURE.md).

**Recurring jobs are idempotent by bucket.** The key contains
`floor(now / 15 minutes)`, so a worker restart, a second worker or a redeploy
cannot enqueue the same bucket twice — enforced by the partial unique index
`background_jobs_idempotency_idx`.

Because no carrier integration can ever reach `status = 'configured'` with
`enabled = true` through a supported path, `carrier.poll` is **never enqueued**
in practice. `exceptions.auto_close` is the only handler with a live trigger.

### 2.3 Retry and backoff

`markFailed(jobId, { code, message }, { retryable })`:

```
exhausted   = attempts >= max_attempts        (5)
backoff     = min(5000 × 2^(attempts − 1), 15 minutes)
jitter      = random(0, min(backoff, 30 seconds))
nextRunAt   = now + backoff + jitter
```

| Attempt | Nominal wait |
| --- | --- |
| 1 | 5 s |
| 2 | 10 s |
| 3 | 20 s |
| 4 | 40 s |
| 5 | `failed` — dead letter |

If the error is **not** retryable (a permanent configuration problem, an unknown
job type) the job goes straight to `failed` regardless of remaining attempts.
Nothing retries forever.

A dead letter is **visible**: `status='failed'` with `last_error_code` and
`last_error_message` (truncated to 500 characters) retained in the table.
`JobQueue.listFailed()`, `JobQueue.stats()` and `JobQueue.retry(jobId)` exist in
the service layer; **no HTTP route exposes them**, so today the query has to be
run against the database directly:

```sql
SELECT id, job_type, attempts, last_error_code, left(last_error_message, 200) AS message, completed_at
  FROM background_jobs
 WHERE status = 'failed'
 ORDER BY completed_at DESC
 LIMIT 50;
```

Manual retry of one job:

```sql
UPDATE background_jobs
   SET status = 'queued', attempts = 0, run_after = now(),
       last_error_code = NULL, last_error_message = NULL
 WHERE id = '<uuid>';
```

All handlers are idempotent in effect, so a manual retry cannot double-send or
duplicate.

### 2.4 Running a job by hand

```sql
-- enqueue one (the idempotency key makes a repeat a no-op)
INSERT INTO background_jobs (job_type, payload_json, organization_id, status, run_after, idempotency_key)
VALUES ('exceptions.scan', '{"organizationId":"<org-uuid>"}'::jsonb, '<org-uuid>', 'queued', now(),
        'manual:exceptions.scan:<org-uuid>:' || extract(epoch from now())::bigint)
RETURNING id;
```

The worker picks it up within `WORKER_POLL_INTERVAL_MS`.

### 2.5 Health of the queue

```sql
-- depth and age
SELECT status, count(*), min(run_after) AS oldest_run_after
  FROM background_jobs GROUP BY status;

-- currently leased
SELECT locked_by, locked_at, job_type
  FROM background_jobs
 WHERE status = 'running' AND locked_at < now() - interval '5 minutes';
```

An empty `queued` table with a running worker and a non-empty `succeeded` table
is healthy. A growing `queued` table, or a `running` row with an old
`locked_at`, means the worker is gone.

---

## 3. Health checks

| Endpoint | Use | Meaning |
| --- | --- | --- |
| `GET /api/v1/health/live` | Liveness probe | Process is up. Always `200` while the process can answer |
| `GET /api/v1/health/ready` | Readiness probe | `200` only when `select 1` succeeds against the database; `503` otherwise |
| `GET /api/v1/health/info` | Diagnostics | Service name, environment, worker config, email adapter name with `deliversMessages` and its setup hint, and the startup `warnings` array |

None of the three require authentication, and all three are **skipped by the
`/api/v1` rate limiter** (`skip: (req) => req.path.startsWith('/health')`), so
an orchestrator probing every few seconds does not consume the request budget.

`/health/ready` response:

```json
{
  "status": "ready",
  "checks": [
    { "name": "database", "ok": true },
    { "name": "email", "ok": true, "detail": "disabled: No email provider is configured. Email sending is disabled." }
  ],
  "warnings": ["DATABASE_URL is not set: using the embedded PGlite PostgreSQL instance. …"],
  "environment": "production"
}
```

**Email never makes the service unready.** The email check always reports
`ok: true` with a `detail` string, because ShipCheck is fully usable with manual
tracking, CSV import and manual notification entry when email is down. Treat the
email `detail` as an alerting signal, not a gating check.

The `warnings` array surfaces, at request time, the conditions that matter at
deploy time:

| Warning | Meaning |
| --- | --- |
| `DATABASE_URL is not set: using the embedded PGlite PostgreSQL instance…` | **Production is running on the embedded database.** Fix immediately |
| `ENCRYPTION_KEY is not set: integration credentials cannot be stored…` | Carrier credentials cannot be stored |
| `EMAIL_PROVIDER=log: messages are written to the log and the outbox only…` | Development transport in use (cannot happen in production — the API refuses to start) |
| `COOKIE_SECURE should stay enabled in production.` | Session cookie will be sent over HTTP |

> `/health/live` and `/health/info` both report `service: "collectflow-api"`.
> That is a copy-paste leftover from the sibling product. It is cosmetic but it
> will confuse a log aggregator and any uptime check keyed on the service name.
> See [IMPLEMENTATION_STATUS.md §5](IMPLEMENTATION_STATUS.md).

Suggested probe configuration: liveness every 15 s with a 5 s timeout;
readiness every 10 s with a 3 s timeout; restart the container after 3
consecutive readiness failures.

Note that `/health/ready` does **not** check the worker. Monitor the worker by
its own log stream and the queue query in §2.5.

---

## 4. Logs and request ids

### 4.1 Format

Pino, one JSON object per line, ISO-8601 timestamps, process name in `name`
(`api`, `worker`, `seed`, `test`).

```json
{"level":30,"time":"2026-10-19T09:12:03.412Z","name":"api","driver":"pglite","database":"pglite (…\\server\\.data\\pgdata)","msg":"database connected"}
{"level":30,"time":"2026-10-19T09:12:03.640Z","name":"api","port":4000,"env":"development","msg":"ShipCheck API listening on 4000"}
{"level":40,"time":"2026-10-19T09:12:03.641Z","name":"api","warning":"DATABASE_URL is not set: …","msg":"configuration warning"}
{"level":20,"time":"2026-10-19T09:12:33.257Z","name":"api","code":"VALIDATION_ERROR","requestId":"req_jeziug8lmvdo8cmu","path":"/api/v1/4fe5731d-…/shipments/not-a-uuid","msg":"request rejected"}
```

Levels: `fatal`(60) `error`(50) `warn`(40) `info`(30) `debug`(20) `trace`(10)
`silent`. In **development** the level is forced to `debug`; in production
`LOG_LEVEL` applies (default `info`). `LOG_LEVEL=silent` suppresses everything.

> `createLogger`'s default `name` is `'collectflow'`, not `'shipcheck'`. Both
> entry points pass an explicit name (`api`, `worker`, `seed`, `test`), so this
> only affects any other caller.

### 4.2 Request ids

- Generated as `req_<base36><base36>` per request, or taken from an incoming
  `X-Request-Id` header (truncated to 80 characters).
- Present in the error envelope (`error.requestId`), in rejected-request log
  lines, in unhandled-error log lines, and on `audit_events.request_id` for
  audited writes.
- It is the join key between a user's bug report and the server's logs. Ask for
  it, then search for it verbatim.

Successful requests are **not** logged at `info`; only rejections and errors are.
Successful request tracing therefore relies on the audit trail
(`GET /:organizationId/audit` includes `requestId`), not on access logs. If you
need full access logging, put a proxy in front and log there.

### 4.3 Redaction

Pino redacts `req.headers.authorization`, `req.headers.cookie`,
`headers.authorization`, `headers.cookie`, `*.password`, `*.passwordHash`,
`*.token`, `*.apiKey`, `*.secret`, `credentials.*`. Audit metadata is passed
through `redactObject` before storage, which blanks `password`, `passwordhash`,
`token`, `tokenhash`, `secret`, `apikey`, `api_key`, `authorization`, `cookie`,
`credentials`, `encryptedcredentials` and `smtp_password` at any nesting depth
up to 4. Database connection strings are redacted to
`postgres://host:port/database`. SMTP errors are stripped of
`password|pass|secret|token|api_key` assignments and truncated to 200
characters. See SECURITY.md §7.

### 4.4 Log locations

In production, capture stdout/stderr through your platform's log shipper and
rotate on a schedule. **Keep stdout clean**: the only structured output is Pino
JSON, plus a single line on startup failure.

---

## 5. Backups and restore

### 5.1 What must be backed up

Everything. The database is the only stateful component: no object storage, no
third-party state, no filesystem state beyond the embedded development database.
`server/.data/pgdata` matters only in development.

### 5.2 Managed PostgreSQL (production)

Most managed providers offer daily automated backups with point-in-time
recovery. **Treat the provider's retention window as your recovery point
objective** and verify it — retention and pricing change.

| | Recommended |
| --- | --- |
| Frequency | Daily automated snapshot **plus** point-in-time recovery |
| Retention | 7–30 days, matched to how long a lost day of shipment records would hurt |
| Cross-region copy | Yes, if the provider supports it |
| Encryption at rest | Provider default is acceptable |

Verify what the provider actually offers before relying on it.

### 5.3 Self-managed backups

```bash
# Custom-format dump — required for pg_restore
pg_dump --format=custom --no-owner --no-acl \
        --file=shipcheck-$(date -u +%Y%m%dT%H%M%SZ).dump "$DATABASE_URL"

# Plain SQL, for inspection or a different tool
pg_dump --format=plain --no-owner --no-acl \
        --file=shipcheck-$(date -u +%Y%m%dT%H%M%SZ).sql "$DATABASE_URL"
```

```powershell
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
pg_dump --format=custom --no-owner --no-acl --file="shipcheck-$stamp.dump" $env:DATABASE_URL
```

Recommended minimum: `pg_basebackup` (or the provider's equivalent) plus WAL
archiving for a full point-in-time recovery story. A nightly `pg_dump` alone
means up to 24 hours of data loss.

### 5.4 Restore procedure — run it before you need it

An untested backup is not a backup.

**Step 1 — create a scratch database.** Never restore over production first.

```bash
createdb shipcheck_restore_test
```

**Step 2 — restore.**

```bash
pg_restore --dbname=shipcheck_restore_test \
           --no-owner --no-acl --exit-on-error \
           shipcheck-20261019T091500Z.dump
```

```powershell
pg_restore --dbname=shipcheck_restore_test --no-owner --no-acl --exit-on-error "shipcheck-$stamp.dump"
```

`--exit-on-error` is important: without it `pg_restore` reports errors and
carries on, producing a partial restore that looks fine until a query fails.

**Step 3 — verify the schema.**

```sql
SELECT count(*) FROM drizzle.__drizzle_migrations;
SELECT table_name FROM information_schema.tables
 WHERE table_schema = 'public' ORDER BY table_name;
```

Expect 22 business tables plus `drizzle.__drizzle_migrations`. If the migration
count is 0, the dump did not include the migration journal.

**Step 4 — verify the data.**

```sql
SELECT count(*) FROM organizations;
SELECT count(*) FROM shipments;
SELECT count(*) FROM tracking_events;
SELECT status, count(*) FROM shipments GROUP BY status;
SELECT source, count(*) FROM tracking_events GROUP BY source;
SELECT count(*) FROM tracking_events WHERE is_bootstrap;
```

Cross-check the shipment status counts against what the dashboard showed before
the incident. Two invariants must hold:

- Every shipment has **exactly one** `is_bootstrap = true` event.
- No shipment other than `label_created` has a status that disagrees with its
  newest non-bootstrap event.

If either check fails, the dump is incomplete or the transaction that wrote it
was never committed — do not open the application against this database.

**Step 5 — verify the application against the restore.** Start the API with
`DATABASE_URL` pointed at the restored database on an unused port, then run the
smoke test (§8). If it passes, the restore is usable.

**Step 6 — cut over.** Stop the API and the worker, take a fresh dump of the
current production database, restore it over the target if necessary, repoint
`DATABASE_URL`, start the worker, then the API, then the web tier, and re-run
the smoke test.

**Step 7 — record the RTO.** Note how long steps 1–6 took. That is your real
recovery time, and it is the number that matters.

> **Honest status:** the restore procedure above is the standard PostgreSQL
> workflow and is what should be used. It has **not** been executed against a
> managed PostgreSQL instance from this repository — no production database
> exists here. The only database exercised in this environment is the embedded
> PGlite development copy. **Run steps 1–5 against your real backups before
> going live** and write down the elapsed time.

### 5.5 Embedded PGlite

For a local machine, copy the directory:

```powershell
Copy-Item -Recurse "server\.data\pgdata" "server\.data\pgdata-backup"
```

Stop the API and the worker first — PGlite is single-writer. This is a
development convenience, not a backup strategy.

### 5.6 Retention and deletion

No retention policy or purge job is implemented for business data. Shipments,
tracking events, exceptions, comments, notifications, imports, audit events and
email messages are retained indefinitely and are only removed by deleting the
organization's rows. Deleting them is a manual, irreversible database
operation with no application workflow behind it — there is **no
organization-deletion endpoint** in this release.

The `maintenance.cleanup` job deletes expired sessions, sessions revoked more
than 30 days ago, and expired password-reset tokens. Nothing else.

Deletion from third-party backups outside the application's control (managed
provider snapshots, host-level snapshots) cannot be guaranteed and is not
promised.

---

## 6. Deployment

### 6.1 Order: migrate → API → worker → web

```
1. npm ci && npm run build          # on the build host
2. npm run db:migrate               # schema first
3. deploy + restart the API         # verify /health/ready
4. deploy + restart the worker
5. deploy the web bundle            # verify APP_URL, CORS, HTTPS
```

Why this order:

- **Migrate first.** Both the old and the new code must tolerate the new schema.
  Additive migrations are safe; a destructive one needs the expand/contract
  pattern and a second release.
- **API before worker.** The worker must not pick up job types the running API
  cannot serve.
- **Worker before web.** `exceptions.scan` and `maintenance.cleanup` should be
  running before operators start recording shipments.
- **Web last.** The new client must only reach an API that already supports it.

Both the API and the worker also run pending migrations on start
(`runMigrations` in `server/src/index.ts` and `server/src/worker.ts`), so step 2
can be skipped in a single-instance emergency. Run it explicitly anyway — you
want the migration to fail loudly on a controlled host, not inside a restart.

### 6.2 Build

```bash
npm ci
npm run build          # shared -> server (tsc) -> client (tsc --noEmit + vite build)
npm run verify         # optional: full gate (build + type-check + lint + tests)
```

Artifacts: `shared/dist`, `server/dist`, `client/dist`.

### 6.3 Required production environment

```
NODE_ENV=production
PORT=4000
API_URL=https://api.example.com
APP_URL=https://app.example.com
DATABASE_URL=postgresql://…            # required in production
ENCRYPTION_KEY=<64 hex chars>
EMAIL_PROVIDER=smtp
SMTP_HOST=…  SMTP_PORT=587  SMTP_SECURE=false  SMTP_USER=…  SMTP_PASSWORD=…
FROM_EMAIL=notifications@example.com
SESSION_COOKIE_NAME=shipcheck_session
COOKIE_SECURE=true                     # default true when NODE_ENV=production
TRUST_PROXY=true                       # behind a reverse proxy
LOG_LEVEL=info
WORKER_ENABLED=true
```

`COOKIE_SECURE` and `DATABASE_URL` are the two that break the product quietly
if wrong. Verify the `warnings` array in `/health/ready` is empty after
deploying.

> `.env.example` in this repository still carries the **CollectFlow** header and
> `SESSION_COOKIE_NAME=collectflow_session`, which contradicts the `config.ts`
> default of `shipcheck_session`. Its commented-out seed variables also name the
> CollectFlow demo account. The seed's real defaults are
> `demo@shipcheck.test` / `shipcheck-demo-1234`. See
> [IMPLEMENTATION_STATUS.md §5](IMPLEMENTATION_STATUS.md).

### 6.4 TLS and the custom domain

Terminate TLS at the platform or reverse proxy for both the API and the web
bundle. The session cookie's `Secure` flag depends on `COOKIE_SECURE`. Set
`APP_URL` to the final `https://` origin: it is what CORS allows and what
public tracking links and password-reset links are built from.

### 6.5 Rollback

| Situation | Action |
| --- | --- |
| Bad client build | Redeploy the previous `client/dist`. No server change. Safe and instant. |
| Bad API build, schema is backwards compatible | Redeploy the previous `server/dist` and restart the API and the worker. |
| Bad API build, schema is not backwards compatible | **Roll the migration forward with a fix**, not backward. Drizzle migrations are forward-only by design. Restore from backup only as a last resort. |
| Bad worker build | Redeploy the previous worker. In-flight jobs are leased; a restart returns them to `queued` after the 300 s lease expires. |

Never roll the schema backward. There is no `drizzle-kit` "down" migration path,
and hand-written `DROP` statements on a live database destroy tenant data.

Safe order for a code rollback: web → worker → API, the reverse of deployment.

### 6.6 Draining before a restart

Both processes handle `SIGTERM` and `SIGINT`: the API closes the HTTP server
then the database pool, with a hard 10-second exit; the worker stops claiming
and closes the database. Give the platform at least 15 seconds of termination
grace so the graceful path completes rather than the forced exit.

---

## 7. Monitoring

### 7.1 What to alert on

| Signal | Query or source | Alert when |
| --- | --- | --- |
| **Readiness** | `GET /api/v1/health/ready` | Non-200 for > 2 minutes |
| **Database is embedded in production** | `warnings[]` contains `DATABASE_URL is not set` | Always — it is a configuration error, not a trend |
| **`ENCRYPTION_KEY` missing** | `warnings[]` | Always |
| **`EMAIL_PROVIDER=log`** | `warnings[]` | Always |
| **Dead-letter jobs growing** | `SELECT count(*) FROM background_jobs WHERE status='failed'` | > 0 sustained for 15 min |
| **Queue backlog** | `SELECT count(*) FROM background_jobs WHERE status='queued' AND run_after <= now()` | > 100 for > 10 min |
| **Stuck leases** | `status='running' AND locked_at < now() - interval '5 minutes'` | > 0 for > 10 min |
| **Email failures** | `SELECT failure_code, count(*) FROM email_messages WHERE status='failed' AND created_at > now() - interval '1 hour' GROUP BY 1` | Any sustained failure, or `auth_failed` at all (credentials) |
| **Notifications never sent** | `SELECT count(*) FROM notification_logs WHERE status='queued'` | Non-zero for more than an hour — today this is always zero because the pipeline is unwired |
| **Stalled shipments accumulating** | Dashboard `staleShipments`, or `SELECT count(*) FROM shipments WHERE last_event_at < now() - interval '72 hours'` | A sudden rise usually means nobody is recording events, not that carriers are late |
| **5xx rate** | Log lines with `"level":50` | > 1% of requests over 5 min |
| **Validation errors** | Log lines with `"code":"VALIDATION_ERROR"` | Sudden jump — often a bad deploy or a broken client |
| **Database connections** | Provider dashboard | Near `DATABASE_POOL_MAX` sustained |
| **Backups** | Provider dashboard | Backups failing to complete |

### 7.2 Health queries

```sql
-- Everything that matters, one row each
SELECT
  (SELECT count(*) FROM organizations WHERE deleted_at IS NULL)            AS orgs,
  (SELECT count(*) FROM shipments WHERE archived_at IS NULL)               AS active_shipments,
  (SELECT count(*) FROM shipments WHERE status = 'exception')              AS exception_shipments,
  (SELECT count(*) FROM shipment_exceptions
     WHERE status IN ('open','acknowledged'))                             AS open_exceptions,
  (SELECT count(*) FROM background_jobs WHERE status='queued')             AS queued_jobs,
  (SELECT count(*) FROM background_jobs WHERE status='failed')             AS failed_jobs,
  (SELECT count(*) FROM background_jobs WHERE status='running')            AS running_jobs,
  (SELECT count(*) FROM email_messages WHERE status='sent'
     AND created_at > now() - interval '24 hours')                        AS emails_24h,
  (SELECT count(*) FROM tracking_events WHERE created_at > now() - interval '24 hours')
                                                                           AS events_24h;

-- Dead letters, with their reasons
SELECT job_type, last_error_code, count(*), max(completed_at) AS latest
  FROM background_jobs
 WHERE status = 'failed'
 GROUP BY job_type, last_error_code
 ORDER BY latest DESC;
```

### 7.3 Business sanity checks

Worth running weekly, because they catch silent data problems that no error log
records:

```sql
-- A shipment with no bootstrap event: impossible through the API.
SELECT id, tracking_number FROM shipments s
 WHERE NOT EXISTS (SELECT 1 FROM tracking_events e
                    WHERE e.shipment_id = s.id AND e.is_bootstrap);

-- A shipment with more than one bootstrap event: also impossible.
SELECT shipment_id, count(*) FROM tracking_events
 WHERE is_bootstrap GROUP BY 1 HAVING count(*) > 1;

-- Derived status disagreeing with the newest real event.
SELECT s.id, s.tracking_number, s.status, e.normalized_status, e.event_at
  FROM shipments s
  JOIN LATERAL (
    SELECT normalized_status, event_at FROM tracking_events
     WHERE shipment_id = s.id AND NOT is_bootstrap
     ORDER BY event_at DESC, received_at DESC LIMIT 1
  ) e ON true
 WHERE s.status <> e.normalized_status;

-- A shipment whose last_carrier_status is set although no carrier event exists.
-- Must be empty in this release, where no carrier adapter ships.
SELECT id, tracking_number, last_carrier_status FROM shipments
 WHERE last_carrier_status IS NOT NULL;

-- Two active exceptions of the same type on one shipment: the application
-- guards against this but there is no unique index behind it.
SELECT shipment_id, type, count(*) FROM shipment_exceptions
 WHERE status IN ('open','acknowledged')
 GROUP BY 1, 2 HAVING count(*) > 1;

-- Duplicate tracking numbers inside one organization (the unique index makes
-- this impossible; a non-empty result means the index was dropped).
SELECT organization_id, carrier_code, tracking_number, count(*)
  FROM shipments GROUP BY 1, 2, 3 HAVING count(*) > 1;
```

The "derived status disagrees with the newest real event" query is expected to
return rows **only** for shipments whose status was set directly by the
staleness scanner (`exceptions.scan`). The next event insert re-derives it. A
permanent disagreement means the derivation is broken.

---

## 8. Smoke test

Run after every deployment, and before declaring an incident resolved.

```bash
node scripts/smoke.mjs https://api.example.com
```

It signs in with the seeded demo account and walks the primary journey, exiting
non-zero on the first failure. It checks, in order:

1. `GET /health/ready` returns `status: "ready"`.
2. `POST /auth/login` succeeds.
3. The session carries an organization.
4. `GET /:orgId/dashboard` returns `200`.
5. The dashboard's status counts sum to `totals`.
6. The dashboard's carrier breakdown sums to `totals` (guards an ungrouped-column
   regression in the raw SQL).
7. `GET /:orgId/shipments` returns an `items` array and the first row has a
   `derivedStatus`.
8. `GET /:orgId/shipments/:id` returns `200` and **every event declares a source**
   of `carrier`, `manual` or `import`.
9. `GET /:orgId/exceptions?status=all` returns an `items` array.
10. `GET /:orgId/integrations/carriers` reports at least one carrier and **every
    one is `implemented: false` and not `configured`**.
11. `GET /:orgId/settings/notifications` states that ShipCheck never claims
    delivery.
12. `GET /:orgId/reports/delivery` returns `200` and carries `warnings`.
13. A malformed shipment id is rejected with `400`.
14. A malformed workspace id is rejected with `400`.
15. An unknown public token is a `404 NOT_FOUND`.

It requires the seeded demo account. **Do not run it against production** unless
you have deliberately created and will delete that account.

Manual follow-up for a real deployment: create a shipment, copy its public
tracking link and open it in a private window, add a manual event and confirm
the derived status and the public timeline both change, open an exception and
resolve it with a reason, revoke the link and confirm it 404s, and run one CSV
export and confirm the spreadsheet opens it with no formula warnings.

---

## 9. Incident runbook

### 9.1 "The dashboard count does not match what I expect"

1. Confirm the range. `from`/`to` are accepted but **not applied to any metric** —
   the counts always cover every non-archived shipment.
2. Confirm archived shipments are excluded from the counts but still exist.
3. `sum(counts) == totals` is asserted by the smoke test; if it fails, the
   grouping is broken, not the data.
4. `carrierBreakdown` counts must also sum to `totals`. A mismatch means the
   per-shipment exception sub-select changed shape.
5. Run the sanity queries in §7.3. A non-empty "derived status disagrees" result
   means either the scanner set it or the derivation is broken.

### 9.2 "A shipment is stuck in the wrong status"

The status is derived, never set by hand (except by the scanner). Work through:

| Check | What it tells you |
| --- | --- |
| `GET /shipments/:id` → `events` | The timeline. Order by `eventAt`, newest first |
| The newest **non-bootstrap** event's `normalizedStatus` | This is what the status should be |
| `is_bootstrap` on the newest row | If the newest row is the creation event and no real event exists, `label_created` is correct |
| `lastCarrierStatus` | Should be `null` unless a `carrier`-sourced event exists |
| `occurredAt` values | A future-dated manual event (up to a day ahead) can legitimately out-rank today's carrier event |

The exact rule is in [PRODUCT_SPEC.md §3](PRODUCT_SPEC.md).

### 9.3 "Nothing is being emailed"

| Step | Check | Action |
| --- | --- | --- |
| 1 | `GET /api/v1/health/info` | `email.provider` should be `smtp`. If `disabled`, set `EMAIL_PROVIDER=smtp` and the `SMTP_*` variables and restart the API **and** the worker |
| 2 | `GET /api/v1/health/info` → `email.setupHint` | Lists the exact variables required |
| 3 | `GET /api/v1/health/ready` → `checks[email].detail` | A real `transporter.verify()` result |
| 4 | `SELECT status, failure_code, count(*) FROM email_messages WHERE created_at > now() - interval '1 hour' GROUP BY 1, 2;` | Patterns below |
| 5 | `SELECT status, cooldown_minutes, enabled FROM notification_rules;` | All five rules are seeded **disabled**; enable one deliberately |
| 6 | `SELECT count(*) FROM notification_logs;` | **Expected to be zero.** The notification pipeline is not wired in this release — see [INTEGRATIONS.md §1.7](INTEGRATIONS.md) |

Failure patterns:

| `failure_code` | Meaning | Action |
| --- | --- | --- |
| `not_configured` | No adapter | Set `EMAIL_PROVIDER=smtp`, restart |
| `auth_failed` | Credentials rejected | Re-check `SMTP_USER`/`SMTP_PASSWORD` |
| `temporary` | Timeout / DNS / refused | Check host, port, `SMTP_SECURE`, firewall |
| `permanent_recipient` | The address does not exist | Fix the customer's email address; not retried |
| `provider_error` | Anything else | Read `safeFailureMessage`; often a rejected `FROM_EMAIL` |

### 9.4 "Exceptions are not opening on their own"

1. Is the worker running? Worker log shows `shipcheck worker started`.
2. `organization_settings.auto_open_exceptions` must be `true` (the default).
3. `organization_settings.stalled_after_hours` — default **72**. The `exceptions.scan`
   handler reads this setting; the **dashboard's `staleShipments` hard-codes 72
   hours** and will disagree once you change it.
4. `autoOpenExceptions` false returns
   `"Automatic exception scanning is disabled for this organization."` from the
   handler — check the `background_jobs` row's message history.
5. The scan only considers non-archived shipments in
   (`label_created`, `in_transit`, `out_for_delivery`, `exception`) with
   `last_event_at` null or older than the cutoff, capped at 200 per run.

### 9.5 "The CSV import commit fails with a validation error"

`POST /imports/shipments/commit` requires `confirm: true` in the body. Omitting
it returns `400` with *"Confirm the import before committing"*. The web client
does not currently send it — see
[IMPLEMENTATION_STATUS.md §5](IMPLEMENTATION_STATUS.md).

### 9.6 "The public tracking link returns 404"

| Cause | Check |
| --- | --- |
| Malformed | The token must match `^[A-Za-z0-9_-]{32,64}$`; anything else is a `404` with no database lookup |
| Never issued / rotated away | `GET /:orgId/shipments/:id` → `shipment.publicLinkActive` |
| Revoked | `public_token_revoked_at` is set |
| Wrong token | `public_token_hash` is a SHA-256 of the token; the plaintext is returned only at creation and at rotation, so keep the link |

```sql
SELECT tracking_number, public_token_revoked_at, created_at
  FROM shipments WHERE public_token_hash IS NOT NULL;
```

The token cannot be recovered. Rotate to issue a new one.

### 9.7 "The API returns 500 / `/health/ready` is 503"

| Step | Check |
| --- | --- |
| 1 | API log: the `"level":50` line carries the full stack and the `requestId`. Quote it. |
| 2 | Database connectivity from the API host: is the provider reachable? Did it rotate credentials or hit a connection cap? |
| 3 | Connection exhaustion: is `DATABASE_POOL_MAX` × instances below the provider's limit? |
| 4 | Did the database run out of disk, or is a migration half-applied? |
| 5 | Did a deploy change the schema? Compare `drizzle.__drizzle_migrations` with the running build |
| 6 | Rate limiting is not the cause — that returns `429`, not `500` |

Restart the API. With `database.close()` on shutdown and `runMigrations` on
start, a restart is safe.

### 9.8 "Database is on PGlite in production"

1. This is a misconfiguration, not an incident to debug. Create a managed
   PostgreSQL database.
2. Set `DATABASE_URL` in the deployment environment.
3. `npm run db:migrate` against the new database.
4. Restart the API, then the worker.
5. `GET /api/v1/health/ready` — the `DATABASE_URL is not set` warning must be
   gone.
6. If data matters, migrate it with `pg_dump` from the PGlite directory and
   `pg_restore` into the managed database, then re-run the sanity queries in
   §7.3 before opening the application.

### 9.9 "Login is failing for everyone"

1. Is the API up? `GET /api/v1/health/live`.
2. Is the database reachable? `GET /api/v1/health/ready`.
3. Are cookies reaching the browser? Check that the client is served over HTTPS
   and that `APP_URL` matches the browser origin — CORS is an explicit
   allow-list.
4. Is `COOKIE_SECURE=true` while the site is still on plain HTTP in staging? The
   browser will silently drop the cookie.
5. Is `TRUST_PROXY` set when a proxy terminates TLS? It affects client IPs and
   rate limiting.
6. Check for `401` bursts in the logs with a `requestId`.
7. Nothing above? Check whether the global limiter is engaging:
   `/api/v1` allows `RATE_LIMIT_MAX` (300) per minute per IP. **Login is not
   separately rate-limited** (SECURITY.md §6).

### 9.10 Cross-tenant data leakage — suspected

Treat as a security incident, not a bug.

1. **Preserve evidence.** Snapshot the database before any cleanup, and keep the
   API and worker logs.
2. **Contain.** Revoke the affected sessions in `sessions`, rotate
   `ENCRYPTION_KEY` next.
3. **Scope it.** Confirm every affected query filters on `organization_id`.
   `requireOrganization` is the single gate; a route that bypasses it is the
   defect to look for. Cross-tenant access returns `404`, never `403`, by
   design — a `403` would indicate a different bug.
4. **Reproduce.** `server/tests/api.test.ts` and `server/tests/domain.test.ts`
   already assert cross-tenant denial; extend them with the discovered path.
5. **Notify** through the private channel described in SECURITY.md.
6. Do not discuss the incident in a public issue.

### 9.11 Escalation

| Severity | Example | First action |
| --- | --- | --- |
| **Sev 1** | Cross-tenant leakage; database unavailable; shipment status corrupted | Contain first, then diagnose. Preserve logs and a DB snapshot |
| **Sev 2** | API returning 5xx; worker not draining; public tracking links broken for customers | Diagnose, then decide between fixing forward and rolling back |
| **Sev 3** | One organization's imports failing; a stale integration status | Diagnose during working hours; no data risk |
| **Sev 4** | Cosmetic; confusing error text | Queue it |

For Sev 1 and any suspected vulnerability, follow the private reporting channel
in SECURITY.md rather than a public issue.