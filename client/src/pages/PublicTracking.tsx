/**
 * Public tracking page (C3.6).
 *
 * Shows only what the sender chose to expose. It never leaks internal notes,
 * customer email, the tracking number or any exception detail.
 */

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';

import { api } from '../lib/api';
import { formatDate, formatDateTime } from '../lib/format';
import { Card, ErrorState } from '../components/ui';
import { ShipmentStatusBadge } from '../components/patterns';

interface PublicTracking {
  sender: string;
  shipment: {
    publicReference: string | null;
    carrier: string;
    status: string;
    statusLabel: string;
    shippedAt: string | null;
    estimatedDeliveryAt: string | null;
    deliveredAt: string | null;
    lastUpdatedAt: string;
    estimateSource: string;
  };
  events: Array<{
    eventCode: string;
    status: string;
    description: string;
    locationText: string | null;
    occurredAt: string;
    source: string;
  }>;
  attention: string | null;
  disclaimer: string;
}

export function PublicTrackingPage() {
  const { token = '' } = useParams();

  const tracking = useQuery({
    queryKey: ['shipcheck', 'public-tracking', token],
    queryFn: () => api.get<PublicTracking>(`/public/tracking/${token}`),
    retry: false,
    enabled: token.length > 0,
  });

  return (
    <div className="min-h-screen bg-surface-sunken px-4 py-10">
      <div className="mx-auto w-full max-w-2xl space-y-4">
        <header>
          <p className="text-[13px] font-medium text-ink-muted">Shipment tracking</p>
          <h1 className="text-xl font-semibold text-ink">
            {tracking.data?.sender ?? 'Tracking'}
          </h1>
        </header>

        {tracking.isLoading ? (
          <Card>Loading tracking information…</Card>
        ) : null}

        {tracking.isError ? (
          <Card>
            <ErrorState
              title="This tracking link is not available"
              message="The link may have been revoked, or it may never have existed. Ask the sender for a new link."
            />
          </Card>
        ) : null}

        {tracking.data ? (
          <>
            <Card>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-xs text-ink-muted">Current status</p>
                  <p className="mt-1">
                    <ShipmentStatusBadge status={tracking.data.shipment.status} />
                  </p>
                </div>
                {tracking.data.shipment.publicReference ? (
                  <div className="text-right">
                    <p className="text-xs text-ink-muted">Your reference</p>
                    <p className="tabular mt-1 text-[13px] text-ink">
                      {tracking.data.shipment.publicReference}
                    </p>
                  </div>
                ) : null}
              </div>

              <dl className="mt-4 grid gap-3 text-[13px] sm:grid-cols-3">
                <div>
                  <dt className="text-ink-muted">Carrier</dt>
                  <dd className="text-ink">{tracking.data.shipment.carrier}</dd>
                </div>
                <div>
                  <dt className="text-ink-muted">Shipped</dt>
                  <dd className="tabular text-ink">{formatDate(tracking.data.shipment.shippedAt)}</dd>
                </div>
                <div>
                  <dt className="text-ink-muted">Delivered</dt>
                  <dd className="tabular text-ink">{formatDate(tracking.data.shipment.deliveredAt)}</dd>
                </div>
              </dl>

              {tracking.data.shipment.estimatedDeliveryAt && !tracking.data.shipment.deliveredAt ? (
                <p className="mt-4 rounded-lg border border-line bg-surface-sunken px-3 py-2 text-[13px] text-ink">
                  Estimated delivery:{' '}
                  <strong>{formatDate(tracking.data.shipment.estimatedDeliveryAt)}</strong>
                  <span className="block text-xs text-ink-muted">
                    {tracking.data.shipment.estimateSource}
                  </span>
                </p>
              ) : null}

              {tracking.data.attention ? (
                <p className="mt-3 rounded-lg border border-line bg-surface-sunken px-3 py-2 text-[13px] text-ink">
                  {tracking.data.attention}
                </p>
              ) : null}
            </Card>

            <Card title="Tracking history">
              {tracking.data.events.length === 0 ? (
                <p className="text-[13px] text-ink-muted">No tracking events yet.</p>
              ) : (
                <ol className="space-y-3">
                  {tracking.data.events.map((event, index) => (
                    <li key={`${event.eventCode}-${event.occurredAt}-${index}`} className="flex gap-3">
                      <div className="flex flex-col items-center">
                        <span
                          className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full bg-brand-500"
                          aria-hidden="true"
                        />
                        {index < tracking.data!.events.length - 1 ? (
                          <span className="w-px flex-1 bg-line" aria-hidden="true" />
                        ) : null}
                      </div>
                      <div className="min-w-0 flex-1 pb-2">
                        <p className="text-[13px] font-medium text-ink">{event.description}</p>
                        <p className="tabular mt-0.5 text-xs text-ink-muted">
                          {event.locationText ? `${event.locationText} · ` : ''}
                          {formatDateTime(event.occurredAt)}
                        </p>
                        <p className="text-[11px] text-ink-subtle">{event.source}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </Card>

            <p className="px-1 text-xs text-ink-subtle">
              {tracking.data.disclaimer} Last updated{' '}
              {formatDateTime(tracking.data.shipment.lastUpdatedAt)}.
            </p>
          </>
        ) : null}
      </div>
    </div>
  );
}