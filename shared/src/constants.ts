/** Domain constants shared by the ShipCheck server and client. */

export const PRODUCT_NAME = 'ShipCheck';

export const ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  viewer: 'Viewer',
};

/** ShipCheck-specific roles map onto the shared permission model (C2). */
export const OPERATIONS_PERMISSIONS = [
  'shipment.create',
  'shipment.edit',
  'shipment.archive',
  'shipment.event.manual',
  'exception.resolve',
  'exception.comment',
  'import.run',
  'report.view',
  'report.export',
  'integration.manage',
  'notification.manage',
  'settings.manage',
  'member.manage',
  'audit.view',
  'ownership.transfer',
  'organization.delete',
] as const;
export type Permission = (typeof OPERATIONS_PERMISSIONS)[number];

const VIEWER: Permission[] = [];
const MEMBER: Permission[] = [
  'shipment.create',
  'shipment.edit',
  'shipment.event.manual',
  'exception.resolve',
  'exception.comment',
  'import.run',
  'report.view',
];
const ADMIN: Permission[] = [
  ...MEMBER,
  'shipment.archive',
  'report.export',
  'integration.manage',
  'notification.manage',
  'settings.manage',
  'member.manage',
  'audit.view',
];

export function permissionsForRole(role: Role): Permission[] {
  switch (role) {
    case 'owner':
      return [...OPERATIONS_PERMISSIONS];
    case 'admin':
      return [...ADMIN];
    case 'member':
      return [...MEMBER];
    case 'viewer':
      return [...VIEWER];
  }
}

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return permissionsForRole(role).includes(permission);
}

/**
 * Normalized shipment status.
 *
 * `unknown` is a real value: an unrecognised carrier code is stored safely and
 * mapped to `unknown`, never guessed (C7).
 */
export const SHIPMENT_STATUSES = [
  'label_created',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'exception',
  'returned_to_sender',
  'unknown',
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

export const SHIPMENT_STATUS_LABELS: Record<ShipmentStatus, string> = {
  label_created: 'Label created',
  in_transit: 'In transit',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  exception: 'Exception',
  returned_to_sender: 'Returned to sender',
  unknown: 'Unknown',
};

/**
 * Precedence for deriving the shipment status from the latest meaningful
 * event. The FIRST rule that matches wins, and it is applied to the event with
 * the greatest `event_at`, not to arrival order (C4 step 7).
 *
 * Every code here is lower-case: `normalizeStatus` lower-cases its input before
 * comparing, so a mixed-case entry would never match.
 */
export const STATUS_PRECEDENCE: ReadonlyArray<{ status: ShipmentStatus; codes: readonly string[] }> = [
  { status: 'delivered', codes: ['delivered', 'delivery_confirmed', 'pod'] },
  { status: 'returned_to_sender', codes: ['returned_to_sender', 'return_to_sender', 'rts'] },
  { status: 'exception', codes: ['failed_delivery', 'delivery_exception', 'address_issue', 'lost', 'damaged'] },
  { status: 'out_for_delivery', codes: ['out_for_delivery', 'with_courier'] },
  { status: 'in_transit', codes: ['in_transit', 'departed', 'arrived', 'processed', 'transferred'] },
  { status: 'label_created', codes: ['label_created', 'shipment_info_received', 'info_received', 'created'] },
];

export function normalizeStatus(eventCode: string): ShipmentStatus {
  const code = eventCode.trim().toLowerCase().replace(/[\s-]+/g, '_');
  for (const rule of STATUS_PRECEDENCE) {
    if (rule.codes.includes(code)) return rule.status;
  }
  return 'unknown';
}

export const EVENT_SOURCES = ['carrier', 'manual', 'import'] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

export const EXCEPTION_TYPES = [
  'stalled',
  'delivery_exception',
  'failed_delivery',
  'address_issue',
  'returned_to_sender',
  'missing_carrier_data',
] as const;
export type ExceptionType = (typeof EXCEPTION_TYPES)[number];

export const EXCEPTION_TYPE_LABELS: Record<ExceptionType, string> = {
  stalled: 'Stalled shipment',
  delivery_exception: 'Delivery exception',
  failed_delivery: 'Failed delivery',
  address_issue: 'Address issue',
  returned_to_sender: 'Returned to sender',
  missing_carrier_data: 'Missing carrier data',
};

export const EXCEPTION_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type ExceptionSeverity = (typeof EXCEPTION_SEVERITIES)[number];

export const EXCEPTION_SEVERITY_LABELS: Record<ExceptionSeverity, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
};

export const EXCEPTION_STATUSES = ['open', 'acknowledged', 'resolved', 'dismissed'] as const;
export type ExceptionStatus = (typeof EXCEPTION_STATUSES)[number];

export const EXCEPTION_STATUS_LABELS: Record<ExceptionStatus, string> = {
  open: 'Open',
  acknowledged: 'Acknowledged',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
};

export const COMMENT_VISIBILITIES = ['internal', 'customer'] as const;
export type CommentVisibility = (typeof COMMENT_VISIBILITIES)[number];

export const NOTIFICATION_EVENT_TYPES = [
  'shipment_created',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'exception',
] as const;
export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];

export const NOTIFICATION_LOG_STATUSES = ['queued', 'sent', 'failed', 'skipped'] as const;
export type NotificationLogStatus = (typeof NOTIFICATION_LOG_STATUSES)[number];

/**
 * Carrier codes ShipCheck knows about as a *catalogue* only. Having a row here
 * does NOT mean an integration is connected: the connection status lives on the
 * `carrier_integrations` table and is shown honestly in the UI.
 */
export const CARRIER_CATALOGUE: ReadonlyArray<{ code: string; displayName: string }> = [
  { code: 'manual', displayName: 'Manual / unknown carrier' },
  { code: 'dhl', displayName: 'DHL' },
  { code: 'fedex', displayName: 'FedEx' },
  { code: 'ups', displayName: 'UPS' },
  { code: 'usps', displayName: 'USPS' },
  { code: 'royalmail', displayName: 'Royal Mail' },
  { code: 'dpd', displayName: 'DPD' },
  { code: 'gls', displayName: 'GLS' },
];

export const BACKGROUND_JOB_TYPES = [
  'carrier.poll',
  'notifications.dispatch',
  'exceptions.scan',
  'maintenance.cleanup',
] as const;

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

/** CSV import limits (C4). */
export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
export const IMPORT_MAX_ROWS = 5000;

/** A stalled shipment is one with no meaningful event for this many hours. */
export const STALLED_AFTER_HOURS = 72;