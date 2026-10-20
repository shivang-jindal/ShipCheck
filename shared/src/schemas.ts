/** Zod schemas shared between the ShipCheck browser and API. */

import { z } from 'zod';

import {
  CARRIER_CATALOGUE,
  DEFAULT_PAGE_SIZE,
  EXCEPTION_SEVERITIES,
  EXCEPTION_TYPES,
  MAX_PAGE_SIZE,
  NOTIFICATION_EVENT_TYPES,
  ROLES,
  SHIPMENT_STATUSES,
} from './constants.js';

const uuid = z.string().uuid();
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected an ISO date (YYYY-MM-DD)');

export const idSchema = uuid;
export const idParamSchema = z.object({ id: uuid });
export const organizationParamSchema = z.object({ organizationId: uuid });
export const emailSchema = z.string().trim().toLowerCase().email('Enter a valid email address');
export const passwordSchema = z.string().min(10, 'Use at least 10 characters').max(200);

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export const shipmentIdParamSchema = z.object({
  organizationId: uuid,
  shipmentId: uuid,
});

/* -------------------------------------------------------------------------- */
/* Auth and organization (shared shape with every product)                    */
/* -------------------------------------------------------------------------- */

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: z.string().trim().min(1, 'Enter your name').max(120),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Enter your password').max(200),
});

export const forgotPasswordSchema = z.object({ email: emailSchema });

export const resetPasswordSchema = z.object({
  token: z.string().min(20).max(400),
  password: passwordSchema,
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password'),
  newPassword: passwordSchema,
});

export const updateProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
});

const countryCode = z.string().trim().toUpperCase().length(2, 'Use a 2-letter country code');

export const createOrganizationSchema = z.object({
  name: z.string().trim().min(2, 'Enter an organization name').max(120),
  countryCode,
  timezone: z.string().trim().min(1).max(64),
  baseCurrency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
});

export const updateOrganizationSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    countryCode: countryCode.optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
    addressLine1: z.string().trim().max(200).nullable().optional(),
    city: z.string().trim().max(120).nullable().optional(),
    postalCode: z.string().trim().max(24).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Provide at least one field to update' });

export const createInvitationSchema = z.object({
  email: emailSchema,
  role: z.enum(ROLES).refine((role) => role !== 'owner', {
    message: 'Ownership is transferred separately',
  }),
});

export const changeMemberRoleSchema = z.object({ role: z.enum(ROLES) });

export const acceptInvitationSchema = z.object({ token: z.string().min(20).max(400) });

export const transferOwnershipSchema = z.object({
  membershipId: uuid,
  confirmation: z.literal('TRANSFER OWNERSHIP'),
});

/* -------------------------------------------------------------------------- */
/* Settings                                                                   */
/* -------------------------------------------------------------------------- */

export const updateOrganizationSettingsSchema = z.object({
  defaultCarrierCode: z.string().trim().min(1).max(32).optional(),
  stalledAfterHours: z.coerce.number().int().min(1).max(720).optional(),
  autoOpenExceptions: z.boolean().optional(),
  defaultCooldownMinutes: z.coerce.number().int().min(0).max(10_080).optional(),
  quietHoursStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
  quietHoursEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
});

/* -------------------------------------------------------------------------- */
/* Shipments                                                                  */
/* -------------------------------------------------------------------------- */

const carrierCode = z
  .string()
  .trim()
  .toLowerCase()
  .max(32)
  .regex(/^[a-z0-9_]+$/, 'Use letters, numbers and underscores')
  .refine(
    (code) => CARRIER_CATALOGUE.some((carrier) => carrier.code === code),
    'Choose a carrier from the list, or "manual" when it is unknown',
  );

export const createShipmentSchema = z.object({
  trackingNumber: z.string().trim().min(4, 'Enter the tracking number').max(120),
  carrierCode: carrierCode.default('manual'),
  orderReference: z.string().trim().max(120).nullable().optional(),
  publicReference: z.string().trim().max(64).nullable().optional(),
  customerName: z.string().trim().max(160).nullable().optional(),
  customerEmail: emailSchema.nullable().optional(),
  destinationCountry: countryCode.nullable().optional(),
  shippedAt: isoDate.nullable().optional(),
  estimatedDeliveryAt: isoDate.nullable().optional(),
  internalNotes: z.string().trim().max(4000).nullable().optional(),
});

export const updateShipmentSchema = z
  .object({
    carrierCode: carrierCode.optional(),
    orderReference: z.string().trim().max(120).nullable().optional(),
    publicReference: z.string().trim().max(64).nullable().optional(),
    customerName: z.string().trim().max(160).nullable().optional(),
    customerEmail: emailSchema.nullable().optional(),
    destinationCountry: countryCode.nullable().optional(),
    shippedAt: isoDate.nullable().optional(),
    estimatedDeliveryAt: isoDate.nullable().optional(),
    internalNotes: z.string().trim().max(4000).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Provide at least one field to update' });

export const shipmentListQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(120).optional(),
  status: z.enum(['all', ...SHIPMENT_STATUSES]).default('all'),
  carrierCode: z.string().trim().max(32).optional(),
  destinationCountry: countryCode.optional(),
  hasException: z.coerce.boolean().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  sort: z
    .enum(['last_event_at', 'shipped_at', 'estimated_delivery_at', 'tracking_number', 'created_at'])
    .default('last_event_at'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export const archiveShipmentSchema = z.object({
  archived: z.boolean(),
  reason: z.string().trim().max(300).optional(),
});

export const manualEventSchema = z.object({
  eventCode: z
    .string()
    .trim()
    .min(2, 'Enter the carrier event code')
    .max(64)
    .regex(/^[A-Za-z0-9_ -]+$/, 'Use letters, numbers, spaces, dashes or underscores'),
  description: z.string().trim().min(2, 'Describe what happened').max(500),
  locationText: z.string().trim().max(160).nullable().optional(),
  occurredAt: isoDate,
  isCustomerVisible: z.boolean().default(true),
});

/* -------------------------------------------------------------------------- */
/* Exceptions                                                                 */
/* -------------------------------------------------------------------------- */

export const exceptionListQuerySchema = paginationSchema.extend({
  status: z.enum(['all', 'open', 'acknowledged', 'resolved', 'dismissed']).default('open'),
  type: z.enum(['all', ...EXCEPTION_TYPES]).default('all'),
  severity: z.enum(['all', ...EXCEPTION_SEVERITIES]).default('all'),
  shipmentId: uuid.optional(),
  assignedToMe: z.coerce.boolean().optional(),
});

export const createExceptionSchema = z.object({
  shipmentId: uuid,
  type: z.enum(EXCEPTION_TYPES),
  severity: z.enum(EXCEPTION_SEVERITIES).default('medium'),
  detail: z.string().trim().max(1000).nullable().optional(),
});

export const assignExceptionSchema = z.object({
  assignedUserId: uuid.nullable(),
});

export const exceptionCommentSchema = z.object({
  comment: z.string().trim().min(1, 'Write a comment').max(2000),
  visibility: z.enum(['internal', 'customer']).default('internal'),
});

export const resolveExceptionSchema = z.object({
  status: z.enum(['resolved', 'dismissed']).default('resolved'),
  reason: z.string().trim().min(3, 'Give a reason').max(500),
});

/* -------------------------------------------------------------------------- */
/* Imports                                                                    */
/* -------------------------------------------------------------------------- */

export const importPreviewSchema = z.object({
  filename: z.string().trim().min(1).max(200),
  content: z.string().min(1, 'Paste the CSV content').max(5 * 1024 * 1024),
  mapping: z.record(z.string(), z.string().trim().min(1).max(64)).default({}),
});

export const importCommitSchema = importPreviewSchema.extend({
  confirm: z.literal(true, { errorMap: () => ({ message: 'Confirm the import before committing' }) }),
});

/* -------------------------------------------------------------------------- */
/* Integrations and notifications                                             */
/* -------------------------------------------------------------------------- */

export const carrierIntegrationSchema = z.object({
  carrierCode: carrierCode,
  credentials: z.record(z.string(), z.string().max(2000)).default({}),
  enabled: z.boolean().default(true),
});

export const notificationRuleSchema = z.object({
  eventType: z.enum(NOTIFICATION_EVENT_TYPES),
  enabled: z.boolean(),
  templateId: z.string().trim().min(1).max(64),
  cooldownMinutes: z.coerce.number().int().min(0).max(10_080),
});

export const updateNotificationRulesSchema = z.object({
  rules: z.array(notificationRuleSchema).min(1).max(20),
});

/* -------------------------------------------------------------------------- */
/* Reports and exports                                                        */
/* -------------------------------------------------------------------------- */

export const deliveryReportQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  carrierCode: z.string().trim().max(32).optional(),
});

export const exportShipmentsSchema = z.object({
  includeCustomerEmail: z.boolean().default(false),
});

export const schemaCatalog = {
  register: registerSchema,
  login: loginSchema,
  createOrganization: createOrganizationSchema,
  createShipment: createShipmentSchema,
  updateShipment: updateShipmentSchema,
  manualEvent: manualEventSchema,
  resolveException: resolveExceptionSchema,
};