/** API contract types (Part A / A7). */

import type {
  ExceptionSeverity,
  ExceptionStatus,
  ExceptionType,
  ShipmentStatus,
} from './constants.js';

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNPROCESSABLE'
  | 'RATE_LIMITED'
  | 'INTEGRATION_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export interface ApiFieldIssue {
  path: string;
  message: string;
}

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    fields?: Record<string, string[]>;
    issues?: ApiFieldIssue[];
    requestId: string;
  };
}

export interface SessionUser {
  id: string;
  email: string;
  displayName: string | null;
  createdAt: string;
}

export interface MembershipSummary {
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  baseCurrency: string;
  timezone: string;
  role: string;
  permissions: string[];
}

export interface AuthSessionResponse {
  user: SessionUser;
  memberships: MembershipSummary[];
  activeOrganizationId: string | null;
}

export interface ShipmentListItem {
  id: string;
  trackingNumber: string;
  carrierCode: string;
  carrierName: string;
  orderReference: string | null;
  publicReference: string | null;
  customerName: string | null;
  destinationCountry: string | null;
  status: ShipmentStatus;
  /** Carrier status is stored separately from the internally derived status. */
  lastCarrierStatus: ShipmentStatus | null;
  derivedStatus: ShipmentStatus;
  lastEventAt: string | null;
  lastEventDescription: string | null;
  shippedAt: string | null;
  estimatedDeliveryAt: string | null;
  deliveredAt: string | null;
  openExceptionCount: number;
  lastPolledAt: string | null;
  createdAt: string;
}

export interface TrackingEventView {
  id: string;
  eventCode: string;
  normalizedStatus: ShipmentStatus;
  description: string;
  locationText: string | null;
  /** Event time reported by the source; may arrive out of order. */
  eventAt: string;
  /** Time ShipCheck received it. */
  receivedAt: string;
  source: 'carrier' | 'manual' | 'import';
  providerEventId: string | null;
  isCustomerVisible: boolean;
}

export interface ShipmentExceptionView {
  id: string;
  shipmentId: string;
  trackingNumber: string;
  customerName: string | null;
  type: ExceptionType;
  typeLabel: string;
  severity: ExceptionSeverity;
  status: ExceptionStatus;
  detail: string | null;
  assignedUserId: string | null;
  assignedUserName: string | null;
  openedAt: string;
  resolvedAt: string | null;
  resolutionReason: string | null;
  ageHours: number;
  lastEventAt: string | null;
}