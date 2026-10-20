# ShipCheck — Architecture

How the system is put together, where the code lives, and the engineering rules
this codebase exists to enforce.

---

## 1. Shape of the system

Three long-lived processes and one PostgreSQL database.

```
                  browser
                     |
        cookie: shipcheck_session
                     |
   +-----------------v-------------------+
   |  client  (React + Vite, static)     |   :5173 dev, static host in prod
   |  /api/v1/* is same-origin (proxied |
   |  in dev by Vite)                     |
   +-----------------+-------------------+
                     |
   +-----------------v-------------------+
   |  api     (Express, :4000)            |   reads process env vars
   |  routes -> services -> Drizzle       |
   +---------+-------------------+-------+
             |                   |
   +---------v--------+  +-------v-------------------+
   | worker (Node)    |  | database (PostgreSQL 16)  |
   | jobs/queue.ts    |  |  Drizzle schema           |
   | jobs/worker.ts   |  |  drizzle/*.sql migrations |
   +------------------+  +---------------------------+
```

There is no message broker, no cache server, no microservices split and no
event streaming. Background work is a table in the same database and a second
process that reads it.

---

## 2. Technology

| Layer | Choice | Note |
| --- | --- | --- |
| Language | TypeScript 5.7, `strict` | one tsconfig per workspace |
| Runtime | Node.js `>= 20.11` (`engines`) | verified on `v24.20.0` |
| Frontend | React 18 + Vite 6 + React Router 6 + TanStack Query 5 + Tailwind CSS 4 (`@tailwindcss/vite`) | tokens in `client/src/styles/tokens.css` |
| API | Express 4 | routers under `server/src/http/routes/` |
| Validation | Zod 3 | schemas in `shared/`, re-run on the server |
| ORM | Drizzle ORM 0.45 | one schema, real SQL migrations |
| Database | PostgreSQL via `pg`; PGlite embedded for development, tests and CI | one schema, one migration set |
| Auth | Argon2id (`@node-rs/argon2`) + database-backed opaque sessions | no hand-rolled KDF or token signing |
| Jobs | `background_jobs` table + a worker process | `FOR UPDATE SKIP LOCKED` leases |
| Email | Nodemailer (SMTP), plus `disabled` and `log` adapters | contract in `server/src/integrations/email/types.ts` |
| Logging | Pino, JSON, ISO timestamps | redaction in `server/src/logger.ts` |
| Tests | Vitest (unit + integration), Supertest (HTTP), Playwright (configured, **no specs**) | |
| CI | GitHub Actions: `npm ci`, `npm run verify`, `db:migrate`, `db:seed` | `.github/workflows/ci.yml` |

npm workspaces: `shared`, `server`, `client`. `@shipcheck/shared` is compiled
first; both the API and the web client import from it.

`pdfkit`, `@types/pdfkit`, `@testing-library/*` and `jsdom` are declared
dependencies with no importing code. They are listed so nobody mistakes them
for implemented features.

---

## 3. Module map

Real paths, relative to the repository root.

### 3.1 `shared/src` — compiled once, used twice

| File | Responsibility |
| --- | --- |
| `constants.ts` | Roles, the ShipCheck permission matrix, shipment statuses and labels, `STATUS_PRECEDENCE` + `normalizeStatus`, exception types/severities/statuses, notification event types and log statuses, `CARRIER_CATALOGUE`, page-size caps, `IMPORT_MAX_ROWS`/`IMPORT_MAX_BYTES`, `STALLED_AFTER_HOURS` |
| `schemas.ts` | Every Zod request schema, shared by the browser and the API |
| `api.ts` | `Paginated<T>`, `ApiErrorBody`, `SessionUser`, `MembershipSummary`, `AuthSessionResponse`, `ShipmentListItem`, `TrackingEventView`, `ShipmentExceptionView` |
| `csv.ts` | `escapeCsvCell` (formula-injection safe), `toCsv`, `parseCsv` |
| `dates.ts` | `todayIso`, `formatDateInTimeZone`, `addDaysIso`, `daysBetweenIso`, `isValidIsoDate`, `zonedWallClockToUtc`, `minutesSinceMidnightInZone`, `isValidTimeZone` |
| `index.ts` | Re-exports the above |

This package is pure: no database, no Express, no React.

### 3.2 `server/src` — the API and the worker

| File | Responsibility |
| --- | --- |
| `index.ts` | API process entry: config → database → migrations → services → app → listen → graceful shutdown |
| `worker.ts` | Worker process entry: config → database → migrations → services → `startWorker` |
| `app.ts` | Express assembly: Helmet, CORS allow-list, body parsers, request context, `/api/v1` rate limit, router, 404, error handler |
| `config.ts` | Zod-validated environment; fails fast with a readable message; collects startup `warnings` |
| `container.ts` | `createServices()` — one instance per process; also `createEmailAdapter()` |
| `errors.ts` | `AppError` plus typed constructors mapped to the documented envelope |
| `logger.ts` | Pino factory, redaction paths, `SENSITIVE_KEYS`, `redactObject` |

**Database**

| File | Responsibility |
| --- | --- |
| `db/schema.ts` | The whole Drizzle schema: 22 tables, indexes, unique and partial unique constraints, relations |
| `db/client.ts` | `createDatabase()` — `pg` **or** PGlite behind one `DatabaseHandle`; `runMigrations()`; `migrationsFolder()` |
| `db/shared-foundation.ts` | Re-exports the shared `CustomerAddress` type for cross-product schema compatibility |
| `db/migrate-cli.ts` | `npm run db:migrate` |
| `db/seed.ts` | `npm run db:seed`; refuses to run in production |

**HTTP** (`server/src/http/routes/`)

| File | Responsibility |
| --- | --- |
| `index.ts` | Router tree, `notFoundHandler`, `errorHandler` |
| `auth.ts` | Register, login, logout, session, profile, password, organizations, invitations |
| `organization.ts` | Organization, members, invitations, transfer ownership, audit |
| `domain.ts` | `shipmentRouter`, `exceptionRouter`, `importRouter`, `integrationRouter`, `settingsRouter`, `exportRouter` |
| `public.ts` | `GET /public/tracking/:token`, rate limited, explicit projection |
| `health.ts` | `/health/live`, `/health/ready`, `/health/info` |
| `middleware.ts` | `requestContext`, `requireAuth`, `requireAuthenticated`, `requireOrganization`, `requirePermission`, `asyncHandler`, `sessionTokenOf` |
| `validate.ts` | `validate({ body, query, params })` — Zod, with a per-field error map |

**Services** (`server/src/services/`)

| File | Responsibility |
| --- | --- |
| `auth.service.ts` | Users, sessions, password reset, memberships, `DUMMY_HASH` timing parity |
| `organization.service.ts` | Organizations, membership, invitations, settings, template and notification-rule seeding, ownership transfer |
| `shipment.service.ts` | Shipment CRUD, archive, public token, `appendEvent`, `recomputeStatus`, manual events, duplicate detection, `carrierName` |
| `exception.service.ts` | Open/assign/acknowledge/comment/resolve, `reopenIfStillRelevant`, dashboard summary, `openedBetween` |
| `import.service.ts` | Preview, commit, status, downloadable error report, column mapping, row validation |
| `integration.service.ts` | Carrier status views, credential sealing, connection test, `pollCarrier` (refuses), sync-run recording, the `CarrierAdapter` contract |
| `notification.service.ts` | `queueForTransitions` with cooldowns and skip reasons, `deliverNotification`, `history`, `retry` |
| `report.service.ts` | Operations dashboard, delivery report, delay buckets |
| `export.service.ts` | CSV for shipments, events and exceptions |
| `email.service.ts` | Outbox: queue, deliver, outbox, stats |
| `audit.service.ts` | Audit writes with redaction; paginated list; per-entity timeline |

**Integrations, jobs, crypto**

| File | Responsibility |
| --- | --- |
| `integrations/email/types.ts` | The adapter contract: `deliversMessages`, `accepted`/`rejected`, failure codes |
| `integrations/email/smtp.ts` | Nodemailer; classifies `EAUTH`/`ECONNECTION`/`EDNS`/… into failure codes |
| `integrations/email/disabled.ts` | The default; `verifyConfiguration` → not ok, `send` → `not_configured` |
| `integrations/email/log.ts` | Development only; writes `.eml` files to `server/.data/outbox` |
| `integrations/email/templates.ts` | Five default templates, an allow-listed placeholder set, HTML escaping, plain-text derivation |
| `jobs/queue.ts` | `enqueue`, `claimNext`, `markSucceeded`, `markFailed`, `reapStale`, `cancel`, `retry`, `listFailed`, `stats` |
| `jobs/worker.ts` | Poll loop, concurrency, stale-lease reaper, recurring enqueue |
| `jobs/handlers.ts` | `carrier.poll`, `notifications.dispatch`, `exceptions.scan`, `exceptions.auto_close`, `maintenance.cleanup` |
| `lib/crypto.ts` | Argon2id, `randomToken`, `sha256Hex`, `hmacSha256Hex`, `safeEqual`, `sealCredentials`/`openCredentials`, `maskSecret` |
| `lib/util.ts` | `slugify`, `uniqueSlug`, `escapeHtml`, `sanitizeHeaderValue`, date helpers, `chunk` |

### 3.3 `client/src` — the web app

| File | Responsibility |
| --- | --- |
| `main.tsx` | React root, query client |
| `routes.tsx` | Route tree: `/login`, `/register`, `/forgot-password`, `/reset-password`, `/accept-invitation`, `/welcome`, `/dashboard`, `/:organizationId/*`, `/track/:token` |
| `components/AppShell.tsx` | Sidebar, header, organization switcher, profile menu, mobile drawer, skip link |
| `components/ui.tsx` | `Card`, `Button`, `Field`, `Input`, `Badge`, `PageHeader`, `EmptyState`, `ErrorState`, `TableSkeleton`, table primitives |
| `components/patterns.tsx` | `ShipmentStatusBadge`, `MetricCard`, `DataTable`, `CopyButton`, `BarChart`, `ProportionBars`, `ActivityTimeline`, `SeverityBadge`, `ExceptionStatusBadge`, `ExceptionTypeLabel` |
| `components/Modal.tsx`, `components/Toast.tsx` | Focus-managed dialog, transient notifications |
| `lib/api.ts` | `apiFetch`/`apiDownload`, `ApiError`; `credentials: 'include'`; nothing in `localStorage` |
| `lib/session.tsx` | `SessionProvider`, session bootstrap, organization switching, `usePermission` |
| `lib/format.ts` | `formatDate`, `formatDateTime`, `relativeTime`, `todayIso`, `classNames` |
| `pages/*.tsx` | Dashboard, Shipments, ShipmentCreate, ShipmentDetail, Exceptions, ExceptionDetail, Imports, Analytics, Notifications, Carriers, Settings, PublicTracking, auth pages, NotFound |
| `styles/tokens.css` | Design tokens (spacing, colour, radius, focus) |

Eight sidebar destinations: Dashboard, Shipments, Exceptions, CSV import,
Analytics, Notifications, Carriers, Settings.

The client is a static bundle. It never receives a server secret. The only
`VITE_`-prefixed variable in the repository is `VITE_API_PROXY`, read by
`client/vite.config.ts` for the dev-server proxy and never shipped to the
browser.

---

## 4. Data flow

### 4.1 A write request

```
browser
  │  POST /api/v1/<orgId>/shipments/<id>/events/manual   (cookie, JSON)
  ▼
helmet → cors allow-list → body parser → requestContext (request id)
  ▼
/api/v1 rate limiter
  ▼
requireAuth        → cookie or Bearer → SHA-256 → sessions row → principal
requireAuthenticated
  ▼
/:<organizationId>  → requireOrganization
                       UUID format check → 400 before it reaches PostgreSQL
                       organizations.get          → 404 if absent or soft-deleted
                       organizations.requireMembership → 404 if not a member
                       permissions = permissionsForRole(role)
  ▼
validate({ params, body })   Zod; 400 with a field→messages map
  ▼
requirePermission('shipment.event.manual')  → 403 if the role lacks it
  ▼
router → ShipmentService.addManualEvent
  │    get()               tenant-scoped read, 404 if foreign
  │    reject a date more than a day in the future
  │    appendEvent(...)
  │      db.transaction:
  │        INSERT tracking_events
  │        recomputeStatus(tx, …)   ← must use the tx handle, see Rule 2
  ▼
audit.record(...)                              (separate write)
  ▼
enqueue('exceptions.auto_close') if the status is now delivered
  ▼
201 { eventId, deduplicated, statusChanged, status, note }
```

### 4.2 A background job

```
worker starts
  ▼
enqueueRecurring()                    15-minute bucket
  │  maintenance.cleanup:<bucket>
  │  exceptions.scan:<org>:<bucket>          for every non-deleted organization
  │  carrier.poll:<carrier>:<bucket>         only for integrations with
  │                                          status 'configured' AND enabled
  ▼
drainOnce()  × WORKER_CONCURRENCY
  │  JobQueue.claimNext(workerId)   UPDATE … WHERE id = (SELECT … FOR UPDATE
  │                                 SKIP LOCKED LIMIT 1) RETURNING …
  │  resolveHandler(job.jobType)    unknown type → failed, retryable: false
  ▼
handler(services, payload)
  │  carrier.poll             → records a sync run, then throws
  │                             INTEGRATION_UNAVAILABLE → permanent failure
  │  notifications.dispatch   → NotificationService.deliverNotification
  │  exceptions.scan          → opens 'stalled' exceptions (if enabled)
  │  exceptions.auto_close    → resolves delivery exceptions
  │  maintenance.cleanup      → deletes expired/revoked sessions and
  │                             expired password-reset tokens
  ▼
markSucceeded | markFailed({ retryable }, backoff + jitter | dead letter)
```

### 4.3 A background claim

```sql
UPDATE background_jobs
   SET status = 'running',
       locked_at = now(),
       locked_by = $worker,
       attempts = attempts + 1
 WHERE id = (SELECT id FROM background_jobs
              WHERE status = 'queued' AND run_after <= now()
              ORDER BY run_after ASC, created_at ASC
              FOR UPDATE SKIP LOCKED
              LIMIT 1)
RETURNING …
```

The claim and the status change happen in one transaction. `SKIP LOCKED` means
several workers can drain the same queue without handing the same job to two of
them.

---

## 5. Database drivers

Two drivers, one schema, one migration set.

| Driver | Selected when | Used for |
| --- | --- | --- |
| `pg` (node-postgres) + `drizzle-orm/node-postgres` | `DATABASE_URL` is set | Managed PostgreSQL, production |
| `@electric-sql/pglite` + `drizzle-orm/pglite` | `DATABASE_URL` is empty | Local development, tests, CI |

PGlite is an embedded, file-backed **PostgreSQL 16** build running as WebAssembly
in the same process. It executes real PostgreSQL SQL, so migrations, foreign
keys, unique indexes, transactions, `jsonb` and `FOR UPDATE SKIP LOCKED` all
behave identically. This is why `server/tests/**` can assert transactional event
insertion and tenant isolation without a server.

`AppDatabase` is typed as the node-postgres handle because both drivers expose
the same `PgDatabase` query surface; `createDatabase` narrows the PGlite instance
to it in exactly one documented place.

PGlite specifics:

- Data directory: `PGLITE_DATA_DIR`, resolved relative to `process.cwd()`,
  which for npm workspace scripts is `server/` — so the default is
  `server/.data/pgdata`.
- No `dataDir` at all gives a fully ephemeral instance; that is what the test
  harness uses (`createDatabase({ memory: true })`).
- **One writer.** The API and the worker cannot both open the same PGlite
  directory. `config.ts` emits a startup warning saying exactly that whenever
  `DATABASE_URL` is missing.
- TLS is enabled for node-postgres unless the host is localhost/127.0.0.1/[::1]
  or the URL contains `sslmode=disable`.
- The connection string is redacted to `postgres://host:port/database` before it
  reaches the log.

Migration files and journal:

| File | Contents |
| --- | --- |
| `server/drizzle/0000_yellow_aqueduct.sql` | The whole initial schema — 22 `CREATE TABLE` statements plus indexes and constraints |
| `server/drizzle/0001_mighty_doorman.sql` | `ALTER TABLE tracking_events ADD COLUMN is_bootstrap boolean DEFAULT false NOT NULL` |
| `server/drizzle/meta/_journal.json` | The migration journal consumed by Drizzle's migrator |

They are the **only** schema definition. `drizzle.config.ts` uses
`dialect: 'postgresql'`; `drizzle-kit generate` only writes SQL and needs no
live database. The application applies migrations itself through
`runMigrations()` so the identical code path serves both drivers.

Schema summary (22 tables): `organizations`, `users`, `memberships`,
`sessions`, `invitations`, `password_reset_tokens`, `organization_settings`,
`carriers`, `shipments`, `tracking_events`, `shipment_exceptions`,
`exception_comments`, `notification_rules`, `notification_logs`,
`carrier_integrations`, `integration_sync_runs`, `imports`,
`import_row_errors`, `email_templates`, `email_messages`, `audit_events`,
`background_jobs`.

UUID primary keys throughout; `timestamptz` for instants. Every tenant-owned
table has a non-null `organization_id` with an index.

The `carriers` table is **never read or written by any code** — the carrier
catalogue the product uses is the `CARRIER_CATALOGUE` constant in
`shared/src/constants.ts`. It exists so that a future adapter has a place to
record adapter type and a verified tracking-URL template.

---

## 6. Two rules learned from real defects in this build

### Rule 1 — A synthetic record must never out-rank real data

**The defect.** Every shipment was created with an explicit
"added to ShipCheck" tracking event so the timeline was never empty and the
source was always visible. That event was stamped `now()`. Real carrier events
are **backdated** — a parcel that moved three days ago reports an `event_at`
three days ago. Because the derivation read "newest event by `event_at`", the
creation record was permanently the newest row and **every shipment was pinned
to `label_created` forever**, no matter how many carrier events arrived.

`domain.test.ts` carries the regression test: insert a `carrier` event dated
`2020-06-01` on a shipment created today, and assert the status is
`in_transit` and `lastEventAt` is `2020-06-01`.

**The rule.** A record that ShipCheck invented is bookkeeping, not a tracking
report, and it must be **structurally excluded** from any derivation that real
data feeds. The flag is `tracking_events.is_bootstrap`, set only on the creation
event, and `recomputeStatus` filters on it:

```
const realEvents = latest.filter((c) => !c.isBootstrap);
const event      = realEvents[0] ?? latest[0];
```

The bootstrap event is still stored, still visible on the timeline and still
labelled *"Shipment added to ShipCheck. No carrier data received yet."* — it is
simply never allowed to decide anything.

**Where it is now enforced.** `server/src/db/schema.ts` documents the column and
its reason inline; `ShipmentService.create` sets it; `ShipmentService.recomputeStatus`
filters on it; `domain.test.ts` asserts both halves (the backdated event wins,
and the creation record is still on the timeline).

### Rule 2 — Never issue a query on the outer database handle from inside a `db.transaction()` callback

**The defect, inherited from the sibling product and repeated here on
purpose.** Inside `appendEvent`, the insert and the status recomputation run
inside `this.db.transaction(async (tx) => …)`. If `recomputeStatus` reached for
`this.db` instead of the `tx` handle it was given, the nested query would run
outside the open transaction: on `pg` on a different pooled connection (so a
rollback would leave an event row with a status that was never written), and on
PGlite on the single connection that the transaction already holds — which
deadlocks until the request times out.

**The rule.** Inside a transaction callback, **every** query must go through the
`tx` handle the callback receives, including reads and writes made by helper
methods. Passing `tx` down is mandatory.

**Where it is now enforced.** `recomputeStatus` takes `tx` as its first
parameter and uses it for every statement (`SELECT` on `shipments`, `SELECT` on
`tracking_events`, `UPDATE shipments`). The type alias sits at the bottom of
`shipment.service.ts`:

```ts
type Tx = Parameters<Parameters<AppDatabase['transaction']>[0]>[0];
```

---

## 7. Tenancy enforcement

Enforced in five layers, in this order:

1. **Routing.** Every tenant route is mounted under `/:organizationId/...`
   behind `requireOrganization` (`server/src/http/routes/index.ts`).
2. **Membership.** `requireOrganization` first rejects a non-UUID id with a
   `400` — before it can reach the driver and surface as an opaque `500` — then
   calls `organizations.get()` and `organizations.requireMembership()`. A
   missing membership, a non-`active` membership, a soft-deleted organization
   and a non-existent organization all raise the identical `404 NOT_FOUND`. The
   API cannot be used to enumerate other tenants' identifiers.
3. **Permissions.** `requirePermission(permission)` compares against
   `permissionsForRole(role)` from `shared/src/constants.ts`. A role that lacks
   the permission gets `403 FORBIDDEN` with the missing permission named.
4. **Query scoping.** Every service method takes `organizationId` first and puts
   `eq(table.organizationId, organizationId)` in the `WHERE` clause. There is no
   "find by id" that omits the tenant predicate.
5. **Tests.** `server/tests/api.test.ts` asserts that another tenant's shipment
   is not returned as `200` and that one tenant's list never contains another's
   tracking numbers.

The `organizationId` in the URL is treated as an untrusted hint, never as
authority. Switching organization also requires membership —
`POST /auth/organizations/:organizationId/switch` re-checks before moving the
session pointer.

**One documented exception.** `ExceptionService.assign` validates that the
assignee exists in `users` but does not verify membership of the organization.
No tenant data leaks, but the reference crosses a boundary. Recorded in
[PRODUCT_SPEC.md §4.6](PRODUCT_SPEC.md).

---

## 8. Background job model

| Property | Implementation |
| --- | --- |
| Storage | `background_jobs`: `status`, `attempts`, `max_attempts` (5), `run_after`, `locked_at`, `locked_by`, `completed_at`, `last_error_code`, `last_error_message`, `idempotency_key` |
| Claim | `FOR UPDATE SKIP LOCKED` inside a transaction — see §4.3 |
| Concurrency | `WORKER_CONCURRENCY` (default 3) claims per drain pass |
| Poll | `WORKER_POLL_INTERVAL_MS` (default 2000 ms) when the queue was empty |
| Lease recovery | `reapStale(300_000)` every 60 s returns `running` rows with an expired lease to `queued` |
| Retry | `markFailed(retryable: true)` sets `run_after = now + backoff + jitter`, status back to `queued` |
| Backoff | `min(5000 × 2^(attempts−1), 15 min)` plus `random(0, min(backoff, 30 s))` |
| Exhaustion | `attempts >= max_attempts`, or a non-retryable error → `failed` with the error code and a 500-character message, **left visible** |
| Manual retry | `JobQueue.retry(jobId)` resets `attempts` and `run_after`; `listFailed()` and `stats()` surface the dead letters — **no route exposes them** |
| Idempotency | Partial unique index on `idempotency_key`; `enqueue` returns `{ deduplicated: true }` and the existing id |
| Recurring | Every 15 minutes with a bucket-stamped key, so a restart never duplicates: `maintenance.cleanup:<bucket>`, `exceptions.scan:<org>:<bucket>`, `carrier.poll:<carrier>:<bucket>` |
| Job-specific keys | `auto-close:<shipmentId>:<eventId>`, `dispatch:<notificationLogId>` |

### 8.1 Registered handlers versus the declared constant

`BACKGROUND_JOB_TYPES` in `shared/src/constants.ts` lists
`carrier.poll`, `notifications.dispatch`, `exceptions.scan`,
`maintenance.cleanup`. The handler registry in `jobs/handlers.ts` registers those
four **plus `exceptions.auto_close`**. The constant is therefore incomplete. It
is not imported anywhere, so nothing breaks — but it is wrong, and it is listed
in [IMPLEMENTATION_STATUS.md §5](IMPLEMENTATION_STATUS.md).

### 8.2 Handlers report retryability explicitly

`JobOutcome = { retryable, code, message }`.

- `carrier.poll` treats the missing adapter as **permanent**:
  `"No carrier adapter is implemented. No shipment was marked delayed."`
  Retrying an unimplemented adapter only produces noise.
- `exceptions.scan` is a no-op when `autoOpenExceptions` is false.
- An unknown job type fails immediately with `retryable: false` and
  `lastErrorCode: 'unknown_job_type'`.

---

## 9. Security boundaries

| Boundary | Mechanism |
| --- | --- |
| Browser ↔ API | HTTPS (deployment assumption), HTTP-only `SameSite=Lax` session cookie, Helmet headers, `default-src 'none'` CSP, `frame-ancestors 'none'`, `no-referrer`, CORS allow-list of `APP_URL` + `APP_URLS` with credentials |
| Tenant ↔ tenant | §7 |
| API ↔ database | `DATABASE_URL` only; parameterised Drizzle queries; the URL is redacted in logs |
| Server ↔ network | The server makes outbound connections **only** to the database and the SMTP relay, both operator-configured. It never fetches a user-supplied URL — see SECURITY.md §5 |
| Server ↔ secrets | Environment variables. `ENCRYPTION_KEY` seals carrier credentials with AES-256-GCM; only masked values ever leave the process |
| Server ↔ logs | Pino redaction paths plus `redactObject` on audit metadata; `redactUrl` on the connection string; `safeMessage` on SMTP errors |
| Public ↔ tenant | The public tracking route is the only unauthenticated data route. It resolves a SHA-256 token hash, honours revocation, rate-limits to 30/min and returns an explicitly constructed projection |
| Carrier ↔ server | **Nothing.** There is no webhook route, no signature verification and no inbound carrier endpoint, because there is no adapter to verify a signature for |

---

## 10. Integration boundaries

ShipCheck ships **three email adapters** behind one contract
(`server/src/integrations/email/types.ts`) and **zero carrier adapters**.

| Provider | State | What a real integration does here |
| --- | --- | --- |
| SMTP | Implemented (`smtp.ts`) | `verifyConfiguration` opens a real connection; `send` hands a message to Nodemailer and records `accepted` with the provider message id |
| `disabled` | Default | `verifyConfiguration` → not ok; `send` → `not_configured`. The UI shows "Not connected" |
| `log` | Development only | Writes `.eml` files to `server/.data/outbox`; `deliversMessages = false`; the API refuses to start with it in production |
| Carrier (any) | **Boundary only** | Storage, AES-256-GCM encryption, masked display, a test action that honestly answers "there is nothing to verify against", and a `refresh` route that returns `503`. No SDK, no polling, no signature verification, no webhook |

The contract deliberately separates three concepts that are easy to conflate:
*configured* (credentials exist), *deliversMessages* (a real provider will try),
and *accepted* (the provider took this specific message). An accepted message is
never reported as delivered.

The carrier half is covered in full in [INTEGRATIONS.md](INTEGRATIONS.md).

---

## 11. Testing strategy

| Layer | Tool | Location | Database |
| --- | --- | --- | --- |
| Domain rules and persistence | Vitest | `server/tests/domain.test.ts` | in-memory PGlite with the real migrations |
| HTTP, tenancy, envelope | Vitest + Supertest | `server/tests/api.test.ts` | in-memory PGlite |
| Harness | — | `server/tests/harness.ts` | sets `NODE_ENV=test`, `EMAIL_PROVIDER=disabled`, `WORKER_ENABLED=false`, `LOG_LEVEL=silent`, cookie name `shipcheck_test` |
| E2E journeys | Playwright | `tests/e2e/` — **the directory is empty** | would be the seeded development database |
| CI | GitHub Actions | `.github/workflows/ci.yml` | PGlite, `DATABASE_URL: ''` |

`vitest.config.ts` sets `fileParallelism: false` and `pool: 'forks'` so several
embedded PostgreSQL instances do not saturate the machine.

`npm run verify` is the local gate: shared build → server type-check → client
type-check → lint → tests → production build.

**No client component test exists.** `@testing-library/react` and `jsdom` are
declared dependencies of the client workspace with no importing file, and
`vitest.config.ts` only includes `server/tests/**` and `shared/src/**/*.test.ts`.

---

## 12. Deliberate non-goals

Not oversights; decisions.

- **No carrier adapter.** Carrier accounts, credentials and API access cannot be
  obtained or exercised from a build machine. See [INTEGRATIONS.md](INTEGRATIONS.md).
- **No money.** `organizations.base_currency` exists because the shared
  organization record has it. ShipCheck stores no amount, price or currency
  conversion and reports no financial figure.
- **No tracking-URL generation.** `carriers.tracking_url_template` is never
  populated and no "track with the carrier" link is ever rendered, because a
  link ShipCheck has not verified would be an unverified claim.
- **No address storage.** ShipCheck records a two-letter destination country and
  nothing more — no street address, no postcode, no recipient name beyond an
  operator-supplied `customerName`.
- **No microservice split, message broker, cache or event streaming.**
- **No generated OpenAPI document**; `docs/API.md` is maintained by hand from
  the routers.