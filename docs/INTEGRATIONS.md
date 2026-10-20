# ShipCheck — Integrations

Two integration boundaries exist: **email**, which has real adapters, and
**carrier tracking**, which has storage, encryption, status, a test action and a
refresh route but **no provider adapter**. Both report their real state; neither
simulates a connection.

The rule the whole product is built around:

> **Never claim an external action succeeded unless the external service
> confirmed it.**

---

# Part 1 — Email (SMTP)

## 1.1 What email is used for

| Use | Where |
| --- | --- |
| Member invitations | `POST /:orgId/members/invitations` — the accept link is always returned so it can be passed on manually |
| Password reset | `POST /auth/password/forgot` |
| Customer shipment notifications | `NotificationService.queueForTransitions` → `EmailService.queueInvoice` → `notifications.dispatch` job |

**The customer notification pipeline is not currently connected** — see §1.7.
The invitation and password-reset paths are real and work.

With no provider configured **everything else still works**: shipments can be
created, events recorded manually, CSV files imported, exceptions opened and
resolved, reports and exports produced, and public tracking links shared. Email
is additive, never required.

## 1.2 The adapter contract

`server/src/integrations/email/types.ts` separates three states that are easy to
conflate:

| Field | Meaning |
| --- | --- |
| `deliversMessages` | A real provider will actually attempt delivery. `true` for SMTP only. |
| `verifyConfiguration()` | `transporter.verify()` — did the provider accept a **connection**? |
| `send()` → `accepted` | Did the provider accept **this message**? |

| Adapter | `name` | `deliversMessages` | When selected |
| --- | --- | --- | --- |
| Nodemailer SMTP | `smtp` | `true` | `EMAIL_PROVIDER=smtp` |
| Development outbox | `log` | `false` | `EMAIL_PROVIDER=log` — **development only** |
| Disabled | `disabled` | `false` | `EMAIL_PROVIDER=disabled` (the default) |

`EmailSendResult.status` is `accepted` or `rejected` — exactly what is known
about delivery, no more.

## 1.3 Setup

### Step 1 — get SMTP credentials

Any provider with an SMTP interface works: a transactional-email provider
(Resend, Brevo, Mailgun, Postmark, Amazon SES) or your own mail server. The
provider you pick determines the host, port and whether TLS is implicit.

Record: host, port, security mode, username, password, and the sender address
your provider will let you send from. The sender address must be on a domain you
control and that your provider has verified.

### Step 2 — sandbox first

Use the provider's **sandbox or test credentials** before sending anything to a
real customer. SES starts in a sandbox with a sending quota of one message per
second; Resend and Postmark accept any address while a domain is in test mode.
Verify that real mail is deliverable before going live — the sandbox only proves
the credentials work.

### Step 3 — configure the environment

```bash
# macOS / Linux
export EMAIL_PROVIDER=smtp
export SMTP_HOST=smtp.example.com
export SMTP_PORT=587
export SMTP_SECURE=false
export SMTP_USER=apikey
export SMTP_PASSWORD=your-provider-api-key
export FROM_EMAIL=notifications@yourdomain.example
export EMAIL_REPLY_TO=ops@yourdomain.example     # optional
```

```powershell
# Windows PowerShell
$env:EMAIL_PROVIDER   = 'smtp'
$env:SMTP_HOST        = 'smtp.example.com'
$env:SMTP_PORT        = '587'
$env:SMTP_SECURE      = 'false'
$env:SMTP_USER        = 'apikey'
$env:SMTP_PASSWORD    = 'your-provider-api-key'
$env:FROM_EMAIL       = 'notifications@yourdomain.example'
$env:EMAIL_REPLY_TO   = 'ops@yourdomain.example'
```

| Port | `SMTP_SECURE` | When |
| --- | --- | --- |
| `587` | `false` | STARTTLS — the normal choice |
| `465` | `true` | Implicit TLS |
| `25` | `false` | Plain relay; rarely appropriate |

`EMAIL_PROVIDER=smtp` without `SMTP_HOST` and `FROM_EMAIL` is a **startup
failure**, not a silent fallback:

> `EMAIL_PROVIDER=smtp requires SMTP_HOST and FROM_EMAIL. Set
> EMAIL_PROVIDER=disabled to run without email.`

If `SMTP_USER` and `SMTP_PASSWORD` are both empty the transporter connects
unauthenticated, which some relays allow.

The adapter is built from the environment at startup, so **restart the API and
the worker**.

### Step 4 — verify the connection

The live check is `GET /api/v1/health/ready` and
`GET /api/v1/:orgId/settings/notifications`, both of which call
`verifyConfiguration()`:

```json
{ "ok": true, "detail": "SMTP smtp.example.com:587 accepted a connection." }
```

On failure: `ok: false` with `SMTP verification failed: <redacted reason>`. The
result is also visible in the Notifications screen's *Email provider* card.

> **There is no `POST /integrations/email_smtp/test` endpoint in ShipCheck**, and
> no "send a test email" action. `verifyConfiguration()` is exercised through
> the health and settings routes only, and **no automated test has ever
> completed a send against a live relay**. See
> [IMPLEMENTATION_STATUS.md §6](IMPLEMENTATION_STATUS.md).

### Step 5 — confirm in the product

Open **Notifications → Outbox**. Each row shows the status, the provider
message id, the failure code and a redacted failure message. With SMTP the
statuses you will see are `queued`, `sent` and `failed`.

## 1.4 What `sent` means — and what it does not

**`sent` means the SMTP server accepted the message for delivery. That is the
strongest claim plain SMTP supports.**

SMTP returns `250 OK` when it takes responsibility for the message. It does not
tell you whether the message reached a mailbox, whether it was filtered, or
whether it was opened. There is no delivery receipt, no bounce webhook and no
open tracking in this release.

| Term | Written by ShipCheck? | Meaning |
| --- | --- | --- |
| `queued` | yes | Persisted in `email_messages`, not yet handed to a provider |
| `sent` | yes | **The provider accepted the message.** Not delivered, not read |
| `delivered` | **never** | Would require evidence ShipCheck does not have |
| `bounced` | **never** | Would require a bounce callback that does not exist |

Where this is stated in the product, not just in this file:

- `GET /:orgId/settings/notifications` returns a `note` field saying exactly
  this, and the Notifications screen renders it above the outbox table.
- The same screen renders a warning box whenever `deliversMessages` is false:
  *"This provider cannot confirm delivery. ShipCheck records a message as
  **sent** when the provider accepts it and never claims more than that."*
- `scripts/smoke.mjs` asserts the note matches `/never claims/i` and that
  `email.deliversMessages` is `false`.
- `api.test.ts` asserts the same over HTTP.
- Every email template footer says: *"Sent by ShipCheck on behalf of
  {{organizationName}}. ShipCheck reports what the carrier published or what an
  operator recorded; it is not the carrier and cannot guarantee delivery."*

## 1.5 Failure codes and what ShipCheck does with them

Classified in `SmtpEmailAdapter.classify`:

| `failureCode` | Trigger | Retryable | Recorded |
| --- | --- | --- | --- |
| `not_configured` | `EMAIL_PROVIDER=disabled` | **No** — permanent until an operator configures it | `email_messages.failure_code`, safe message |
| `auth_failed` | Nodemailer `EAUTH`, `EENVELOPE` | No | as above |
| `temporary` | `ECONNECTION`, `ETIMEDOUT`, `EDNS`, `ESOCKET` | **Yes** | as above |
| `permanent_recipient` | "invalid recipient" / "does not exist" in the provider message | No | as above |
| `provider_error` | anything else | **Yes** | as above |

`EmailService.deliver` treats `not_configured`, `permanent_recipient` and
`auth_failed` as permanent; everything else returns `retryable: true`, which the
`notifications.dispatch` handler passes to `JobQueue.markFailed`.

- A failure is stored on `email_messages.failure_code` and a redacted
  `safe_failure_message` (≤ 300 characters, secrets stripped by
  `SmtpEmailAdapter.safeMessage`), never a raw provider dump.
- Every message is written to `email_messages` **before** an attempt, so what
  was queued, what the provider accepted and what failed is all visible
  afterwards.
- `NotificationService.deliverNotification` increments `attempts`, sets
  `sent_at` on success, and on failure records `failure_code = 'send_failed'`
  with the adapter's message.

## 1.6 Credential handling

Email credentials are **operator-level**, configured in the process environment.
They are not per-organization and they are not stored in the database.

| | Where the credential lives |
| --- | --- |
| SMTP | Process environment / host secret store only |
| Carrier integration row | `carrier_integrations.encrypted_credentials_json`, AES-256-GCM keyed by `ENCRYPTION_KEY` |

The carrier credential path is the only one that touches the database. It
accepts an arbitrary `{ key: value }` bag so a future adapter can define its own
keys without a schema change, seals it with `sealCredentials`, and returns only
`maskSecret(value)` (`********last4` at most).

`ENCRYPTION_KEY` is required before any credential can be stored. Without it,
`PUT /:orgId/integrations/carriers/:code` returns:

> `422 UNPROCESSABLE` — "ENCRYPTION_KEY is not configured on the server, so
> credentials cannot be stored safely. Set ENCRYPTION_KEY and restart the API."

Rotating `ENCRYPTION_KEY` is a different operation: stored credentials become
unreadable immediately (`openCredentials` throws and `credentials()` returns
`{}` rather than garbage). To rotate safely, re-save each carrier's credentials
after changing the key.

## 1.7 The customer-notification pipeline is not connected

`NotificationService.queueForTransitions` implements the full rule set — status
transitions only, rule enablement, per-shipment cooldown, a unique idempotency
key, a hashed recipient — and it is covered by no test and called by **no**
route, service or job. The consequence in a running system:

- No customer notification is ever queued.
- `notification_logs` stays empty.
- The Notifications outbox stays empty.

This is a defect. It is recorded in
[IMPLEMENTATION_STATUS.md §5](IMPLEMENTATION_STATUS.md) and is the first item of
remaining work. The screen still reports the truth about everything it can see:
which provider is configured, whether it delivers, and the fixed sentence about
what `sent` means.

One further gap even once it is wired: the template context sets
`publicUrl: ''`, so the notification email will render *"No public tracking link
has been published for this shipment."* even when an active link exists.

## 1.8 Templates

Five templates are seeded per organization
(`OrganizationService.seedTemplates` → `DEFAULT_NOTIFICATION_TEMPLATES`), one per
notification event type: `shipment_created`, `in_transit`, `out_for_delivery`,
`delivered`, `exception`.

- Only an allow-listed placeholder set is substituted: `organizationName`,
  `trackingNumber`, `publicReference`, `carrierName`, `statusLabel`,
  `statusMessage`, `locationText`, `occurredAt`, `estimatedDelivery`,
  `publicUrl`, `exceptionTypeLabel`, `nextAction`, plus two block placeholders
  (`{{publicUrlBlock}}`, `{{publicReferenceBlock}}`).
- HTML bodies escape every interpolated value (`escapeHtml`); plain-text
  derivation strips tags and flattens newlines.
- Any `{{placeholder}}` left over is **removed**, not executed.
- The body stored on `email_messages` is the **plain text** derivation.
- There is **no template editing route or UI**. Templates are seeded once and
  never changed.

## 1.9 Disconnect and reconnect

**Disconnect** — set `EMAIL_PROVIDER=disabled` and restart the API and the
worker.

- The adapter becomes `DisabledEmailAdapter`.
- `verifyConfiguration` reports *"No email provider is configured. Email sending
  is disabled."*
- `send` returns `not_configured`, which `EmailService.deliver` treats as
  permanent.
- Invitations still return their accept URL, and the response says
  `emailConfigured: false` rather than pretending.
- Nothing else changes: shipments, events, exceptions, imports, reports, exports
  and public tracking all keep working.

**Reconnect** — restore the environment variables and restart, then check
`GET /api/v1/health/ready`. There is no stored state to migrate; the adapter is
built from the environment at startup.

---

# Part 2 — The carrier boundary

## 2.1 The status, stated plainly

**No carrier adapter ships in this release. ShipCheck does not contact carriers.
Live carrier tracking is not available.**

Every surface that could imply otherwise says so explicitly:

| Surface | What it says |
| --- | --- |
| `GET /:orgId/integrations/carriers` | `implemented: false`, `status: not_configured` for **every** carrier |
| `POST /:orgId/integrations/carriers/:code/test` | `ok: false` — *"ShipCheck has no implemented adapter for this carrier, so there is nothing to verify against."* |
| `POST /:orgId/shipments/:id/refresh` | `503 INTEGRATION_UNAVAILABLE` — *"ShipCheck does not implement a live adapter for `<carrier>`."* |
| `carrier.poll` job | Records a failed sync run with `adapter_not_implemented` and returns a **permanent** outcome: *"No carrier adapter is implemented. No shipment was marked delayed."* |
| The web Carriers screen | Badge **"Not connected"** on every card, plus a banner: *"No carrier adapter ships with ShipCheck. Adding API credentials does not start a data feed…"* |
| The web sidebar footer | *"ShipCheck records the tracking events it actually receives. It does not contact carriers unless an adapter is connected."* |
| The shipment-detail page | "Carrier reported" reads **"No carrier data yet"** and "Last carrier poll" is empty |

The smoke test asserts this:
`integrations.every(item => item.implemented === false && item.status !== 'configured')`.

## 2.2 What exists already

| Piece | State |
| --- | --- |
| Catalogue | `CARRIER_CATALOGUE` — `manual`, `dhl`, `fedex`, `ups`, `usps`, `royalmail`, `dpd`, `gls`. A `carriers` table exists in the schema but is never read or written |
| Storage | `carrier_integrations` row per `(organization_id, carrier_code)`, unique index `carrier_integrations_org_code_idx` |
| Encryption | AES-256-GCM at rest, `ENCRYPTION_KEY`, masked display, refuses to store without a key |
| Setup guide | Four lines per carrier, shown in a `<details>` block in the UI |
| Limitations list | Two lines per carrier, shown in the UI |
| Verification action | Honest: it records `lastErrorCode: 'adapter_not_implemented'` and answers `ok: false` |
| Status persistence | `lastCheckedAt`, `lastSuccessAt`, `lastErrorCode`, `lastErrorMessage`, `pollIntervalMinutes` |
| Sync-run ledger | `integration_sync_runs` — status, fetched/inserted/duplicate counts, error code, safe message |
| Audit | `integration.updated`, `integration.tested`, `integration.disconnected` |
| Poll entry point | `IntegrationService.pollCarrier`, which throws `INTEGRATION_UNAVAILABLE` |
| The contract | `CarrierAdapter` in `integration.service.ts`, documented but unimplemented |
| Insertion point | `ShipmentService.appendEvent` accepts `source: 'carrier'`, `providerEventId` and `rawPayloadRedacted` |
| Dedupe | `appendEvent` returns `{ deduplicated: true }`; partial unique index `tracking_events_provider_identity_idx` |
| Credentials UI | `client/src/pages/Carriers.tsx` posts `{ apiKey, apiSecret, enabled }` |

## 2.3 What is not implemented

- **Any carrier SDK, REST client or GraphQL client.**
- **Any outbound HTTP call to a carrier.** There is no `fetch`, `axios` or
  `got` call to a carrier host anywhere in `server/`.
- **Any inbound webhook route.** `server/src/app.ts` installs a 1 MB JSON
  parser under `/api/v1/webhooks` for signature verification, but no router is
  mounted at that path — it is dead code left from the shared foundation.
- **Webhook signature verification.** No `hmacSha256Hex` / `safeEqual`
  comparison exists in any request path.
- **Polling.** `last_polled_at` is never written. `ShipmentService.markPolled`
  exists and is never called.
- **Event normalisation from a provider payload.** `normalizeStatus` handles a
  normalised code, not a provider's own vocabulary.
- **A tracking-URL generator.** `carriers.tracking_url_template` is never
  populated, so ShipCheck never renders a "track with the carrier" link it has
  not verified.

## 2.4 Why no adapter ships

Carrier API access is a commercial relationship: an account, a negotiated
service level, credentials tied to that account, per-carrier quotas, and
restrictions on what a given account is allowed to look up. **None of that can
be obtained or exercised from a build machine.**

Shipping an adapter that has never exchanged a signature with a real carrier, or
that has never seen a real quota rejection, would mean shipping code whose
"success" path has never been verified — precisely the failure the whole
specification is written to prevent. It would also risk silently marking real
shipments `delivered` from a mocked response.

So the boundary is built completely and labelled truthfully, and the adapter is
left for an operator who has a carrier account. That is a smaller claim than
"integrated".

The specification's own boundary supports this: *"Real-time carrier tracking
requires a supported carrier API or an authorized aggregator account. A tracking
number alone does not guarantee tracking access."*

## 2.5 What building an adapter would require

For whoever picks this up:

1. **Credentials.** A carrier or aggregator account, its API key/secret, and its
   webhook signing secret if it offers callbacks.
2. **An implementation of `CarrierAdapter`** in
   `server/src/services/integration.service.ts`: `carrierCode`, `displayName`,
   `documentedRateLimit`, `testConnection()`, `poll(shipments)`,
   `isRetryable(failureCode)`. Return `CarrierEvent[]` with a stable
   `providerEventId` so dedupe works.
3. **Status vocabulary mapping.** Map the carrier's own codes into the
   `STATUS_PRECEDENCE` list, or extend that list. Codes you cannot map must stay
   `unknown` — never guess.
4. **Insertion.** Feed everything through `ShipmentService.appendEvent` with
   `source: 'carrier'`, the carrier's `eventAt` (not `now()`), and a redacted
   payload. Do **not** write `tracking_events` directly: the transaction that
   also recomputes the derived status lives there.
5. **Poll scheduling.** Enqueue `carrier.poll:<carrierCode>:<bucket>` from
   `enqueueRecurringFor`, which already does so for any integration with
   `status = 'configured'` and `enabled = true`.
6. **Record every run** with `IntegrationService.recordSyncRun`, including
   duplicates, so the ledger is honest about what the carrier returned.
7. **Set `lastPolledAt`** with `ShipmentService.markPolled` after a successful
   poll. A carrier outage must write a failed sync run and **must not** change
   any shipment's status.
8. **Webhook verification, if the carrier offers callbacks.** Read the raw
   body, compute the provider's HMAC with `hmacSha256Hex`, compare with
   `safeEqual` (constant time, already in `server/src/lib/crypto.ts`), reject on
   mismatch **before** any parsing, and enforce a timestamp tolerance against
   replay. Insert into a dedupe-keyed table and only proceed on a fresh insert.
9. **Notification triggers.** Call `NotificationService.queueForTransitions`
   after a status change, and `ExceptionService.reopenIfStillRelevant` when a
   new event still matches an exception's rule. Both exist and are unwired —
   see [IMPLEMENTATION_STATUS.md §7](IMPLEMENTATION_STATUS.md).
10. **Tests.** Quota, timeout, expired-credential and recovery tests against a
    mocked adapter **in tests only**. Production code must use the real
    configured adapter, never a mock.
11. **Documentation.** Replace §2.3 with real setup steps, scopes, quota
    numbers, webhook URLs and sandbox credentials, and change
    `implemented: true` only when a real verification call succeeds.

## 2.6 What ShipCheck will never claim

- That a shipment is carrier-confirmed when it was entered by hand.
- That a shipment is delayed because ShipCheck stopped hearing about it. The
  product says "no tracking event for 72 hours", never "the carrier is late".
- That an estimated delivery date is a commitment. It is the sender's own
  estimate, labelled as such on the shipment page and on the public page.
- That a carrier lookup succeeded. There is no lookup.

---

# Part 3 — The development `log` transport

## 3.1 What it does

`EMAIL_PROVIDER=log` selects `LogEmailAdapter`, which:

- appends each message to `server/.data/outbox/dev_<base36>.eml` as plain text,
- returns `accepted: true` so the surrounding pipeline can be exercised,
- sets `deliversMessages: false` so the UI can say so,
- labels every file `--- ShipCheck development outbox (NOT DELIVERED) ---`,
- reports `providerMessageId` as `dev_<base36 timestamp>`,
- returns a `temporary` failure if the outbox cannot be written,
- and verifies as `ok: true` with the outbox path, so `/health/ready` stays
  green.

Messages still appear in `email_messages` with `status: 'sent'`, exactly as
with SMTP — which is precisely why it must never be used anywhere real.

## 3.2 Why it must never be used in production

**The API refuses to start with it.** `config.ts`:

> `EMAIL_PROVIDER=log is a development-only transport and cannot be used in
> production.`

That is a hard startup failure, not a warning, because the failure mode is
silent and severe:

| Risk | Consequence |
| --- | --- |
| No message ever leaves the machine | Invitation and reset links appear sent and reach nobody |
| `email_messages.status` becomes `sent` | The outbox claims a provider accepted the message |
| The Notifications screen shows a green badge | Easy to read as connected at a glance |
| `.eml` files accumulate in `server/.data/outbox` | Customer names, addresses and shipment data on disk, unencrypted, unbounded |

There is also a startup warning whenever it is used at all:

> `EMAIL_PROVIDER=log: messages are written to the log and the outbox only.
> Nothing is delivered. No delivery is claimed.`

## 3.3 Using it locally

```powershell
$env:EMAIL_PROVIDER = 'log'
npm.cmd run db:migrate
npm.cmd run db:seed
npm.cmd run dev
```

Then read `server/.data/outbox/*.eml`. Invitation and password-reset links
appear there, which makes it the fastest way to exercise the email pipeline
without a provider.

Remember it is for development only, and that the files contain real data if you
seeded from real data.

---

# Reference — environment variables for integrations

| Variable | Purpose | Default |
| --- | --- | --- |
| `EMAIL_PROVIDER` | `disabled` \| `smtp` \| `log` | `disabled` |
| `SMTP_HOST` | Required for `smtp` | – |
| `SMTP_PORT` | SMTP port | `587` if unset |
| `SMTP_SECURE` | Implicit TLS (`true` for port 465) | `false` |
| `SMTP_USER` | Username; unauthenticated when both user and password are empty | – |
| `SMTP_PASSWORD` | Password | – |
| `FROM_EMAIL` | Required for `smtp`; sender of every message | falls back to `ShipCheck <no-reply@shipcheck.local>` |
| `EMAIL_REPLY_TO` | Optional `Reply-To` | – |
| `ENCRYPTION_KEY` | 64 hex characters; AES-256-GCM for stored carrier credentials | – |
| `WORKER_ENABLED` | Run the worker loop | `true` |
| `WORKER_POLL_INTERVAL_MS` | Queue poll interval | `2000` |
| `WORKER_CONCURRENCY` | Claims per drain pass | `3` |

There is **no carrier-specific environment variable** in this release, because
there is no carrier to configure. Carrier credentials are per-organization,
stored through `PUT /:orgId/integrations/carriers/:carrierCode` under the
generically named keys `apiKey` and `apiSecret`.

Generate a key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```