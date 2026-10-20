/**
 * ShipCheck database schema (Part C / C5).
 *
 * - UUID primary keys, `timestamptz` UTC timestamps.
 * - Every tenant-owned table carries `organization_id`.
 * - A tracking number is unique per (organization, carrier, tracking number).
 *   It is deliberately NOT globally unique: carriers reuse numbers, and the same
 *   number can legitimately exist for two different carriers (C7).
 */

import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import type { CustomerAddress } from './shared-foundation.js';

const now = sql`now()`;

export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    countryCode: text('country_code').notNull().default('US'),
    timezone: text('timezone').notNull().default('UTC'),
    baseCurrency: text('base_currency').notNull().default('USD'),
    logoUrl: text('logo_url'),
    addressLine1: text('address_line1'),
    city: text('city'),
    postalCode: text('postal_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(now),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('organizations_slug_idx').on(table.slug)],
);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    passwordHash: text('password_hash'),
    displayName: text('display_name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(now),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('users_email_idx').on(table.email)],
);

export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    userId: uuid('user_id').notNull(),
    role: text('role').notNull(),
    status: text('status').notNull().default('active'),
    invitedBy: uuid('invited_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [uniqueIndex('memberships_org_user_idx').on(table.organizationId, table.userId)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    activeOrganizationId: uuid('active_organization_id'),
    userAgent: text('user_agent'),
    ipAddress: text('ip_address'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('sessions_token_hash_idx').on(table.tokenHash),
    index('sessions_user_idx').on(table.userId),
  ],
);

export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    email: text('email').notNull(),
    role: text('role').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    invitedBy: uuid('invited_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [uniqueIndex('invitations_token_hash_idx').on(table.tokenHash)],
);

export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [uniqueIndex('password_reset_token_hash_idx').on(table.tokenHash)],
);

export const organizationSettings = pgTable('organization_settings', {
  organizationId: uuid('organization_id').primaryKey(),
  defaultCarrierCode: text('default_carrier_code').notNull().default('manual'),
  /** Hours without a meaningful event before a "stalled" exception opens. */
  stalledAfterHours: integer('stalled_after_hours').notNull().default(72),
  autoOpenExceptions: boolean('auto_open_exceptions').notNull().default(true),
  defaultCooldownMinutes: integer('default_cooldown_minutes').notNull().default(360),
  quietHoursStart: text('quiet_hours_start'),
  quietHoursEnd: text('quiet_hours_end'),
  /** Per-organization account limits (F/B style quotas). */
  maxShipments: integer('max_shipments').notNull().default(5_000),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(now),
});

/** Global carrier catalogue. `organization_id` is null for shared rows. */
export const carriers = pgTable(
  'carriers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id'),
    code: text('code').notNull(),
    displayName: text('display_name').notNull(),
    adapterType: text('adapter_type').notNull().default('manual'),
    enabled: boolean('enabled').notNull().default(true),
    /** Only a link ShipCheck verified as belonging to the carrier's own site. */
    trackingUrlTemplate: text('tracking_url_template'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    uniqueIndex('carriers_org_code_idx').on(table.organizationId, table.code),
    index('carriers_code_idx').on(table.code),
  ],
);

export const shipments = pgTable(
  'shipments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    trackingNumber: text('tracking_number').notNull(),
    carrierCode: text('carrier_code').notNull().default('manual'),
    orderReference: text('order_reference'),
    publicReference: text('public_reference'),
    /** Last status reported by a carrier source. */
    lastCarrierStatus: text('last_carrier_status'),
    /** Internally derived status, always recomputed from the timeline. */
    status: text('status').notNull().default('label_created'),
    shippedAt: timestamp('shipped_at', { withTimezone: true }),
    estimatedDeliveryAt: timestamp('estimated_delivery_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    lastEventAt: timestamp('last_event_at', { withTimezone: true }),
    lastEventDescription: text('last_event_description'),
    lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
    customerEmail: text('customer_email'),
    customerName: text('customer_name'),
    destinationCountry: text('destination_country'),
    internalNotes: text('internal_notes'),
    publicTokenHash: text('public_token_hash'),
    publicTokenRevokedAt: timestamp('public_token_revoked_at', { withTimezone: true }),
    source: text('source').notNull().default('manual'),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(now),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => [
    // Tracking numbers are not globally unique (C7).
    uniqueIndex('shipments_org_carrier_tracking_idx').on(
      table.organizationId,
      table.carrierCode,
      table.trackingNumber,
    ),
    index('shipments_org_status_idx').on(table.organizationId, table.status),
    index('shipments_org_last_event_idx').on(table.organizationId, table.lastEventAt),
    index('shipments_tracking_number_idx').on(table.trackingNumber),
    index('shipments_public_token_idx').on(table.publicTokenHash),
  ],
);

export const trackingEvents = pgTable(
  'tracking_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    shipmentId: uuid('shipment_id').notNull(),
    source: text('source').notNull().default('manual'),
    providerEventId: text('provider_event_id'),
    eventCode: text('event_code').notNull(),
    normalizedStatus: text('normalized_status').notNull().default('unknown'),
    description: text('description').notNull().default(''),
    locationText: text('location_text'),
    /** Event time reported by the source. Out-of-order arrivals are expected. */
    eventAt: timestamp('event_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().default(now),
    /** Redacted payload only - never a raw provider response. */
    rawPayloadRedacted: jsonb('raw_payload_redacted_json').$type<Record<string, unknown>>(),
    isCustomerVisible: boolean('is_customer_visible').notNull().default(true),
    /**
     * True only for the synthetic "added to ShipCheck" event written when the
     * shipment row is created.
     *
     * It is bookkeeping, not a tracking report: real carrier events are
     * backdated, so without this marker the bootstrap event (stamped `now`)
     * would be the newest event forever and no shipment could ever leave
     * "label created".
     */
    isBootstrap: boolean('is_bootstrap').notNull().default(false),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    // Dedupe identity: provider event id when known, otherwise manual events.
    uniqueIndex('tracking_events_provider_identity_idx')
      .on(table.organizationId, table.providerEventId)
      .where(sql`${table.providerEventId} is not null`),
    index('tracking_events_shipment_event_idx').on(table.shipmentId, table.eventAt),
    index('tracking_events_org_received_idx').on(table.organizationId, table.receivedAt),
  ],
);

export const shipmentExceptions = pgTable(
  'shipment_exceptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    shipmentId: uuid('shipment_id').notNull(),
    type: text('type').notNull(),
    severity: text('severity').notNull().default('medium'),
    status: text('status').notNull().default('open'),
    assignedUserId: uuid('assigned_user_id'),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().default(now),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolutionReason: text('resolution_reason'),
    detail: text('detail'),
    lastEventId: uuid('last_event_id'),
    lastNotifiedAt: timestamp('last_notified_at', { withTimezone: true }),
    reopenCount: integer('reopen_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    index('shipment_exceptions_org_status_idx').on(table.organizationId, table.status),
    index('shipment_exceptions_shipment_idx').on(table.shipmentId),
  ],
);

export const exceptionComments = pgTable(
  'exception_comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    exceptionId: uuid('exception_id').notNull(),
    userId: uuid('user_id'),
    comment: text('comment').notNull(),
    visibility: text('visibility').notNull().default('internal'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [index('exception_comments_exception_idx').on(table.exceptionId, table.createdAt)],
);

export const notificationRules = pgTable(
  'notification_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    eventType: text('event_type').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    templateId: text('template_id').notNull(),
    recipientPolicy: text('recipient_policy').notNull().default('customer_email'),
    cooldownMinutes: integer('cooldown_minutes').notNull().default(360),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    uniqueIndex('notification_rules_org_event_idx').on(table.organizationId, table.eventType),
  ],
);

export const notificationLogs = pgTable(
  'notification_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    shipmentId: uuid('shipment_id').notNull(),
    eventId: uuid('event_id'),
    /** SHA-256 of the recipient address: enough to audit, never a plaintext leak. */
    recipientHash: text('recipient_hash').notNull(),
    channel: text('channel').notNull().default('email'),
    eventType: text('event_type').notNull(),
    status: text('status').notNull().default('queued'),
    providerMessageId: text('provider_message_id'),
    failureCode: text('failure_code'),
    safeFailureMessage: text('safe_failure_message'),
    attempts: integer('attempts').notNull().default(0),
    idempotencyKey: text('idempotency_key').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    uniqueIndex('notification_logs_idempotency_idx').on(table.idempotencyKey),
    index('notification_logs_org_status_idx').on(table.organizationId, table.status),
    index('notification_logs_shipment_idx').on(table.shipmentId),
  ],
);

export const carrierIntegrations = pgTable(
  'carrier_integrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    carrierCode: text('carrier_code').notNull(),
    status: text('status').notNull().default('not_configured'),
    encryptedCredentials: text('encrypted_credentials_json'),
    enabled: boolean('enabled').notNull().default(true),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    lastErrorCode: text('last_error_code'),
    lastErrorMessage: text('last_error_message'),
    pollIntervalMinutes: integer('poll_interval_minutes').notNull().default(60),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [uniqueIndex('carrier_integrations_org_code_idx').on(table.organizationId, table.carrierCode)],
);

export const integrationSyncRuns = pgTable(
  'integration_sync_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    carrierCode: text('carrier_code').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().default(now),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    status: text('status').notNull().default('running'),
    fetchedCount: integer('fetched_count').notNull().default(0),
    insertedCount: integer('inserted_count').notNull().default(0),
    duplicateCount: integer('duplicate_count').notNull().default(0),
    errorCode: text('error_code'),
    safeErrorMessage: text('safe_error_message'),
  },
  (table) => [index('integration_sync_runs_org_idx').on(table.organizationId, table.startedAt)],
);

export const imports = pgTable(
  'imports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    uploadedBy: uuid('uploaded_by'),
    filenameSafe: text('filename_safe').notNull(),
    status: text('status').notNull().default('previewed'),
    totalRows: integer('total_rows').notNull().default(0),
    successfulRows: integer('successful_rows').notNull().default(0),
    failedRows: integer('failed_rows').notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [index('imports_org_idx').on(table.organizationId, table.createdAt)],
);

export const importRowErrors = pgTable(
  'import_row_errors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    importId: uuid('import_id').notNull(),
    rowNumber: integer('row_number').notNull(),
    errorCode: text('error_code').notNull(),
    safeMessage: text('safe_message').notNull(),
    /** Only the cells that caused the failure, never other tenants' data. */
    redactedRow: jsonb('redacted_row_json').$type<Record<string, string>>(),
  },
  (table) => [index('import_row_errors_import_idx').on(table.importId, table.rowNumber)],
);

export const emailTemplates = pgTable(
  'email_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    type: text('type').notNull(),
    subject: text('subject').notNull(),
    bodyHtml: text('body_html').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [uniqueIndex('email_templates_org_type_idx').on(table.organizationId, table.type)],
);

export const emailMessages = pgTable(
  'email_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id'),
    templateType: text('template_type').notNull(),
    toAddress: text('to_address').notNull(),
    fromAddress: text('from_address').notNull(),
    subject: text('subject').notNull(),
    bodyText: text('body_text'),
    status: text('status').notNull().default('queued'),
    providerMessageId: text('provider_message_id'),
    failureCode: text('failure_code'),
    safeFailureMessage: text('safe_failure_message'),
    relatedShipmentId: uuid('related_shipment_id'),
    idempotencyKey: text('idempotency_key'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [index('email_messages_org_status_idx').on(table.organizationId, table.status)],
);

export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    actorUserId: uuid('actor_user_id'),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    metadata: jsonb('metadata_json').$type<Record<string, unknown>>(),
    requestId: text('request_id'),
    ipAddress: text('ip_address'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    index('audit_events_org_created_idx').on(table.organizationId, table.createdAt),
    index('audit_events_entity_idx').on(table.entityType, table.entityId),
  ],
);

export const backgroundJobs = pgTable(
  'background_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id'),
    jobType: text('job_type').notNull(),
    payload: jsonb('payload_json').$type<Record<string, unknown>>().notNull().default({}),
    status: text('status').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    runAfter: timestamp('run_after', { withTimezone: true }).notNull().default(now),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: text('locked_by'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    lastErrorCode: text('last_error_code'),
    lastErrorMessage: text('last_error_message'),
    idempotencyKey: text('idempotency_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    index('background_jobs_claim_idx').on(table.status, table.runAfter),
    uniqueIndex('background_jobs_idempotency_idx')
      .on(table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
  ],
);

/* -------------------------------------------------------------------------- */
/* Relations                                                                  */
/* -------------------------------------------------------------------------- */

export const shipmentsRelations = relations(shipments, ({ many }) => ({
  events: many(trackingEvents),
  exceptions: many(shipmentExceptions),
}));

export const trackingEventsRelations = relations(trackingEvents, ({ one }) => ({
  shipment: one(shipments, { fields: [trackingEvents.shipmentId], references: [shipments.id] }),
}));

export const shipmentExceptionsRelations = relations(shipmentExceptions, ({ one, many }) => ({
  shipment: one(shipments, { fields: [shipmentExceptions.shipmentId], references: [shipments.id] }),
  comments: many(exceptionComments),
}));

export type Organization = typeof organizations.$inferSelect;
export type User = typeof users.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
export type Shipment = typeof shipments.$inferSelect;
export type TrackingEvent = typeof trackingEvents.$inferSelect;
export type ShipmentException = typeof shipmentExceptions.$inferSelect;
export type NotificationRule = typeof notificationRules.$inferSelect;
export type NotificationLog = typeof notificationLogs.$inferSelect;
export type CarrierIntegration = typeof carrierIntegrations.$inferSelect;
export type OrganizationSettings = typeof organizationSettings.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type Import = typeof imports.$inferSelect;
export type ImportRowError = typeof importRowErrors.$inferSelect;
export type BackgroundJob = typeof backgroundJobs.$inferSelect;
export type CarrierIntegrationRow = typeof carrierIntegrations.$inferSelect;
export type NotificationRuleRow = typeof notificationRules.$inferSelect;
export type EmailTemplate = typeof emailTemplates.$inferSelect;
export type EmailMessage = typeof emailMessages.$inferSelect;
export type Carrier = typeof carriers.$inferSelect;
export { CustomerAddress };