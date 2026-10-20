/**
 * Shipment detail: the full event timeline, exceptions and the honest state of
 * the carrier connection for this shipment (C3.3).
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';

import {
  manualEventSchema,
} from '@shipcheck/shared';

import { api, ApiError } from '../lib/api';
import { formatDateTime, relativeTime, todayIso } from '../lib/format';
import { usePermission, useSession } from '../lib/session';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  PageHeader,
} from '../components/ui';
import {
  ActivityTimeline,
  CopyButton,
  ExceptionStatusBadge,
  ExceptionTypeLabel,
  SeverityBadge,
  ShipmentStatusBadge,
} from '../components/patterns';

interface ShipmentDetail {
  shipment: {
    id: string;
    trackingNumber: string;
    carrierCode: string;
    carrierName: string;
    orderReference: string | null;
    publicReference: string | null;
    customerName: string | null;
    customerEmail: string | null;
    destinationCountry: string | null;
    internalNotes: string | null;
    status: string;
    lastCarrierStatus: string | null;
    derivedStatus: string;
    shippedAt: string | null;
    estimatedDeliveryAt: string | null;
    deliveredAt: string | null;
    lastEventAt: string | null;
    lastPolledAt: string | null;
    publicLinkActive: boolean;
    archivedAt: string | null;
    createdAt: string;
  };
  events: Array<{
    id: string;
    eventCode: string;
    normalizedStatus: string;
    description: string;
    locationText: string | null;
    eventAt: string;
    receivedAt: string;
    source: 'carrier' | 'manual' | 'import';
    providerEventId: string | null;
    isCustomerVisible: boolean;
  }>;
  exceptions: Array<{
    id: string;
    type: string;
    severity: string;
    status: string;
    detail: string | null;
    openedAt: string;
    resolvedAt: string | null;
    resolutionReason: string | null;
  }>;
  timeline: Array<{ id: string; action: string; actorEmail: string | null; createdAt: string; metadata: unknown }>;
}

export function ShipmentDetailPage() {
  const { shipmentId = '' } = useParams();
  const location = useLocation();
  const { activeOrganizationId } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const canAddEvent = usePermission('shipment.event.manual');
  const canArchive = usePermission('shipment.archive');

  const [eventForm, setEventForm] = useState({
    eventCode: '',
    description: '',
    locationText: '',
    occurredAt: todayIso(),
    isCustomerVisible: true,
  });
  const [eventErrors, setEventErrors] = useState<Record<string, string[]>>({});
  /** Only ever populated by create/rotate: the token is not stored in clear. */
  const [issuedUrl, setIssuedUrl] = useState<string | null>(
    typeof location.state === 'object' && location.state !== null
      ? ((location.state as { publicUrl?: string }).publicUrl ?? null)
      : null,
  );

  const detail = useQuery({
    queryKey: ['shipcheck', activeOrganizationId, 'shipment', shipmentId],
    queryFn: () =>
      api.get<ShipmentDetail>(`/${activeOrganizationId}/shipments/${shipmentId}`),
    enabled: Boolean(activeOrganizationId && shipmentId),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['shipcheck', activeOrganizationId] });
  };

  const addEvent = useMutation({
    mutationFn: async () => {
      const parsed = manualEventSchema.safeParse(eventForm);
      if (!parsed.success) {
        setEventErrors(
          Object.fromEntries(parsed.error.issues.map((issue) => [issue.path.join('.'), [issue.message]])),
        );
        throw new ApiError(400, {
          error: { code: 'VALIDATION_ERROR', message: 'Check the event fields.', requestId: '' },
        }, 'Check the event fields.');
      }
      return api.post(`/${activeOrganizationId}/shipments/${shipmentId}/events/manual`, parsed.data);
    },
    onSuccess: () => {
      setEventForm({ ...eventForm, eventCode: '', description: '', locationText: '' });
      setEventErrors({});
      invalidate();
    },
  });

  const archive = useMutation({
    mutationFn: (archived: boolean) =>
      api.post(`/${activeOrganizationId}/shipments/${shipmentId}/archive`, {
        archived,
        reason: archived ? 'Archived from the shipment page' : undefined,
      }),
    onSuccess: invalidate,
  });

  const rotateLink = useMutation({
    mutationFn: () =>
      api.post<{ publicUrl: string }>(`/${activeOrganizationId}/shipments/${shipmentId}/public-link/rotate`),
    onSuccess: (data) => {
      setIssuedUrl(data.publicUrl);
      invalidate();
    },
  });

  const revokeLink = useMutation({
    mutationFn: () => api.post(`/${activeOrganizationId}/shipments/${shipmentId}/public-link/revoke`),
    onSuccess: invalidate,
  });

  if (detail.isLoading) {
    return (
      <>
        <PageHeader title="Shipment" />
        <Card>Loading…</Card>
      </>
    );
  }

  if (detail.isError || !detail.data) {
    return (
      <>
        <PageHeader title="Shipment" />
        <Card>
          <ErrorState
            message="This shipment could not be loaded. It may belong to another workspace, or have been deleted."
            onRetry={() => void detail.refetch()}
          />
        </Card>
      </>
    );
  }

  const { shipment, events, exceptions, timeline } = detail.data;

  return (
    <>
      <PageHeader
        title={shipment.trackingNumber}
        description={`${shipment.carrierName} · added ${formatDateTime(shipment.createdAt)}`}
        actions={
          <>
            <Button variant="ghost" onClick={() => navigate(`/${activeOrganizationId}/shipments`)}>
              Back
            </Button>
            {canArchive && !shipment.archivedAt ? (
              <Button
                variant="secondary"
                loading={archive.isPending}
                onClick={() => archive.mutate(true)}
              >
                Archive
              </Button>
            ) : null}
          </>
        }
      />

      {shipment.archivedAt ? (
        <p className="mb-4 rounded-lg border border-line bg-surface-sunken px-3 py-2 text-[13px] text-ink-muted">
          This shipment was archived on {formatDateTime(shipment.archivedAt)}. Its history is kept and remains readable.
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title="Tracking events" description="Newest first. Events can arrive out of order; the status is derived from the most recent event time.">
            {events.length === 0 ? (
              <EmptyState title="No events" description="No tracking event has been recorded yet." />
            ) : (
              <ol className="space-y-0">
                {events.map((event, index) => (
                  <li key={event.id} className="flex gap-3">
                    <div className="flex flex-col items-center">
                      <span
                        className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full bg-brand-500"
                        aria-hidden="true"
                      />
                      {index < events.length - 1 ? (
                        <span className="w-px flex-1 bg-line" aria-hidden="true" />
                      ) : null}
                    </div>
                    <div className="min-w-0 flex-1 pb-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[13px] font-medium text-ink">{event.description}</span>
                        <ShipmentStatusBadge status={event.normalizedStatus} />
                        {event.source !== 'carrier' ? (
                          <span className="rounded bg-surface-sunken px-1.5 py-0.5 text-[11px] font-medium text-ink-muted uppercase">
                            {event.source}
                          </span>
                        ) : null}
                        {!event.isCustomerVisible ? (
                          <span className="rounded bg-surface-sunken px-1.5 py-0.5 text-[11px] font-medium text-ink-muted uppercase">
                            internal
                          </span>
                        ) : null}
                      </div>
                      <p className="tabular mt-0.5 text-xs text-ink-muted">
                        {event.eventCode}
                        {event.locationText ? ` · ${event.locationText}` : ''} ·{' '}
                        {formatDateTime(event.eventAt)}
                      </p>
                      <p className="text-[11px] text-ink-subtle">
                        received {relativeTime(event.receivedAt)}
                        {event.providerEventId ? ` · provider id ${event.providerEventId}` : ''}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </Card>

          {canAddEvent && !shipment.archivedAt ? (
            <Card
              title="Add a manual event"
              description="Use this when you learn something the carrier has not sent. Manual events are labelled and never presented as carrier-confirmed."
            >
              <form
                className="space-y-4"
                noValidate
                onSubmit={(event) => {
                  event.preventDefault();
                  addEvent.mutate();
                }}
              >
                {addEvent.error instanceof ApiError ? (
                  <p role="alert" className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-[color:var(--color-danger)]">
                    {addEvent.error.message}
                  </p>
                ) : null}
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Event code" required error={eventErrors.eventCode?.[0]} hint="For example departed, delivered, address_issue.">
                    {({ id, describedBy, invalid }) => (
                      <Input
                        id={id}
                        aria-describedby={describedBy}
                        invalid={invalid}
                        value={eventForm.eventCode}
                        onChange={(event) => setEventForm({ ...eventForm, eventCode: event.target.value })}
                        required
                      />
                    )}
                  </Field>
                  <Field label="Occurred on" required error={eventErrors.occurredAt?.[0]}>
                    {({ id, describedBy, invalid }) => (
                      <Input
                        id={id}
                        type="date"
                        aria-describedby={describedBy}
                        invalid={invalid}
                        value={eventForm.occurredAt}
                        onChange={(event) => setEventForm({ ...eventForm, occurredAt: event.target.value })}
                        required
                      />
                    )}
                  </Field>
                </div>
                <Field label="Description" required error={eventErrors.description?.[0]}>
                  {({ id, describedBy, invalid }) => (
                    <Input
                      id={id}
                      aria-describedby={describedBy}
                      invalid={invalid}
                      value={eventForm.description}
                      onChange={(event) => setEventForm({ ...eventForm, description: event.target.value })}
                      required
                    />
                  )}
                </Field>
                <Field label="Location" error={eventErrors.locationText?.[0]}>
                  {({ id, describedBy, invalid }) => (
                    <Input
                      id={id}
                      aria-describedby={describedBy}
                      invalid={invalid}
                      value={eventForm.locationText}
                      onChange={(event) => setEventForm({ ...eventForm, locationText: event.target.value })}
                    />
                  )}
                </Field>
                <label className="flex items-center gap-2 text-[13px] text-ink">
                  <input
                    type="checkbox"
                    checked={eventForm.isCustomerVisible}
                    onChange={(event) => setEventForm({ ...eventForm, isCustomerVisible: event.target.checked })}
                  />
                  Show this event on the public tracking page
                </label>
                <Button type="submit" variant="primary" loading={addEvent.isPending}>
                  Add event
                </Button>
              </form>
            </Card>
          ) : null}

          <Card title="Exceptions" description="Problems ShipCheck raised against this shipment.">
            {exceptions.length === 0 ? (
              <EmptyState title="No exceptions" description="Nothing has been flagged for this shipment." />
            ) : (
              <ul className="divide-y divide-line">
                {exceptions.map((exception) => (
                  <li key={exception.id} className="flex items-start justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <Link
                        to={`/${activeOrganizationId}/exceptions/${exception.id}`}
                        className="text-[13px] font-medium text-ink underline"
                      >
                        <ExceptionTypeLabel type={exception.type} />
                      </Link>
                      {exception.detail ? (
                        <p className="text-xs text-ink-muted">{exception.detail}</p>
                      ) : null}
                      <p className="text-[11px] text-ink-subtle">
                        opened {relativeTime(exception.openedAt)}
                        {exception.resolvedAt ? ` · resolved ${relativeTime(exception.resolvedAt)}` : ''}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <SeverityBadge severity={exception.severity} />
                      <ExceptionStatusBadge status={exception.status} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <ActivityTimeline
            title="Activity"
            events={timeline.map((entry) => ({
              id: entry.id,
              title: entry.action.replace(/[._]/g, ' '),
              detail: entry.actorEmail ?? 'system',
              at: entry.createdAt,
            }))}
          />
        </div>

        <div className="space-y-4">
          <Card title="Summary">
            <dl className="space-y-2 text-[13px]">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-ink-muted">Derived status</dt>
                <dd><ShipmentStatusBadge status={shipment.derivedStatus} /></dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-ink-muted">Carrier reported</dt>
                <dd>
                  {shipment.lastCarrierStatus ? (
                    <ShipmentStatusBadge status={shipment.lastCarrierStatus} />
                  ) : (
                    <span className="text-ink-subtle">No carrier data yet</span>
                  )}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-ink-muted">Last carrier poll</dt>
                <dd className="tabular">{formatDateTime(shipment.lastPolledAt)}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-ink-muted">Last event</dt>
                <dd className="tabular">{formatDateTime(shipment.lastEventAt)}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-ink-muted">Shipped</dt>
                <dd className="tabular">{formatDateTime(shipment.shippedAt)}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-ink-muted">Estimated delivery</dt>
                <dd className="tabular">{formatDateTime(shipment.estimatedDeliveryAt)}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-ink-muted">Delivered</dt>
                <dd className="tabular">{formatDateTime(shipment.deliveredAt)}</dd>
              </div>
            </dl>
            <p className="mt-3 text-xs text-ink-subtle">
              The estimated delivery date is your own estimate. It is not a carrier commitment.
            </p>
          </Card>

          <Card title="Customer">
            <dl className="space-y-2 text-[13px]">
              <div>
                <dt className="text-ink-muted">Name</dt>
                <dd className="text-ink">{shipment.customerName ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-ink-muted">Email</dt>
                <dd className="text-ink">{shipment.customerEmail ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-ink-muted">Destination</dt>
                <dd className="text-ink">{shipment.destinationCountry ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-ink-muted">Order reference</dt>
                <dd className="tabular text-ink">{shipment.orderReference ?? '—'}</dd>
              </div>
            </dl>
            {shipment.internalNotes ? (
              <div className="mt-3 rounded-lg border border-line bg-surface-sunken p-3">
                <p className="text-xs font-medium text-ink-muted">Internal notes</p>
                <p className="mt-1 text-[13px] text-ink">{shipment.internalNotes}</p>
                <p className="mt-1 text-[11px] text-ink-subtle">Never shown on a public tracking page.</p>
              </div>
            ) : null}
          </Card>

          <Card title="Public tracking link" description="Read-only. Shows only events marked customer-visible.">
            {issuedUrl ? (
              <>
                <p className="mb-2 rounded-lg border border-line bg-surface-sunken px-3 py-2 text-[13px] text-ink">
                  This is the only time ShipCheck will show the link. Copy it now.
                </p>
                <p className="tabular mb-2 break-all text-xs text-ink-muted">{issuedUrl}</p>
                <div className="flex flex-wrap gap-2">
                  <CopyButton value={issuedUrl} label="Copy link" />
                </div>
              </>
            ) : shipment.publicLinkActive ? (
              <>
                <p className="text-[13px] text-ink-muted">
                  A tracking link is active. ShipCheck stores only a hash of its token, so it
                  cannot show the link again. Rotating issues a new one and immediately
                  invalidates the old one.
                </p>
                <Button
                  className="mt-2"
                  size="sm"
                  variant="secondary"
                  loading={rotateLink.isPending}
                  onClick={() => rotateLink.mutate()}
                >
                  Rotate link
                </Button>
                <Button
                  className="mt-2 ml-2"
                  size="sm"
                  variant="danger"
                  loading={revokeLink.isPending}
                  onClick={() => revokeLink.mutate()}
                >
                  Revoke
                </Button>
              </>
            ) : (
              <>
                <p className="text-[13px] text-ink-muted">
                  This shipment has no active public link.
                </p>
                <Button
                  className="mt-2"
                  size="sm"
                  variant="secondary"
                  loading={rotateLink.isPending}
                  onClick={() => rotateLink.mutate()}
                >
                  Create tracking link
                </Button>
              </>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
