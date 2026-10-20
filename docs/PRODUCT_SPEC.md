# ShipCheck — Product Specification

Business rules, derivations and state transitions. Everything here is enforced
in `server/src/**` and covered by tests in `server/tests/**`; nothing is left to
the browser.

The single rule the whole product is built around:

> **ShipCheck records the tracking events it actually receives. It never
> invents one, and it never calls a carrier.**

---

## 1. Shipment identity

### 1.1 Tracking numbers are not globally unique

A tracking number is unique per **(organization, carrier, tracking number)**
and only while the shipment is not archived.

| Property | Value |
| --- | --- |
| Unique index | `shipments_org_carrier_tracking_idx` on `(organization_id, carrier_code, tracking_number)` |
| Archived rows | Excluded from the uniqueness check by application logic (`isNull(archivedAt)`), **not** by the index |
| Re-keying the carrier | `PATCH /shipments/:id` with a different `carrierCode` re-runs `assertDuplicate`, so a carrier change cannot create a duplicate tracking identity |

The index covers archived rows too. Archiving a shipment therefore does **not**
free its tracking number for reuse inside the organization; re-creating it hits
the database unique constraint, which surfaces as a `500` rather than the `409`
`assertDuplicate` would produce. This is a known limitation, recorded in
[IMPLEMENTATION_STATUS.md §5](IMPLEMENTATION_STATUS.md).

`assertDuplicate` (`server/src/services/shipment.service.ts`) runs **before** the
insert and raises:

> `409 CONFLICT` — "Tracking number `<n>` already exists for `<carrier>` in this
> organization."

### 1.2 Creating a shipment

`POST /shipments` (`shipment.create`) writes, in order:

1. The `shipments` row with `status = 'label_created'`,
   `last_carrier_status = null`, `source = 'manual'`.
2. A synthetic **bootstrap event** (§2.2) so the timeline is never empty and the
   source is visible from the first second.
3. An audit event `shipment.created` carrying the tracking number and carrier.

A 256-bit public-tracking token is generated, returned **once** in the response
as `publicUrl`, and only its SHA-256 hash is stored (§7).

The response also carries a fixed note:

> "The shipment was created with a "created" event. No carrier data has been
> received."

### 1.3 Carrier vocabulary

`carrierCode` is validated against `CARRIER_CATALOGUE` in
`shared/src/constants.ts`:

| Code | Display name |
| --- | --- |
| `manual` | Manual / unknown carrier (the default) |
| `dhl`, `fedex`, `ups`, `usps`, `royalmail`, `dpd`, `gls` | Named carriers |

- A code that is **not** in the catalogue is a `400 VALIDATION_ERROR` with
  *"Choose a carrier from the list, or \"manual\" when it is unknown"*. It is
  never guessed.
- Having a row in the catalogue does **not** mean an integration is connected.
  See [INTEGRATIONS.md](INTEGRATIONS.md).
- The `carriers` database table is declared in the schema but is never read or
  written; the catalogue that the product actually uses is the constant above.

---

## 2. Tracking events

### 2.1 Event time and receive time are different columns

| Column | Meaning |
| --- | --- |
| `event_at` | When the event happened, as reported by whoever supplied it |
| `received_at` | When ShipCheck stored it (`now()` at insert) |

Carrier events arrive out of order. Keeping the two apart is what makes
backdated data usable, and it is why the timeline is ordered by `event_at` and
never by insertion order.

### 2.2 The bootstrap event and why it is flagged

Every shipment gets one synthetic event at creation:

```
source         = 'manual'
is_bootstrap   = true
event_code     = 'label_created'
description    = 'Shipment added to ShipCheck. No carrier data received yet.'
event_at       = <now>
```

It is stamped `now`, but real carrier events are **backdated**. Without the
`is_bootstrap` flag the creation record would be the newest event forever and no
shipment could ever leave `label_created`. The status derivation skips every
bootstrap event as soon as at least one real event exists
(`server/src/services/shipment.service.ts`, `recomputeStatus`):

```
const realEvents = latest.filter((candidate) => !candidate.isBootstrap);
const event      = realEvents[0] ?? latest[0];
```

The bootstrap event remains visible on the timeline. It is bookkeeping, not a
tracking report, and it is labelled as such in its description.

### 2.3 Status normalisation

`normalizeStatus(eventCode)` in `shared/src/constants.ts`:

1. `trim()`, `toLowerCase()`.
2. Replace runs of whitespace and hyphens with `_`.
3. Look the code up in `STATUS_PRECEDENCE`; the first rule that lists it wins.
4. No match → `'unknown'`.

| Status | Codes |
| --- | --- |
| `delivered` | `delivered`, `delivery_confirmed`, `pod` |
| `returned_to_sender` | `returned_to_sender`, `return_to_sender`, `rts` |
| `exception` | `failed_delivery`, `delivery_exception`, `address_issue`, `lost`, `damaged` |
| `out_for_delivery` | `out_for_delivery`, `with_courier` |
| `in_transit` | `in_transit`, `departed`, `arrived`, `processed`, `transferred` |
| `label_created` | `label_created`, `shipment_info_received`, `info_received`, `created` |
| `unknown` | everything else |

The **original** `event_code` is stored verbatim on the event, so an operator
always sees what the source actually said, even when the mapping is `unknown`.
`normalizeStatus('wibble') === 'unknown'`, `normalizeStatus('DELIVERED') ===
'delivered'`, `normalizeStatus('Out For Delivery') === 'out_for_delivery'` —
all asserted in `server/tests/domain.test.ts`.

The list order only matters if two rules ever claim the same code. It does
**not** decide which event wins; that is §3.

### 2.4 Deduplication

`appendEvent` checks `(organization_id, provider_event_id)` before inserting and
returns `{ deduplicated: true }` when the event is already stored. A partial
unique index, `tracking_events_provider_identity_idx`, enforces the same thing
at the database level for every row that carries a provider id.

**Manual events are never deduplicated.** They have no provider identity, so
recording the same manual event twice writes two rows. This is intentional —
a human deciding to re-enter something is not a carrier replaying a webhook —
and it is stated here so nobody treats manual entry as idempotent.

### 2.5 Manual events

`POST /shipments/:shipmentId/events/manual` (`shipment.event.manual`):

| Field | Rule |
| --- | --- |
| `eventCode` | 2–64 characters, `[A-Za-z0-9_ -]` |
| `description` | 2–500 characters, required |
| `locationText` | ≤ 160 characters, optional |
| `occurredAt` | `YYYY-MM-DD`, stored as `T12:00:00.000Z` |
| `isCustomerVisible` | Default `true` |

- `occurredAt` more than one day in the future is `422 UNPROCESSABLE`:
  *"An event cannot be dated more than a day in the future."*
- `source` is always `'manual'`. `last_carrier_status` is **never** written by a
  manual event, so it stays `null` until a genuine carrier adapter exists.
- The response carries a fixed note: *"This event was recorded manually. It is
  not carrier-confirmed data."*
- An audit event `shipment.event_added_manually` records the event code and
  whether the status changed.
- The shipment-detail timeline renders a `manual` / `import` source chip next to
  every non-carrier event.

When the resulting status is `delivered`, the route enqueues an
`exceptions.auto_close` job keyed `auto-close:<shipmentId>:<eventId>`.

---

## 3. The derived shipment status

`recomputeStatus` runs inside the same transaction as every event insert.

### 3.1 The rule

> The shipment status is the normalised status of the **newest real event by
> `event_at`**, with `received_at` as the tie-breaker. Bootstrap events are
> skipped whenever a real event exists.

It is never derived from arrival order. `domain.test.ts` asserts both halves:

- An event dated `2026-02-02` inserted **before** an event dated `2026-02-01`
  leaves the shipment `delivered`.
- A late `in_transit` event dated *before* the existing `out_for_delivery` does
  **not** downgrade the shipment.

### 3.2 The same recompute also writes

| Column | Written as |
| --- | --- |
| `status` | The derived value |
| `last_carrier_status` | The derived value **only when the newest event's `source` is `carrier`**; otherwise the previous value is kept |
| `last_event_at` / `last_event_description` | `event_at` / `description` of that same newest event |
| `delivered_at` | Set to the existing value, or the event's `event_at`, when the derived status is `delivered` |

`delivered_at` is **sticky**: once set it is never cleared, even if a later
event moves the derived status away from `delivered`. That is a deliberate
record of "a delivery was observed at some point" rather than a current status.

`appendEvent` returns `{ eventId, deduplicated, statusChanged, status }`;
`statusChanged` is `derived !== previous`. The manual-event route enqueues the
auto-close job on that value, not on the event itself.

### 3.3 `markDerivedStatus`

The staleness scanner (`exceptions.scan`) sets `status` directly through
`ShipmentService.markDerivedStatus`, bypassing the timeline. This is visible
immediately, but the next event insert re-derives the status from the events
and will overwrite it. The two mechanisms are stated here rather than presented
as one rule.

### 3.4 Statuses

`SHIPMENT_STATUSES`: `label_created`, `in_transit`, `out_for_delivery`,
`delivered`, `exception`, `returned_to_sender`, `unknown`.

There is **no** stored-versus-derived split. `shipments.status` *is* the derived
value; `last_carrier_status` is the separate record of what a carrier source
last reported. Both are surfaced in the API and shown side by side on the
shipment-detail page ("Derived status" and "Carrier reported").

---

## 4. Delivery exceptions

### 4.1 Types, severities and statuses

`EXCEPTION_TYPES`: `stalled`, `delivery_exception`, `failed_delivery`,
`address_issue`, `returned_to_sender`, `missing_carrier_data`.

`EXCEPTION_SEVERITIES`: `low`, `medium`, `high`, `critical`.

`EXCEPTION_STATUSES`: `open`, `acknowledged`, `resolved`, `dismissed`.

### 4.2 One active exception per (shipment, type)

`ExceptionService.open` looks for an existing row with the same
`(organization_id, shipment_id, type)` and status `open` or `acknowledged`. If
one exists it is **updated** (severity, detail, last event) and the route
answers `200`; otherwise a row is inserted and the route answers `201`.

This is application logic, not a database constraint — two concurrent opens for
the same pair can both create. Recorded as a limitation.

### 4.3 Transitions

| From | Action | To | Notes |
| --- | --- | --- | --- |
| — | `POST /exceptions` | `open` | `201` |
| `open` | `POST /exceptions` (same type) | `open` | Severity/detail updated, `200` |
| `open` | `POST /exceptions/:id/acknowledge` | `acknowledged` | Sets `assigned_user_id` to the actor, stamps `acknowledged_at`. `422` if not `open` |
| `open` / `acknowledged` | `POST /exceptions/:id/assign` | unchanged | `assigned_user_id` set or cleared |
| `open` / `acknowledged` | `POST /exceptions/:id/resolve` `{status: 'resolved'\|'dismissed', reason}` | that status | `422` if already closed |
| `resolved` / `dismissed` | `reopenIfStillRelevant` | `open` | **Not called by anything** — see §4.5 |

`resolve` requires a `reason` of 3–500 characters and writes
`exception.resolved` or `exception.dismissed` with the reason and the previous
status.

### 4.4 Automatic closing on delivery

The `exceptions.auto_close` job, enqueued when a manual event moves a shipment
to `delivered`, resolves every open exception of type `failed_delivery`,
`delivery_exception`, `address_issue` or `returned_to_sender` with the reason
*"Automatically closed: the carrier reported delivery."* (with `actorUserId:
null`). It is idempotent in effect: a second run finds nothing open.

### 4.5 Reopening is implemented but not wired

`ExceptionService.reopenIfStillRelevant` clears `resolved_at`,
`resolution_reason` and `acknowledged_at`, increments `reopen_count` and writes
`exception.reopened_by_new_event`. **No route, service or job calls it.** The
specification asks for reopen only under documented rules; the rule is written
but the trigger is not connected. This is listed as remaining work in
[IMPLEMENTATION_STATUS.md §7](IMPLEMENTATION_STATUS.md), not described as
working.

### 4.6 Assignment is not tenant-checked

`ExceptionService.assign` validates that the target id exists in `users`, but it
does **not** verify that the user is a member of the organization. A member with
`exception.resolve` can therefore set `assigned_user_id` to a user id belonging
to a different tenant. No tenant data is exposed — only a display name is later
joined — but the reference crosses a tenant boundary and should be scoped.

---

## 5. Stalled shipments

**A shipment is stale when it has had no meaningful event for 72 hours.**

Two different code paths compute it, and they do not agree once the setting is
changed:

| Path | Rule | Window |
| --- | --- | --- |
| `GET /:orgId/dashboard` → `staleShipments` | Status in (`label_created`, `in_transit`, `out_for_delivery`) **and** `last_event_at` is null or older than the cutoff | **Hard-coded 72 hours** (`report.service.ts`) |
| `exceptions.scan` job | Status in (`label_created`, `in_transit`, `out_for_delivery`, `exception`) and `last_event_at` ≤ cutoff | `organization_settings.stalled_after_hours`, default 72, configurable 1–720 |

`STALLED_AFTER_HOURS = 72` in `shared/src/constants.ts` documents the default
and the dashboard's behaviour.

**"Stalled" never means "the carrier is late."** It means ShipCheck has not
received an event. The dashboard definition says so verbatim:

> "No tracking event for more than 72 hours while the shipment is still moving.
> A carrier outage does NOT create this state; only shipment staleness does."

A carrier outage, a failed poll or a missed job is never converted into a
shipment exception. There is no poll-failure path that could do so, because
there is no poll.

The `exceptions.scan` job only runs when `organization_settings.auto_open_exceptions`
is `true` (the default). When a shipment is still in `label_created`, the detail
it records says: *"No carrier data has been received. ShipCheck does not treat
that as a carrier delay."*

---

## 6. CSV import

Preview-then-commit. Nothing is written until a preview has been produced, and
the preview reports exactly what will and will not be created.

### 6.1 Limits

| Limit | Value | On breach |
| --- | --- | --- |
| File size | 5 MB | `400` — "The file is larger than 5 MB. Split it into smaller uploads." |
| Row count | 5 000 (`IMPORT_MAX_ROWS`) | `400` — names the row count and the limit |

Both are enforced twice: by the Zod schema (`content` max 5 MB) and again
inside `ImportService.preview`.

### 6.2 Column mapping

Ten target columns, defined once in `SHIPMENT_CSV_COLUMNS`:
`tracking_number` (required), `carrier_code`, `order_reference`,
`public_reference`, `customer_name`, `customer_email`, `destination_country`,
`shipped_at`, `estimated_delivery_at`, `internal_notes`.

- An explicit mapping wins.
- Otherwise a header is matched when its lower-cased form, with runs of spaces,
  hyphens and underscores collapsed to `_`, equals the column name. `Tracking
  Number` therefore matches `tracking_number`.
- No synonym guessing: `Client Email` does **not** map to `customer_email` and
  must be mapped by hand. `domain.test.ts` asserts this explicitly.
- If no column maps to `tracking_number` the preview is a `400` that lists the
  headers it did detect.

### 6.3 Row validation

| `errorCode` | Condition |
| --- | --- |
| `missing_tracking_number` | Fewer than 4 characters after trimming |
| `unknown_carrier` | Carrier not in `CARRIER_CATALOGUE` (blank defaults to `manual`) |
| `invalid_email` | `customer_email` present but not `local@domain.tld` |
| `invalid_country` | `destination_country` is not exactly two letters |
| `invalid_date` | `shipped_at` / `estimated_delivery_at` not `YYYY-MM-DD` |

Error rows are reported with `rowNumber = index + 2`, i.e. the real line number
in the file including the header. Nothing is skipped silently.

### 6.4 Preview response

```jsonc
{
  "importId": "…",
  "filenameSafe": "shipments.csv",       // sanitised: [^\w.\- ]+ -> _
  "headers": ["Tracking Number", "…"],
  "suggestedMapping": { "tracking_number": "Tracking Number", "…": "…" },
  "totalRows": 3,
  "validRows": 1,
  "invalidRows": 2,
  "errors": [ { "rowNumber": 3, "errorCode": "missing_tracking_number",
                "message": "…", "row": { "Tracking Number": "" } } ],
  "preview": [ /* at most 10 rows */ ]
}
```

A preview writes an `imports` row (`status: 'previewed'`) and up to **500**
`import_row_errors` rows carrying only the cells that caused the failure.

### 6.5 Commit

`POST /imports/shipments/commit` requires `confirm: true` in the body (a literal
in `importCommitSchema`). It **re-runs the preview**, then creates one shipment
per valid row through `ShipmentService.create` — so each created shipment gets
its bootstrap event and its own public token.

- Rows that fail validation are skipped (they were already reported).
- A row whose `ShipmentService.create` throws (a duplicate tracking number, for
  example) is recorded as a failure with its reason and the loop continues.
- If **every** row is invalid the call is `422 UNPROCESSABLE`: *"Every row in
  this file is invalid… nothing was imported."*
- The commit is **not** wrapped in a transaction. A run that fails part way
  leaves the earlier rows committed, which is why the response reports both
  `created` and `failed` counts.

Re-importing the same file is safe: `assertDuplicate` turns every repeat into a
reported failure rather than a second shipment.

### 6.6 Error report

`GET /imports/:importId/errors.csv` returns only
`row_number, error_code, reason`. It contains **no submitted values**, so a
malicious cell such as `=cmd|...` can never be rendered as a live formula. The
report is tenant-scoped by `organization_id`.

---

## 7. Public tracking

### 7.1 The token

| Property | Value |
| --- | --- |
| Entropy | 32 bytes (256 bits) from `node:crypto.randomBytes`, base64url |
| Shape | `^[A-Za-z0-9_-]{32,64}$` — anything else is a `404` with no database query |
| Storage | Only `SHA-256(token)` in `shipments.public_token_hash` |
| Issued | On shipment creation and on an explicit rotate |
| Rotation | `POST /shipments/:id/public-link/rotate` replaces the hash and clears the revocation; **the old link stops working immediately** |
| Revocation | `POST /shipments/:id/public-link/revoke` sets `public_token_revoked_at` (`204`) |
| Expiry | None — revocation is the control |
| Rate limit | 30 requests per minute per IP |
| Link | `{APP_URL}/track/<token>`; the web client serves `/track/:token` |

A revoked, rotated or unknown token returns the same `404` body, so a revoked
link is indistinguishable from a wrong one.

The plaintext token is returned exactly once, at creation and at rotation, and
is never recoverable afterwards. The UI says so on the shipment page.

### 7.2 Exactly what the link exposes

`GET /api/v1/public/tracking/:token`, unauthenticated:

```jsonc
{
  "sender": "Demo Fulfilment",
  "shipment": {
    "publicReference": "PKG-A1",
    "carrier": "Manual / unknown carrier",
    "status": "in_transit",
    "statusLabel": "In transit",
    "shippedAt": "2026-03-15",
    "estimatedDeliveryAt": "2026-03-19",
    "deliveredAt": null,
    "lastUpdatedAt": "2026-03-18T09:12:00.000Z",
    "estimateSource": "Provided by the sender. It is an estimate, not a guarantee."
  },
  "events": [
    { "eventCode": "in_transit", "status": "in_transit",
      "description": "…", "locationText": "Birmingham, UK",
      "occurredAt": "…",
      "source": "Recorded manually by the sender" }
  ],
  "attention": null,   // fixed generic string when an open exception exists
  "disclaimer": "ShipCheck reports what the carrier published or what the sender recorded. It cannot guarantee a delivery date."
}
```

Only events with `is_customer_visible = true` are returned. The response is an
explicitly constructed projection; there is no serialisation of the shipment
row.

**Never exposed:** the shipment id, the organization id, the tracking number,
`orderReference`, the customer's name, the customer's email address, the
destination country, internal notes, exception types or details, staff names,
raw provider payloads, the token hash, or `lastPolledAt`.

`api.test.ts` asserts that a shipment whose `internalNotes` contains
`SECRET INTERNAL NOTE`, and whose tracking number is `PUBLIC-1`, produces a
response containing neither string, and that `shipment.customerEmail` is
`undefined`.

The `source` of a `manual` event is rewritten to
`"Recorded manually by the sender"` so a recipient is never shown a raw enum.

`attention` is the fixed string *"The sender is aware of a problem with this
shipment and is working on it."* — it reveals **that** something is wrong, never
what or why.

---

## 8. Customer notifications

### 8.1 Rules

Five rules are seeded per organization
(`OrganizationService.seedTemplates`), all **`enabled: false`**:

| `event_type` | Template | Default cooldown |
| --- | --- | --- |
| `shipment_created` | `shipment_created` | 0 |
| `in_transit` | `in_transit` | `organization_settings.default_cooldown_minutes`, default 360 |
| `out_for_delivery` | `out_for_delivery` | 0 |
| `delivered` | `delivered` | 0 |
| `exception` | `exception` | `organization_settings.default_cooldown_minutes`, default 360 |

`PATCH /settings/notifications` persists `enabled` and `cooldownMinutes` per
rule, audited as `settings.notifications.updated`. There is no route that
changes `templateId` or creates a rule.

### 8.2 What `queueForTransitions` would do

The guard rails are all implemented in `NotificationService.queueForTransitions`:

| Skip reason | Condition |
| --- | --- |
| `no_status_change` | `fromStatus === toStatus` — a notification is only ever queued for a real **transition** |
| `shipment_not_found` | The shipment is not in this organization |
| `no_customer_email` | There is no recipient |
| `status_not_notifiable` | The derived status has no notification event type (`label_created` maps to `shipment_created`; `unknown` maps to nothing) |
| `rule_disabled` | The rule is off |
| `inside_cooldown` | A log row for the same `(shipment, eventType)` exists inside the cooldown window |
| `duplicate_notification` | The insert returned nothing |

The recipient is stored as `recipient_hash = SHA-256(lower(customer_email))` —
enough to audit, never a plaintext address in the notification log.

The idempotency key is `<organizationId>:<shipmentId>:<eventType>:<eventId|na>`
with a unique index on `notification_logs.idempotency_key`, and the email
outbox row carries `email:<that key>`. A duplicate carrier event therefore
cannot produce a second customer message.

### 8.3 The pipeline is not connected

**`queueForTransitions` is never called.** No route, service or job handler
invokes it. In consequence:

- No notification is ever queued automatically.
- `notification_logs` stays empty.
- The `notifications.dispatch` job handler exists and works, but nothing
  enqueues that job in practice.
- The Notifications screen's outbox table stays empty.

The screen still shows the real state of everything it can show: which provider
is configured, whether it delivers, and the fixed sentence *"A message marked
\"sent\" means the provider accepted it. ShipCheck never claims an email was
delivered."*

This is a defect, not a design choice. It is recorded in
[IMPLEMENTATION_STATUS.md §5](IMPLEMENTATION_STATUS.md) and listed as the first
item of remaining work.

### 8.4 Status vocabulary

`NOTIFICATION_LOG_STATUSES` is `queued | sent | failed | skipped`. The code
writes `queued`, `sent` and `failed`; `skipped` is declared and never used.
`email_messages.status` is `queued`, `sent` or `failed`.

`NotificationService.history` and `.retry` exist in the service and are exposed
by **no** route.

---

## 9. Email truthfulness

ShipCheck never claims an external action succeeded unless the external service
confirmed it.

| Term | Meaning | Where |
| --- | --- | --- |
| `queued` | Persisted in `email_messages`, not yet handed to a provider | `EmailService.queueInvoice` / `queueSystemEmail` |
| `sent` | **The provider accepted the message for delivery.** Nothing more. | `EmailService.deliver` on `result.accepted` |
| `delivered` | **Never written.** Plain SMTP has no delivery receipt. | — |

The adapter contract (`server/src/integrations/email/types.ts`) separates three
concepts that are easy to conflate: `deliversMessages` (a provider will really
try), `accepted` (the provider took *this* message) and the recorded status.

- `GET /settings/notifications` returns a `note` stating the rule verbatim.
- `smoke.mjs` asserts the note matches `/never claims/i` and that
  `email.deliversMessages` is `false` when no provider is configured.
- `api.test.ts` asserts the same over HTTP.
- Every message is written **before** an attempt, so what was queued, what the
  provider accepted and what failed is all visible afterwards.
- The Notifications page renders an explicit warning whenever
  `deliversMessages` is false.

**Failure codes** (`EmailFailureCode`, classified in
`SmtpEmailAdapter.classify`): `not_configured`, `temporary`, `auth_failed`,
`permanent_recipient`, `provider_error`. `not_configured`,
`permanent_recipient` and `auth_failed` are treated as permanent by
`EmailService.deliver`; the rest are retryable.

---

## 10. The carrier integration boundary

**ShipCheck ships no carrier adapter.** Every carrier reports
`implemented: false`, `status: not_configured`, and error code
`adapter_not_implemented`. The web client renders the badge **"Not connected"**
for every card regardless of stored credentials.

The full boundary — what exists, what does not, and what an adapter would have
to satisfy — is in [INTEGRATIONS.md](INTEGRATIONS.md). The facts that belong in
the product spec:

| Surface | Real behaviour |
| --- | --- |
| `GET /integrations/carriers` | Every catalogue carrier except `manual`, always `implemented: false` |
| `POST /integrations/carriers/:code/test` | Always `ok: false`, `status: not_configured`, records `lastErrorCode: 'adapter_not_implemented'` |
| `POST /shipments/:id/refresh` | **Always `503 INTEGRATION_UNAVAILABLE`**, and the message names either the missing adapter or the specific carrier |
| `carrier.poll` job | Records a failed sync run with `adapter_not_implemented` and returns a **permanent** outcome; no shipment is ever marked delayed |
| `IntegrationService.pollCarrier` | Throws `INTEGRATION_UNAVAILABLE` |
| `shipments.last_polled_at` | Never written. The shipment-detail page shows an empty "Last carrier poll" |

Credentials can be stored (AES-256-GCM, `ENCRYPTION_KEY`) and are shown masked.
Storing them does **not** start a data feed, and the Carriers screen says so
above the cards.

---

## 11. Analytics honesty rules

`GET /reports/delivery` returns a `warnings` array with the response and the
Analytics screen renders it in a card titled *"Read this before using the
numbers"*. The three warnings, verbatim:

> "Average transit time is based on N delivered shipment(s) with both a ship
> date and a delivery date. Small samples are not comparable."
>
> "Carrier performance is not ranked. Routes, services and data quality differ,
> so a comparison here would be misleading."
>
> "Manual entries are included and labelled as manual; they are not
> carrier-confirmed data."

Beyond that:

- **Sample sizes are shown, not hidden.** `averageTransitHoursByCarrier[]`
  carries `sampleSize`, and the Analytics table prints the word
  *"too small to compare"* next to any carrier with fewer than 5 samples.
- Average transit time is computed **only** where `delivered_at` **and**
  `shipped_at` are both non-null. A delivered shipment with no ship date is
  excluded rather than guessed at.
- Carriers are grouped, never ranked. There is no score, no sort by performance
  and no league table anywhere in the product.
- `outcomes[].share` is a percentage of `totalShipments` in the same window,
  rounded to an integer.
- `delayAging` buckets exceptions by hours open (or hours to resolution, for
  exceptions still open): *Under 4 hours*, *4-24 hours*, *1-3 days*, *More than
  3 days*.
- The dashboard ships an `averageHours` field that the server does not return;
  see [IMPLEMENTATION_STATUS.md §5](IMPLEMENTATION_STATUS.md).

---

## 12. Dashboard metric definitions

The dashboard returns a `definitions` map with the numbers and the UI renders it
in a card titled *"How these numbers are calculated"*. ShipCheck defines:

| Metric | Definition |
| --- | --- |
| `counts` | Non-archived shipments grouped by their **derived** status. The sum always equals `totals` |
| `totals` | Row count of non-archived shipments |
| `openExceptions` | `open` + `acknowledged` exceptions |
| `untrackedWithoutCarrier` | Non-archived shipments whose `carrier_code` is `manual` — "Awaiting first carrier event. Not an error." |
| `staleShipments` | Non-archived, status in (`label_created`, `in_transit`, `out_for_delivery`), no event or last event older than **72 hours** (hard-coded) |
| `recentExceptions` | The 10 most recent `open`/`acknowledged` exceptions, newest first |
| `oldestOpenExceptionHours` | Age of the oldest `open`/`acknowledged` exception |
| `carrierBreakdown` | Shipments and open exceptions per carrier — a count of what you track, explicitly *not* a performance ranking |
| `agingList` | The 15 non-archived shipments with the oldest `last_event_at` (nulls first) among the four still-moving statuses |

`from` / `to` are accepted and echoed in `range`, but **no metric is filtered by
them**. Documented rather than silently ignored.

**Empty is empty.** With no records every count is `0`, every array is empty,
and the charts render their empty messages ("No shipments recorded yet.",
"No carriers yet", "Everything is moving"). No chart is drawn without data.

---

## 13. Roles and permissions

`OPERATIONS_PERMISSIONS` in `shared/src/constants.ts`, enforced by
`requirePermission` on the server.

| Permission | owner | admin | member | viewer |
| --- | :---: | :---: | :---: | :---: |
| `shipment.create` | yes | yes | yes | – |
| `shipment.edit` | yes | yes | yes | – |
| `shipment.archive` | yes | yes | – | – |
| `shipment.event.manual` | yes | yes | yes | – |
| `exception.resolve` | yes | yes | yes | – |
| `exception.comment` | yes | yes | yes | – |
| `import.run` | yes | yes | yes | – |
| `report.view` | yes | yes | yes | – |
| `report.export` | yes | yes | – | – |
| `integration.manage` | yes | yes | – | – |
| `notification.manage` | yes | yes | – | – |
| `settings.manage` | yes | yes | – | – |
| `member.manage` | yes | yes | – | – |
| `audit.view` | yes | yes | – | – |
| `ownership.transfer` | yes | – | – | – |
| `organization.delete` | yes | – | – | – |

A **viewer** holds no permissions: read-only, and every write route returns
`403` with the missing permission named.

Read routes (`GET /shipments`, `GET /exceptions`, `GET /dashboard`,
`GET /settings/notifications`, `GET /integrations/carriers`, `GET /imports`)
require membership and nothing more.

---

## 14. Exports

All three are `report.export` and all three are audited as
`export.generated` with the dataset, row count and request id.

| Endpoint | Rows | Notes |
| --- | --- | --- |
| `POST /exports/shipments` | Every shipment in the organization, oldest first | `includeCustomerEmail` defaults to **false**; the `customer_email` column is omitted entirely unless explicitly requested |
| `POST /exports/events` | Every tracking event joined to its shipment | Includes both `event_at` and `received_at` and the `source` column |
| `POST /exports/exceptions` | Every exception joined to its shipment | |

- Only the shipments export sets `X-Row-Count`.
- Every cell is formula-escaped by `escapeCsvCell` (a leading `=`, `+`, `-`,
  `@`, tab or CR is prefixed with `'`), a UTF-8 BOM is prepended and rows are
  CRLF-joined. `domain.test.ts` asserts that no exported cell begins with a
  formula trigger.
- Exports are not filtered: each always covers the whole tenant.

---

## 15. Deliberate limitations

Restated here because they are part of the product's contract, not just of its
codebase.

1. **Manual events are labelled, never presented as carrier-confirmed.** They
   carry `source: 'manual'`, they leave `last_carrier_status` untouched, the
   public page renders them as "Recorded manually by the sender", and every
   export includes the `source` column.
2. **Stalled means "no event for 72 hours"**, not "the carrier is late". It is
   computed from shipment staleness alone; a carrier outage could not produce it
   because there is no polling.
3. **`organizations.base_currency` exists and ShipCheck handles no money.**
   There is no amount, price, duty, invoice or refund anywhere in the schema or
   the product. The column is set at organization creation and displayed as
   workspace metadata. Nothing is ever summed, converted or reported in it.
4. **Estimated delivery is the sender's own estimate.** It is labelled as such
   in the shipment detail ("The estimated delivery date is your own estimate. It
   is not a carrier commitment."), on the public page
   (`estimateSource`), and no carrier data can improve it in this release.
5. **No carrier polling, ever.** `last_polled_at` is always null.