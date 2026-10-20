# ShipCheck — API Reference

Base URL: `{API_URL}/api/v1`. Every request and response body is JSON, except
the four CSV download endpoints.

Derived from the routers in `server/src/http/routes/`. There is **no generated
OpenAPI document** — this file is the reference and is maintained by hand.

---

## 1. Conventions

### 1.1 Authentication

Every tenant route requires the session cookie:

```
Cookie: shipcheck_session=<opaque token>
```

`Authorization: Bearer <token>` is also accepted for server-to-server clients
and is the same opaque session token. There is no API key.

Routes reachable without a session:

| Route | Why |
| --- | --- |
| `GET /api/v1/health/*` | Orchestrator probes; skipped by the rate limiter |
| `GET /api/v1/public/tracking/:token` | Customer-facing tracking link, token-scoped |
| `POST /api/v1/auth/register`, `/login`, `/password/forgot`, `/password/reset`, `/logout` | Registration and sign-in |
| `POST /api/v1/auth/organizations/:id/switch`, `/accept-invitation`, `GET /auth/organizations`, `POST /auth/organizations`, `GET /auth/me`, `PATCH /auth/me`, `POST /auth/password/change` | These require a session and return `401` without one |

There is **no webhook route**. Nothing in ShipCheck accepts an inbound carrier
callback, because there is no adapter whose signature could be verified.

### 1.2 Standard error envelope

Every non-2xx response produced by the routers uses one shape:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Some of the values you entered are not valid.",
    "fields": { "trackingNumber": ["Enter the tracking number"] },
    "issues": [{ "path": "trackingNumber", "message": "Enter the tracking number" }],
    "requestId": "req_lz3k9f2h1a0b7c"
  }
}
```

| Field | Always present | Notes |
| --- | --- | --- |
| `code` | yes | See §1.4 |
| `message` | yes | Safe to show a user. Never contains a stack trace |
| `fields` | on validation failures | Map of field path → messages |
| `issues` | on validation failures | Same information as a list |
| `requestId` | yes | Also in logs and on `audit_events.request_id` |

`requestId` comes from the incoming `X-Request-Id` header (truncated to 80
characters) or is generated as `req_<base36>`.

Three paths do **not** use this envelope and are called out where they occur:

- The global `/api/v1` rate limiter answers `429` with express-rate-limit's
  **default plain-text body**, not JSON.
- The public-tracking limiter answers `429` with a JSON `RATE_LIMITED` envelope
  that has **no `requestId`**.
- An unmatched route produces the standard `404` envelope from
  `notFoundHandler`.

### 1.3 Error codes

| HTTP | `code` | Raised when |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Zod body/query/param validation failed, the body is not valid JSON, or `organizationId` is not a UUID |
| 401 | `UNAUTHENTICATED` | No session, expired session, disabled account, or bad credentials |
| 403 | `FORBIDDEN` | The role lacks the required permission; the message names it |
| 404 | `NOT_FOUND` | The record does not exist, is not visible to the caller, or belongs to another tenant. Also an unknown route and an unknown, revoked or malformed public token |
| 409 | `CONFLICT` | Duplicate tracking number for the same carrier and organization, duplicate account email, already-used invitation |
| 422 | `UNPROCESSABLE` | A domain rule was violated: a manual event dated too far ahead, an already-closed exception, acknowledging a non-open exception, importing a file with no valid rows, inviting as `owner`, changing the owner's role, removing the owner or yourself, a bad ownership-transfer confirmation, a bad current password, reusing the same password, `ENCRYPTION_KEY` missing |
| 429 | `RATE_LIMITED` | Rate limit exceeded (see the two caveats in §1.2) |
| 500 | `INTERNAL_ERROR` | Unexpected failure. Logged server-side with the stack; the client gets a fixed message |
| 503 | `INTEGRATION_UNAVAILABLE` | `POST /shipments/:id/refresh` (no adapter) |

### 1.4 Pagination

List endpoints accept:

| Parameter | Type | Default | Notes |
| --- | --- | --- | --- |
| `page` | integer ≥ 1 | `1` | |
| `pageSize` | integer 1–100 | `25` | Hard cap `MAX_PAGE_SIZE`; a larger value is a `400` |
| `sort` | enum | per endpoint | See each endpoint |
| `order` | `asc` \| `desc` | per endpoint | |

and return:

```json
{ "items": [ … ], "page": 1, "pageSize": 25, "total": 137, "totalPages": 6 }
```

`totalPages` is at least 1 so the UI never renders "0 pages".

Zod object schemas **strip** unknown query parameters rather than rejecting
them, so `?utm_source=x` is silently ignored on every list endpoint.

### 1.5 Idempotency

**There is no `Idempotency-Key` HTTP header.** Repeating a `POST` repeats the
operation. Where duplication would be harmful, idempotency is enforced
internally by a stored key:

| Operation | Key | Effect of a repeat |
| --- | --- | --- |
| Recurring jobs | `maintenance.cleanup:<bucket>`, `exceptions.scan:<org>:<bucket>`, `carrier.poll:<carrier>:<bucket>` (15-minute buckets) | A restart does not duplicate |
| Delivery auto-close | `auto-close:<shipmentId>:<eventId>` | One auto-close per event |
| Notification dispatch | `dispatch:<notificationLogId>`, `dispatch-retry:<id>:<attempts>` | One dispatch per notification |
| Notification log | `<org>:<shipment>:<eventType>:<eventId\|na>` | Unique index on `notification_logs.idempotency_key` |
| Customer email | `email:<notification log key>` | Unique per notification |
| Invitation email | `invitation:<invitationId>` | One message per invitation |
| Carrier tracking event | `(organization_id, provider_event_id)` | `appendEvent` returns `{ deduplicated: true }`; a partial unique index backs it |
| Shipment create | — | **Not** idempotent. Each call creates a new shipment |
| Manual tracking event | — | **Not** idempotent. Manual events carry no provider identity |
| CSV commit | — | **Not** idempotent by key. Re-importing the same file reports every repeat as a row failure rather than creating a duplicate |

### 1.6 Money on the wire

There is none. **No endpoint returns an amount, a price or a currency.** The
organization record carries `baseCurrency` as workspace metadata and nothing is
ever computed from it.

---

## 2. Health

No authentication. Skipped by the `/api/v1` rate limiter.

| Method | Path | Response |
| --- | --- | --- |
| `GET` | `/health/live` | `200 { status: "ok", service: "collectflow-api", version: "1.0.0" }` |
| `GET` | `/health/ready` | `200` or `503` — see below |
| `GET` | `/health/info` | `200` — see below |

> **Known defect:** the `service` field says `collectflow-api` in both
> `/health/live` and `/health/info`. It is a copy-paste leftover from the
> sibling product and does not match the product name. See
> [IMPLEMENTATION_STATUS.md §5](IMPLEMENTATION_STATUS.md).

`/health/ready`:

```json
{
  "status": "ready",
  "checks": [
    { "name": "database", "ok": true },
    { "name": "email", "ok": true, "detail": "disabled: No email provider is configured. Email sending is disabled." }
  ],
  "warnings": [ "DATABASE_URL is not set: using the embedded PGlite PostgreSQL instance. …" ],
  "environment": "development"
}
```

- `503` with `status: "not_ready"` when the `select 1` database probe fails. The
  failure message is included in `checks[].detail`; no connection string or
  secret is exposed.
- **Email never makes the service unready.** The email check is always
  `ok: true` with a `detail` string, because ShipCheck is fully usable with
  manual tracking, CSV import and manual notification entry when email is down.
  Email health is *reported*, not *gating*.
- `warnings` repeats the startup configuration warnings.

`/health/info` returns the service name, environment, the worker configuration,
the email adapter name with `deliversMessages` and its `setupHint`, and the same
`warnings`.

---

## 3. Authentication — `/api/v1/auth`

| Method | Path | Auth |
| --- | --- | --- |
| `POST` | `/auth/register` | – | – |
| `POST` | `/auth/login` | – | – |
| `POST` | `/auth/logout` | – | – |
| `GET` | `/auth/session` | – | – |
| `GET` | `/auth/me` | session | any member |
| `PATCH` | `/auth/me` | session | any member |
| `POST` | `/auth/password/change` | session | any member |
| `POST` | `/auth/password/forgot` | – | – |
| `POST` | `/auth/password/reset` | – | – |
| `GET` | `/auth/organizations` | session | any member |
| `POST` | `/auth/organizations` | session | any member |
| `POST` | `/auth/organizations/:organizationId/switch` | session | membership required |
| `POST` | `/auth/accept-invitation` | session | – |

### `POST /auth/register` → `201`

| Field | Type | Rules |
| --- | --- | --- |
| `email` | string | Valid email, lower-cased, unique |
| `password` | string | 10–200 characters |
| `displayName` | string | 1–120 characters, trimmed |

Sets the session cookie and returns `AuthSessionResponse`:

```json
{
  "user": { "id": "…", "email": "…", "displayName": "…", "createdAt": "2026-01-04T09:12:00.000Z" },
  "memberships": [],
  "activeOrganizationId": null
}
```

`memberships` is empty until an organization is created, so the client routes
the new user to `/welcome`.

Errors: `400 VALIDATION_ERROR`, `409 CONFLICT` (email taken).

### `POST /auth/login` → `200`

Request `{ "email": string, "password": string }`. Returns
`AuthSessionResponse` and sets the cookie. `401 UNAUTHENTICATED` with **the same
message** whether the account is missing or the password is wrong: *"Email or
password is incorrect."* A disabled account returns `401` with *"This account
has been disabled."*

### `POST /auth/logout` → `204`

Revokes the session server-side and clears the cookie. Reads the cookie only, so
a `Bearer` client cannot revoke through this route.

### `GET /auth/session` → `200` / `401`

Returns `AuthSessionResponse`. `activeOrganizationId` is the session's stored
organization if the user is still a member, otherwise the first membership, or
`null`.

### `GET /auth/me` → `{ "user": SessionUser }`

### `PATCH /auth/me` → `{ "user": SessionUser }`

Request `{ "displayName"?: string }` (1–120 characters).

### `POST /auth/password/change` → `204`

Request `{ "currentPassword": string, "newPassword": string }`. On success **all**
sessions for the user are revoked and the cookie is cleared, so every device
must sign in again. `400` if the current password is wrong; `422` if the new
password equals the current one.

### `POST /auth/password/forgot` → `200`

Request `{ "email": string }`.

```json
{
  "ok": true,
  "message": "If that account exists, a reset link has been sent. Without a working email provider the link is only reachable in development logs.",
  "resetEmailAvailable": true
}
```

The response is identical whether or not the account exists. The token is
256-bit, stored only as a SHA-256 hash, single-use, and expires after **60
minutes**. `resetEmailAvailable` is `false` when no working provider is
configured; with `EMAIL_PROVIDER=log` the link is in `server/.data/outbox/`.

### `POST /auth/password/reset` → `204`

Request `{ "token": string (20–400), "password": string }`. Consumes the token,
rehashes the password and revokes all sessions. `400` if the token is invalid,
used or expired.

### `GET /auth/organizations` → `200`

```json
{ "organizations": [ MembershipSummary, … ] }
```

`MembershipSummary` = `{ organizationId, organizationName, organizationSlug,
baseCurrency, timezone, role, permissions[] }`. Only `active` memberships of
non-deleted organizations are listed.

### `POST /auth/organizations` → `201`

| Field | Rules |
| --- | --- |
| `name` | 2–120 characters, trimmed |
| `countryCode` | 2 letters, upper-cased |
| `timezone` | Valid IANA zone; invalid → `400 { timezone: ["Unknown timezone"] }` |
| `baseCurrency` | 3 upper-case letters (`^[A-Z]{3}$`) |

Creates the organization, makes the caller its `owner`, and in one transaction
writes the membership, the `organization_settings` row and the
`organization.created` audit event. Email templates and five notification rules
are then seeded — **all disabled**. The slug is slugified and made unique with a
`-2`, `-3` suffix.

`baseCurrency` is stored and displayed as workspace metadata. ShipCheck handles
no money.

### `POST /auth/organizations/:organizationId/switch` → `200`

Membership is re-checked **before** the session pointer moves. Returns
`AuthSessionResponse` with the new `activeOrganizationId`. `404` if the caller
is not a member.

### `POST /auth/accept-invitation` → `201`

Request `{ "token": string }`. Returns
`{ "organization": OrganizationRecord, "session": AuthSessionResponse }`. Also
seeds templates and notification rules. `400` for an invalid or expired token;
`409` if another request claimed it first.

---

## 4. Session context — `/api/v1/session`

| Method | Path | Auth |
| --- | --- | --- |
| `GET` | `/session/context` | session |

Returns `AuthSessionResponse`. `401` without a session. This is the endpoint the
web client calls on bootstrap.

---

## 5. Organization — `/api/v1/:organizationId`

`OrganizationRecord` = `{ id, name, slug, countryCode, timezone, baseCurrency,
logoUrl, addressLine1, city, postalCode, createdAt }`.

`OrganizationSettingsRow` = `{ organizationId, defaultCarrierCode,
stalledAfterHours, autoOpenExceptions, defaultCooldownMinutes, quietHoursStart,
quietHoursEnd, maxShipments, updatedAt }`. Defaults: `defaultCarrierCode
'manual'`, `stalledAfterHours 72`, `autoOpenExceptions true`,
`defaultCooldownMinutes 360`, quiet hours `null`, `maxShipments 5000`.

> `quietHoursStart` / `quietHoursEnd` are stored and settable but **never read by
> any scheduling code** — there is no reminder scheduler in this release.
> `maxShipments` is likewise **never enforced**.
> See [PRODUCT_SPEC.md §15](PRODUCT_SPEC.md).

| Method | Path | Permission |
| --- | --- | --- |
| `GET` | `/:organizationId/` | any member |
| `PATCH` | `/:organizationId/` | `settings.manage` |
| `GET` | `/:organizationId/members` | any member |
| `POST` | `/:organizationId/members/invitations` | `member.manage` |
| `GET` | `/:organizationId/members/invitations` | `member.manage` |
| `DELETE` | `/:organizationId/members/invitations/:invitationId` | `member.manage` |
| `PATCH` | `/:organizationId/members/:memberId` | `member.manage` |
| `DELETE` | `/:organizationId/members/:memberId` | `member.manage` |
| `POST` | `/:organizationId/transfer-ownership` | `ownership.transfer` |
| `GET` | `/:organizationId/audit` | `audit.view` |

### `GET /:organizationId/`

```json
{
  "organization": OrganizationRecord,
  "role": "owner",
  "permissions": ["shipment.create", "shipment.edit", "…"],
  "settings": OrganizationSettingsRow | null
}
```

### `PATCH /:organizationId/`

Any subset of `{ name, countryCode, timezone, addressLine1, city, postalCode }`
(2–120 characters for `name`; `timezone` validated). At least one field is
required — an empty body is a `400`. Writes `organization.updated` listing the
changed field names. **`logoUrl` cannot be changed through the API**: it is
accepted by the service's type but is not in the schema.

### Members

`MemberRecord` = `{ id (membership id), userId, email, displayName, role,
status, createdAt }`.

`GET /members` also returns `myRole`.

`POST /members/invitations` — request `{ email, role }` with `role` in
`admin | member | viewer`. `owner` is refused at validation (*"Ownership is
transferred separately"*), and the service refuses it again with `422`.
Response `201`:

```json
{ "invitation": { "expiresAt": "…",
                  "acceptUrl": "http://localhost:5173/accept-invitation?token=…",
                  "emailed": false, "emailConfigured": false } }
```

The accept URL is **always** returned so the operator can pass it on manually.
`emailed` reflects the provider result and is `false` when no provider is
configured — the response says so rather than pretending. Token: 256-bit, stored
as a SHA-256 hash, single-use, expires in 7 days. `409` if the person is already
a member. `403` if the actor is neither owner nor admin.

`GET /members/invitations` lists non-accepted invitations with a derived
`state` of `pending`, `expired` or `revoked`.

`PATCH /members/:memberId` — `{ role }`. Cannot target the owner (`422`:
*"An organization must always have an owner"*), requires the actor to be owner or
admin (`403`). Audited as `member.role_changed` with `from`/`to`.

`DELETE /members/:memberId` — `204`. Cannot remove the owner (`422`) or yourself
(`422`). Audited as `member.removed`.

### `POST /transfer-ownership`

Request `{ "membershipId": uuid, "confirmation": "TRANSFER OWNERSHIP" }`. The
phrase must match exactly (`422` with a `fields.confirmation` entry). Only the
current owner may call it (`403`). In one transaction the target becomes
`owner`, the previous owner becomes `admin`, and
`organization.ownership_transferred` is written. Returns `{ member }`.

### `GET /audit`

Query: `page`, `pageSize` (≤ 100, default 25), `entityType`, `action`. Returns
`Paginated<AuditEvent>` = `{ id, organizationId, actorUserId, action, entityType,
entityId, metadata, requestId, ipAddress, createdAt }`, newest first. Metadata is
redacted before storage.

> The key is `items`. The web Settings screen reads `entries` and therefore
> always shows its empty state. See
> [IMPLEMENTATION_STATUS.md §5](IMPLEMENTATION_STATUS.md).

---

## 6. Dashboard — `/api/v1/:organizationId`

| Method | Path | Permission |
| --- | --- | --- |
| `GET` | `/:organizationId/dashboard` | any member |

Query: `from`, `to` — each an optional string of at most 10 characters. They are
echoed in `range` and are **not** applied to any metric.

```json
{
  "generatedAt": "2026-03-18T09:12:00.000Z",
  "range": { "from": "2026-03-01", "to": "2026-03-18" },
  "counts": { "label_created": 1, "in_transit": 1, "delivered": 1, "exception": 1 },
  "totals": 4,
  "openExceptions": 1,
  "untrackedWithoutCarrier": 4,
  "staleShipments": 1,
  "recentExceptions": [ { "id": "…", "trackingNumber": "…", "type": "stalled",
                          "severity": "high", "openedAt": "…" } ],
  "oldestOpenExceptionHours": 31,
  "carrierBreakdown": [ { "carrierCode": "manual", "carrierName": "Manual / unknown carrier",
                          "count": 4, "exceptions": 1 } ],
  "agingList": [ { "shipmentId": "…", "trackingNumber": "…", "customerName": "…",
                   "carrierCode": "manual", "status": "exception",
                   "lastEventAt": "…", "ageHours": 72, "openExceptions": 1 } ],
  "definitions": { "labelCreated": "…", "staleShipments": "…" }
}
```

Definitions are exactly as written in [PRODUCT_SPEC.md §12](PRODUCT_SPEC.md) and
are rendered verbatim by the Dashboard screen.

With no records every count is `0` and every array is empty.

---

## 7. Shipments — `/api/v1/:organizationId/shipments`

| Method | Path | Permission |
| --- | --- | --- |
| `GET` | `/shipments` | any member |
| `POST` | `/shipments` | `shipment.create` |
| `GET` | `/shipments/:shipmentId` | any member |
| `PATCH` | `/shipments/:shipmentId` | `shipment.edit` |
| `POST` | `/shipments/:shipmentId/archive` | `shipment.archive` |
| `GET` | `/shipments/:shipmentId/events` | any member |
| `POST` | `/shipments/:shipmentId/events/manual` | `shipment.event.manual` |
| `POST` | `/shipments/:shipmentId/refresh` | `shipment.edit` |
| `POST` | `/shipments/:shipmentId/public-link/rotate` | `shipment.edit` |
| `POST` | `/shipments/:shipmentId/public-link/revoke` | `shipment.edit` |

### `GET /shipments`

| Query | Values | Notes |
| --- | --- | --- |
| `page`, `pageSize` | | Default 1 / 25, cap 100 |
| `q` | ≤ 120 | Case-insensitive match on tracking number, order reference, public reference or customer name. `%` and `_` are escaped |
| `status` | `all` (default) \| any `SHIPMENT_STATUSES` value | Filters the **derived** status |
| `carrierCode` | ≤ 32 characters | Not restricted to the catalogue |
| `destinationCountry` | 2 letters | |
| `hasException` | boolean | `true` selects shipments with an `open` or `acknowledged` exception |
| `from`, `to` | `YYYY-MM-DD` | Inclusive filter on **`shipments.created_at`**, not `shipped_at` |
| `sort` | `last_event_at` (default) \| `shipped_at` \| `estimated_delivery_at` \| `tracking_number` \| `created_at` | |
| `order` | `desc` (default) \| `asc` | |

Archived shipments are always excluded.

`ShipmentListItem` = `{ id, trackingNumber, carrierCode, carrierName,
orderReference, publicReference, customerName, destinationCountry, status,
lastCarrierStatus, derivedStatus, lastEventAt, lastEventDescription, shippedAt,
estimatedDeliveryAt, deliveredAt, openExceptionCount, lastPolledAt, createdAt }`.

`status` and `derivedStatus` are the same value — ShipCheck stores the derived
status rather than a separate lifecycle value. `lastCarrierStatus` is `null`
unless a `carrier`-sourced event has ever been recorded, which in this release
means always. `lastPolledAt` is **always `null`**; nothing ever polls.

`customerEmail`, `internalNotes` and `publicTokenHash` are **not** in the list
response.

### `POST /shipments` → `201`

| Field | Type | Rules |
| --- | --- | --- |
| `trackingNumber` | string | 4–120 characters, required |
| `carrierCode` | string | From `CARRIER_CATALOGUE`, default `manual` |
| `orderReference` | string ≤ 120 \| null | Optional |
| `publicReference` | string ≤ 64 \| null | Optional; shown on the public page |
| `customerName` | string ≤ 160 \| null | Optional |
| `customerEmail` | email \| null | Optional; required before a customer notification can be sent |
| `destinationCountry` | 2 letters \| null | Optional |
| `shippedAt` | `YYYY-MM-DD` \| null | Stored as `T00:00:00.000Z` |
| `estimatedDeliveryAt` | `YYYY-MM-DD` \| null | The sender's own estimate |
| `internalNotes` | string ≤ 4000 \| null | Never exposed on the public page |

Response:

```json
{
  "shipment": { "id": "…", "status": "label_created", "publicTokenHash": "…", "…": "…" },
  "publicUrl": "http://localhost:5173/track/<token>",
  "note": "The shipment was created with a \"created\" event. No carrier data has been received."
}
```

`publicUrl` is the only time the plaintext token is returned. It is stored as a
SHA-256 hash and can never be recovered; rotate or re-issue to get a new one.

`shipment` is the full row, so it **does** include `publicTokenHash`,
`internalNotes` and `customerEmail`. The caller is an authenticated member of
this organization, so nothing crosses a tenant boundary, but the hash is an
implementation detail that does not need to be on the wire.

`409 CONFLICT` when the tracking number already exists for that carrier in this
organization.

### `GET /shipments/:shipmentId`

```json
{
  "shipment": { "…": "full row", "carrierName": "…", "derivedStatus": "in_transit",
                "publicLinkActive": true, "shippedAt": "…", "lastEventAt": "…" },
  "events": [ { "id": "…", "eventCode": "in_transit", "normalizedStatus": "in_transit",
                "description": "…", "locationText": "…",
                "eventAt": "…", "receivedAt": "…", "source": "manual",
                "providerEventId": null, "isCustomerVisible": true } ],
  "exceptions": [ { "id": "…", "type": "stalled", "severity": "high", "status": "open",
                    "detail": "…", "openedAt": "…", "acknowledgedAt": null,
                    "resolvedAt": null, "lastNotifiedAt": null,
                    "createdAt": "…", "updatedAt": "…" } ],
  "timeline": [ AuditEvent ]
}
```

Events are ordered by `event_at DESC, received_at DESC`. `rawPayloadRedacted`
is **not** returned. `timeline` is the last 60 audit rows for this shipment.

### `PATCH /shipments/:shipmentId`

Any subset of `carrierCode`, `orderReference`, `publicReference`,
`customerName`, `customerEmail`, `destinationCountry`, `shippedAt`,
`estimatedDeliveryAt`, `internalNotes`. At least one field is required
(`"Provide at least one field to update"`).

`trackingNumber` cannot be changed. Changing `carrierCode` re-runs the duplicate
check so the carrier/tracking-number identity cannot be forked. Audited as
`shipment.updated` with the changed field names. Returns `{ shipment }`.

### `POST /shipments/:shipmentId/archive`

Request `{ "archived": boolean, "reason"?: string ≤ 300 }`. Sets or clears
`archived_at`. Audited as `shipment.archived` or `shipment.restored`. The
`reason` is accepted and **discarded** — the audit metadata records `undefined`.
Returns `{ shipment }`.

Archived shipments disappear from `GET /shipments`, the dashboard counts and the
aging list. They remain readable by direct id.

### `GET /shipments/:shipmentId/events`

Returns `{ "events": [ … ] }` — the same array as the detail endpoint.

### `POST /shipments/:shipmentId/events/manual` → `201`

| Field | Type | Rules |
| --- | --- | --- |
| `eventCode` | string | 2–64 characters, `[A-Za-z0-9_ -]` |
| `description` | string | 2–500 characters, required |
| `locationText` | string ≤ 160 \| null | Optional |
| `occurredAt` | `YYYY-MM-DD` | Stored as `T12:00:00.000Z` |
| `isCustomerVisible` | boolean | Default `true` |

```json
{
  "eventId": "…",
  "deduplicated": false,
  "statusChanged": true,
  "status": "in_transit",
  "note": "This event was recorded manually. It is not carrier-confirmed data."
}
```

`422` when `occurredAt` is more than a day in the future. `last_carrier_status`
is never written by this route. When the resulting status is `delivered`, an
`exceptions.auto_close` job is enqueued.

### `POST /shipments/:shipmentId/refresh`

**Always answers `503 INTEGRATION_UNAVAILABLE`.** There is no adapter, so no
carrier data is fetched and no status is changed. Two message variants:

- No integration rows at all, or `carrierCode === 'manual'`:
  *"This shipment has no configured carrier adapter, so ShipCheck cannot refresh
  it. Add tracking events manually or import them from CSV."*
- Otherwise:
  *"ShipCheck does not implement a live adapter for `<carrier>`. No carrier data
  was fetched and no status was changed."*

### `POST /shipments/:shipmentId/public-link/rotate`

No body. Returns `{ "publicUrl": "{APP_URL}/track/<newToken>" }` and
**immediately invalidates the previous link**. Audited as
`shipment.public_link_rotated`.

### `POST /shipments/:shipmentId/public-link/revoke` → `204`

Sets `public_token_revoked_at`. The link answers `404` from that moment.
Audited as `shipment.public_link_revoked`.

---

## 8. Exceptions — `/api/v1/:organizationId/exceptions`

| Method | Path | Permission |
| --- | --- | --- |
| `GET` | `/exceptions` | any member |
| `POST` | `/exceptions` | `exception.resolve` |
| `GET` | `/exceptions/:exceptionId` | any member |
| `POST` | `/exceptions/:exceptionId/assign` | `exception.resolve` |
| `POST` | `/exceptions/:exceptionId/acknowledge` | `exception.resolve` |
| `POST` | `/exceptions/:exceptionId/comments` | `exception.comment` |
| `POST` | `/exceptions/:exceptionId/resolve` | `exception.resolve` |

### `GET /exceptions`

| Query | Values | Default |
| --- | --- | --- |
| `page`, `pageSize` | | 1 / 25, cap 100 |
| `status` | `all` \| `open` \| `acknowledged` \| `resolved` \| `dismissed` | **`open`** |
| `type` | `all` \| any `EXCEPTION_TYPES` value | `all` |
| `severity` | `all` \| `low` \| `medium` \| `high` \| `critical` | `all` |
| `shipmentId` | uuid | |
| `assignedToMe` | boolean | |

> `assignedToMe` compares against the **literal string `"true"`**, not the
> caller's user id, so it matches nothing. No client sends it. Recorded in
> [IMPLEMENTATION_STATUS.md §5](IMPLEMENTATION_STATUS.md).

Ordered by `severity ASC, opened_at DESC` — note that severity is stored as
text, so this sorts alphabetically (`critical`, `high`, `low`, `medium`).

`ShipmentExceptionView` = `{ id, shipmentId, trackingNumber, customerName, type,
typeLabel, severity, status, detail, assignedUserId, assignedUserName, openedAt,
resolvedAt, resolutionReason, ageHours, lastEventAt }`. `ageHours` freezes at the
resolution time for closed exceptions.

### `POST /exceptions`

| Field | Type | Rules |
| --- | --- | --- |
| `shipmentId` | uuid | Must belong to this organization |
| `type` | `EXCEPTION_TYPES` | |
| `severity` | `EXCEPTION_TYPES` severity | Default `medium` |
| `detail` | string ≤ 1000 \| null | Optional |

`201 { "id": "…", "created": true }` when a new row is created, `200 { "id": "…",
"created": false }` when an active exception for the same `(shipment, type)` is
updated instead. Audited as `exception.opened` on creation only.

### `GET /exceptions/:exceptionId`

```json
{
  "exception": { "…": "full row", "typeLabel": "Stalled shipment",
                 "openedAt": "…", "acknowledgedAt": null, "resolvedAt": null,
                 "lastNotifiedAt": null },
  "comments": [ { "id": "…", "comment": "…", "visibility": "internal",
                  "createdAt": "…", "author": "…" } ],
  "timeline": [ AuditEvent ]
}
```

### `POST /exceptions/:exceptionId/assign`

Request `{ "assignedUserId": uuid | null }`. `null` clears the assignment.
`404` when the target id is not a known user. Returns `{ exception }`.
Audited as `exception.assigned`.

> The assignee is **not** checked for membership of this organization. See
> [PRODUCT_SPEC.md §4.6](PRODUCT_SPEC.md).

### `POST /exceptions/:exceptionId/acknowledge`

No body. Only an `open` exception can be acknowledged (`422`: *"Only an open
exception can be acknowledged."*). Sets `status = 'acknowledged'`, stamps
`acknowledged_at` and **assigns the exception to the caller**. Returns
`{ exception }`. Audited as `exception.acknowledged`.

### `POST /exceptions/:exceptionId/comments` → `201`

| Field | Type | Rules |
| --- | --- | --- |
| `comment` | string | 1–2000 characters, required |
| `visibility` | `internal` \| `customer` | Default `internal` |

Returns `{ comment }`. Audited as `exception.commented` with the visibility.
A `customer` comment is **not** sent to anybody — there is no delivery path for
it in this release.

### `POST /exceptions/:exceptionId/resolve`

| Field | Type | Rules |
| --- | --- | --- |
| `status` | `resolved` \| `dismissed` | Default `resolved` |
| `reason` | string | 3–500 characters, **required** |

`422 UNPROCESSABLE` (*"This exception is already closed."*) if the exception is
already `resolved` or `dismissed`. Stamps `resolved_at` and `resolution_reason`.
Returns `{ exception }`. Audited as `exception.resolved` or
`exception.dismissed` with the reason and the previous status.

---

## 9. Imports — `/api/v1/:organizationId/imports`

| Method | Path | Permission |
| --- | --- | --- |
| `POST` | `/imports/shipments/preview` | `import.run` |
| `POST` | `/imports/shipments/commit` | `import.run` |
| `GET` | `/imports` | any member |
| `GET` | `/imports/:importId` | any member |
| `GET` | `/imports/:importId/errors.csv` | any member |

### `POST /imports/shipments/preview`

| Field | Type | Rules |
| --- | --- | --- |
| `filename` | string | 1–200 characters |
| `content` | string | 1 – 5 242 880 characters (5 MB) |
| `mapping` | `Record<string, string>` | Optional, defaults `{}`. Maps a ShipCheck column name to a header in the file |

Response: `ImportPreview` — see [PRODUCT_SPEC.md §6.4](PRODUCT_SPEC.md).

Errors: `400` for a file over 5 MB, over 5 000 rows, or with no column mapped to
`tracking_number`.

Writes an `imports` row (`status: 'previewed'`) and up to 500
`import_row_errors` rows. Nothing else is created.

### `POST /imports/shipments/commit`

Same body plus **`confirm: true`**, which is a literal — omitting it or sending
`false` is a `400`:

```
{ "code": "VALIDATION_ERROR", "message": "Confirm the import before committing" }
```

Re-runs the preview internally (creating a second `imports` row) and then
creates one shipment per valid row.

```json
{
  "importId": "…",
  "created": 1,
  "invalidRows": 2,
  "failed": 0,
  "failures": [ { "rowNumber": 5, "trackingNumber": "IMP-5", "reason": "…" } ],
  "note": "Some rows could not be imported. Every reason is listed and a downloadable error report is available."
}
```

`failures` is capped at 50 entries. `note` is the string
*"Every valid row was imported."* when nothing failed.

`422` when every row is invalid.

> The web client does not send `confirm`, so the commit button returns `400`.
> See [IMPLEMENTATION_STATUS.md §5](IMPLEMENTATION_STATUS.md).

### `GET /imports`

The 20 most recent `imports` rows for this organization, newest first.

### `GET /imports/:importId`

The `imports` row plus its `errors` array
(`{ rowNumber, errorCode, safeMessage, redactedRow }`) ordered by line number.

An unknown id is a `400 VALIDATION_ERROR` (*"That import could not be found in
this organization."*) rather than a `404`, because this path uses `badRequest`.

### `GET /imports/:importId/errors.csv`

`200 text/csv; charset=utf-8`,
`Content-Disposition: attachment; filename="shipcheck-import-errors.csv"`.

Columns: `row_number, error_code, reason`. It contains **no submitted values**,
so a formula-leading cell in the source file can never be rendered as a live
formula.

---

## 10. Carrier integrations — `/api/v1/:organizationId/integrations/carriers`

| Method | Path | Permission |
| --- | --- | --- |
| `GET` | `/carriers` | any member |
| `PUT` | `/carriers/:carrierCode` | `integration.manage` |
| `POST` | `/carriers/:carrierCode/test` | `integration.manage` |
| `DELETE` | `/carriers/:carrierCode` | `integration.manage` |

`:carrierCode` is any trimmed string of 1–32 characters; it is **not** validated
against the catalogue.

### `GET /carriers`

```json
{
  "integrations": [
    { "carrierCode": "dhl", "displayName": "DHL",
      "implemented": false, "status": "not_configured", "enabled": false,
      "lastCheckedAt": null, "lastSuccessAt": null,
      "lastErrorCode": null, "lastErrorMessage": null,
      "pollIntervalMinutes": 60,
      "maskedKeys": [],
      "supportedEvents": ["ShipCheck does not currently implement this carrier. Manual event entry and CSV import remain available."],
      "documentedRateLimit": null,
      "setupGuide": [ "… four lines …" ],
      "limitations": [ "… two lines …" ] }
  ],
  "syncRuns": []
}
```

`implemented` is **`false` for every carrier, always**. `status` is
`not_configured | configured | error | disabled`; `error` is never written in
this release. `manual` is excluded from the list because it is not a carrier —
it is the "unknown carrier" bucket.

`syncRuns` is the 20 most recent `integration_sync_runs` rows.

### `PUT /carriers/:carrierCode`

| Field | Type | Default |
| --- | --- | --- |
| `credentials` | `Record<string, string>`, each ≤ 2000 characters | `{}` |
| `enabled` | boolean | `true` |

Credentials are sealed with AES-256-GCM before storage and are **never
returned**. `422` with a message naming `ENCRYPTION_KEY` if the key is not
configured. An empty `credentials` object leaves any existing sealed value
untouched. Saving sets `status = 'configured'` when credentials were stored —
but `implemented` stays `false`, so the UI still says **Not connected**.
Audited as `integration.updated` with the credential **key names** only.

> A `carrierCode` outside `CARRIER_CATALOGUE` stores a row and returns
> `{}`, because the response is looked up in the catalogue view. Recorded in
> [IMPLEMENTATION_STATUS.md §5](IMPLEMENTATION_STATUS.md).

### `POST /carriers/:carrierCode/test`

```json
{
  "ok": false,
  "detail": "ShipCheck has no implemented adapter for this carrier, so there is nothing to verify against. Manual tracking and CSV import are unaffected.",
  "status": "not_configured"
}
```

Always `200`. Always `ok: false`. Records `lastCheckedAt`,
`lastErrorCode: 'adapter_not_implemented'` and the same message as
`lastErrorMessage`, creating the row if it does not exist. Audited as
`integration.tested`.

### `DELETE /carriers/:carrierCode` → `204`

Clears the sealed credentials, sets `status = 'not_configured'`, `enabled =
false`. `404` when no row exists. Audited as `integration.disconnected`. Nothing
else in the product changes.

---

## 11. Settings — `/api/v1/:organizationId/settings`

| Method | Path | Permission |
| --- | --- | --- |
| `GET` | `/settings/notifications` | any member |
| `PATCH` | `/settings/notifications` | `notification.manage` |
| `PATCH` | `/settings/organization` | `settings.manage` |

### `GET /settings/notifications`

```json
{
  "rules": [ { "id": "…", "organizationId": "…", "eventType": "in_transit",
               "enabled": false, "templateId": "in_transit",
               "recipientPolicy": "customer_email", "cooldownMinutes": 360,
               "createdAt": "…", "updatedAt": "…" } ],
  "settings": OrganizationSettingsRow | null,
  "email": { "provider": "disabled", "deliversMessages": false,
             "detail": "No email provider is configured. Email sending is disabled.",
             "setupHint": "…" },
  "outbox": [ { "id": "…", "templateType": "in_transit", "toAddress": "…",
                "subject": "…", "status": "sent", "providerMessageId": "…",
                "failureCode": null, "safeFailureMessage": null,
                "sentAt": "…", "createdAt": "…" } ],
  "note": "A message marked \"sent\" means the provider accepted it. ShipCheck never claims an email was delivered."
}
```

The outbox is the 25 most recent `email_messages` rows for this organization.

`status` is `queued | sent | failed`. **`delivered` is never written.**

### `PATCH /settings/notifications`

Request `{ "rules": [ { "eventType": string, "enabled": boolean,
"templateId": string, "cooldownMinutes": integer 0–10080 } ] }` (1–20 items).

Only `enabled` and `cooldownMinutes` are persisted; `templateId` is validated and
ignored. Returns `{ rules }` (the full list) and audits
`settings.notifications.updated`.

### `PATCH /settings/organization`

Request (`updateOrganizationSettingsSchema`), all optional:

| Field | Constraint |
| --- | --- |
| `defaultCarrierCode` | 1–32 characters |
| `stalledAfterHours` | integer 1–720, default 72 |
| `autoOpenExceptions` | boolean, default `true` |
| `defaultCooldownMinutes` | integer 0–10 080, default 360 |
| `quietHoursStart` / `quietHoursEnd` | `HH:MM` or `null` |

Upserts the settings row (`ON CONFLICT (organization_id) DO UPDATE`). Returns
`{ settings }` and audits `settings.updated`.

> `quietHoursStart` / `quietHoursEnd` are stored but **never read** — there is no
> scheduled sender in this release.

---

## 12. Exports — `/api/v1/:organizationId/exports`

| Method | Path | Permission | Body |
| --- | --- | --- | --- |
| `POST` | `/shipments` | `report.export` | `{ "includeCustomerEmail"?: boolean }` (default `false`) |
| `POST` | `/events` | `report.export` | none |
| `POST` | `/exceptions` | `report.export` | none |

All three return `200 text/csv; charset=utf-8` with a
`Content-Disposition: attachment` header, a UTF-8 BOM and CRLF row endings.
Only `/shipments` also sets `X-Row-Count`.

| Dataset | Filename | Columns |
| --- | --- | --- |
| shipments | `shipcheck-shipments-<YYYY-MM-DD>.csv` | `tracking_number, carrier, order_reference, public_reference, customer_name[, customer_email], destination_country, status, last_carrier_status, shipped_at, estimated_delivery_at, delivered_at, last_event_at, last_event_description, event_count, open_exceptions` |
| events | `shipcheck-events-<YYYY-MM-DD>.csv` | `tracking_number, event_code, normalized_status, description, location, event_at, received_at, source` |
| exceptions | `shipcheck-exceptions-<YYYY-MM-DD>.csv` | `tracking_number, type, severity, status, detail, opened_at, resolved_at, resolution_reason` |

`carrier` in the shipments export is the **display name**, not the code.

Exports cover the whole tenant; they are not filtered. `customer_email` is
omitted entirely unless `includeCustomerEmail` is explicitly `true`, and the
inclusion is recorded in the audit event. Every cell is formula-escaped.

Each export writes `export.generated` with the dataset, row count and (for
shipments) the email-inclusion flag.

---

## 13. Delivery report — `/api/v1/:organizationId/reports/delivery`

| Method | Path | Permission |
| --- | --- | --- |
| `GET` | `/:organizationId/reports/delivery` | `report.view` |

Query (`deliveryReportQuerySchema`): `from`, `to` (`YYYY-MM-DD`, optional; the
default window is 1 January of `to`'s year through `to`), `carrierCode`
(≤ 32 characters, optional).

```json
{
  "range": { "from": "2026-01-01", "to": "2026-03-18" },
  "outcomes": [ { "status": "delivered", "label": "Delivered", "count": 1, "share": 33 } ],
  "totalShipments": 3,
  "averageTransitHoursByCarrier": [ { "carrierCode": "manual",
                                      "carrierName": "Manual / unknown carrier",
                                      "sampleSize": 1, "averageHours": 192 } ],
  "exceptionsByCarrier": [ { "carrierCode": "manual", "carrierName": "…",
                             "total": 1, "critical": 0 } ],
  "delayAging": [ { "label": "Under 4 hours", "maxHours": 4, "count": 0 },
                  { "label": "4-24 hours", "maxHours": 24, "count": 1 },
                  { "label": "1-3 days", "maxHours": 72, "count": 0 },
                  { "label": "More than 3 days", "maxHours": null, "count": 0 } ],
  "warnings": [ "Average transit time is based on 1 delivered shipment(s)…",
                "Carrier performance is not ranked.…",
                "Manual entries are included and labelled as manual;…" ]
}
```

`averageTransitHoursByCarrier` includes only shipments with **both** `shipped_at`
and `delivered_at`, and each row carries its own `sampleSize`. `maxHours` is
`Infinity` on the last delay bucket and serialises to `null`; `averageHours` is
**not** returned per bucket even though the Analytics screen reads it. See
[IMPLEMENTATION_STATUS.md §5](IMPLEMENTATION_STATUS.md).

---

## 14. Public — `/api/v1/public`

### `GET /public/tracking/:token`

No authentication. **Rate limited to 30 requests per minute per IP**, answered
with a `RATE_LIMITED` envelope that has no `requestId`.

`:token` must match `^[A-Za-z0-9_-]{32,64}$`; anything else is a `404` without a
database query. The token is hashed with SHA-256 and matched against
`shipments.public_token_hash` with `public_token_revoked_at IS NULL`.

The full response shape is in [PRODUCT_SPEC.md §7.2](PRODUCT_SPEC.md).

Explicitly **not** included: the shipment id, the organization id, the tracking
number, `orderReference`, the customer name, the customer email, the
destination country, internal notes, exception types and details, staff names,
raw provider payloads, `lastPolledAt` and the token hash.

`404` for an unknown, revoked or rotated token, with the same message in each
case.

---

## 15. Not implemented

Endpoints named in the product specification that this release does **not**
expose. Listed so no one hunts for them:

| Endpoint / capability | Status |
| --- | --- |
| `POST /api/v1/webhooks/:provider` | **No webhook route exists at all.** There is no carrier adapter whose signature could be verified. (`app.ts` still installs a 1 MB JSON parser under `/api/v1/webhooks` for a route that does not exist — dead code.) |
| `GET /api/v1/:orgId/shipments/:id/events?source=` filtering | The route returns every event; filtering is client-side |
| `GET /api/v1/:orgId/shipments/:id/refresh` with a real carrier fetch | The route exists and always answers `503` |
| `GET /api/v1/:orgId/notifications` history and retry | `NotificationService.history`/`retry` exist; **no route exposes them** |
| `GET /api/v1/:orgId/jobs` (job admin UI) | `JobQueue.listFailed`/`stats`/`retry` exist; no route exposes them |
| `GET /api/v1/:orgId/imports/:id/errors.csv` as JSON | CSV only |
| `DELETE /api/v1/:orgId` (organization deletion) | Not implemented; `organizations.deleted_at` exists and is honoured on read |
| Account data export / self-service account deletion | Not implemented |
| Email template editing | Templates are seeded per organization; no CRUD route |
| `POST /api/v1/:orgId/shipments/:id/public-link/revoke` with an expiry | Revocation only; no time-based expiry |
| `GET /api/v1/openapi.json` | Not generated; this document is the reference |