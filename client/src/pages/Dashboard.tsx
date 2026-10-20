/**
 * Operations dashboard (Part C / C3.1).
 *
 * Every number comes from recorded shipment and event data. Nothing is
 * estimated and no carrier comparison is presented as a ranking.
 */

import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import { SHIPMENT_STATUSES, SHIPMENT_STATUS_LABELS } from '@shipcheck/shared';

import { api } from '../lib/api';
import { formatDateTime, relativeTime } from '../lib/format';
import { useSession } from '../lib/session';
import { Card, EmptyState, ErrorState, PageHeader, TableSkeleton } from '../components/ui';
import {
  ExceptionTypeLabel,
  MetricCard,
  ProportionBars,
  SeverityBadge,
  ShipmentStatusBadge,
} from '../components/patterns';

interface DashboardResponse {
  generatedAt: string;
  range: { from: string; to: string };
  counts: Record<string, number>;
  totals: number;
  openExceptions: number;
  untrackedWithoutCarrier: number;
  staleShipments: number;
  recentExceptions: Array<{
    id: string;
    trackingNumber: string;
    type: string;
    severity: string;
    openedAt: string;
  }>;
  oldestOpenExceptionHours: number;
  carrierBreakdown: Array<{ carrierCode: string; carrierName: string; count: number; exceptions: number }>;
  agingList: Array<{
    shipmentId: string;
    trackingNumber: string;
    customerName: string | null;
    carrierCode: string;
    status: string;
    lastEventAt: string | null;
    ageHours: number;
    openExceptions: number;
  }>;
  definitions: Record<string, string>;
}

export function DashboardPage() {
  const { activeOrganizationId } = useSession();

  const dashboard = useQuery({
    queryKey: ['shipcheck', activeOrganizationId, 'dashboard'],
    queryFn: () => api.get<DashboardResponse>(`/${activeOrganizationId}/dashboard`),
    enabled: Boolean(activeOrganizationId),
  });

  if (dashboard.isError) {
    return (
      <>
        <PageHeader title="Dashboard" />
        <Card>
          <ErrorState
            message={dashboard.error instanceof Error ? dashboard.error.message : 'Could not load the dashboard.'}
            onRetry={() => void dashboard.refetch()}
          />
        </Card>
      </>
    );
  }

  const data = dashboard.data;

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={
          data
            ? `Live shipments recorded for this workspace, as of ${formatDateTime(data.generatedAt)}.`
            : 'Loading the current shipment picture…'
        }
      />

      <div className="space-y-4">
        {dashboard.isLoading || !data ? (
          <TableSkeleton rows={4} columns={4} />
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <MetricCard
                label="Shipments tracked"
                value={data.totals}
                hint="Not archived."
                footer={
                  <Link to={`/${activeOrganizationId}/shipments`} className="text-[13px] text-brand-700 underline">
                    View all shipments
                  </Link>
                }
              />
              <MetricCard
                label="Open exceptions"
                value={data.openExceptions}
                hint={
                  data.oldestOpenExceptionHours > 0
                    ? `Oldest open for ${Math.round(data.oldestOpenExceptionHours)}h.`
                    : 'Nothing open.'
                }
                footer={
                  <Link to={`/${activeOrganizationId}/exceptions`} className="text-[13px] text-brand-700 underline">
                    Work the queue
                  </Link>
                }
              />
              <MetricCard
                label="No carrier data"
                value={data.untrackedWithoutCarrier}
                hint="Awaiting first carrier event. Not an error."
              />
              <MetricCard
                label="Stalled"
                value={data.staleShipments}
                hint={`No meaningful event for ${72}h or more.`}
              />
            </div>

            <Card title="Shipments by status" description="Counted from the latest recorded event for each shipment.">
              <ProportionBars
                data={SHIPMENT_STATUSES.map((status) => ({
                  label: SHIPMENT_STATUS_LABELS[status],
                  value: data.counts[status] ?? 0,
                  detail:
                    status === 'unknown'
                      ? 'Carrier sent a code ShipCheck does not recognise. It is stored as unknown, never guessed.'
                      : undefined,
                })).filter((entry) => entry.value > 0)}
                emptyMessage="No shipments recorded yet."
                valueLabel="shipments"
              />
            </Card>

            <div className="grid gap-4 lg:grid-cols-2">
              <Card
                title="Recent exceptions"
                description="Newest first."
              >
                {data.recentExceptions.length === 0 ? (
                  <EmptyState
                    title="No exceptions"
                    description="Nothing has been flagged for this workspace."
                  />
                ) : (
                  <ul className="divide-y divide-line">
                    {data.recentExceptions.map((exception) => (
                      <li key={exception.id} className="flex items-center justify-between gap-3 py-2.5">
                        <div className="min-w-0">
                          <Link
                            to={`/${activeOrganizationId}/exceptions/${exception.id}`}
                            className="tabular block truncate text-[13px] font-medium text-ink underline"
                          >
                            {exception.trackingNumber}
                          </Link>
                          <p className="text-xs text-ink-muted">
                            <ExceptionTypeLabel type={exception.type} /> · opened {relativeTime(exception.openedAt)}
                          </p>
                        </div>
                        <SeverityBadge severity={exception.severity} />
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              <Card
                title="Shipments by carrier"
                description="A count of what you track. This is not a performance ranking."
              >
                {data.carrierBreakdown.length === 0 ? (
                  <EmptyState title="No carriers yet" description="Add a shipment to see the breakdown." />
                ) : (
                  <table className="w-full text-left text-[13px]">
                    <caption className="sr-only">Shipment and exception counts per carrier</caption>
                    <thead>
                      <tr className="border-b border-line text-xs text-ink-muted uppercase">
                        <th scope="col" className="py-2 font-semibold">Carrier</th>
                        <th scope="col" className="py-2 text-right font-semibold">Shipments</th>
                        <th scope="col" className="py-2 text-right font-semibold">Exceptions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.carrierBreakdown.map((row) => (
                        <tr key={row.carrierCode} className="border-b border-line last:border-0">
                          <td className="py-2 text-ink">{row.carrierName}</td>
                          <td className="tabular py-2 text-right">{row.count}</td>
                          <td className="tabular py-2 text-right">{row.exceptions}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
            </div>

            <Card
              title="Shipments with no recent activity"
              description="Ordered by how long they have been quiet. A quiet shipment is not automatically lost."
            >
              {data.agingList.length === 0 ? (
                <EmptyState title="Everything is moving" description="No shipment is currently stalled." />
              ) : (
                <table className="w-full text-left text-[13px]">
                  <caption className="sr-only">Shipments with the longest time since their last event</caption>
                  <thead>
                    <tr className="border-b border-line text-xs text-ink-muted uppercase">
                      <th scope="col" className="py-2 font-semibold">Tracking number</th>
                      <th scope="col" className="py-2 font-semibold">Customer</th>
                      <th scope="col" className="py-2 font-semibold">Status</th>
                      <th scope="col" className="py-2 font-semibold">Last event</th>
                      <th scope="col" className="py-2 text-right font-semibold">Quiet for</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.agingList.map((row) => (
                      <tr key={row.shipmentId} className="border-b border-line last:border-0">
                        <td className="tabular py-2">
                          <Link
                            to={`/${activeOrganizationId}/shipments/${row.shipmentId}`}
                            className="text-ink underline"
                          >
                            {row.trackingNumber}
                          </Link>
                        </td>
                        <td className="py-2 text-ink-muted">{row.customerName ?? '—'}</td>
                        <td className="py-2"><ShipmentStatusBadge status={row.status} /></td>
                        <td className="py-2 text-ink-muted">{formatDateTime(row.lastEventAt)}</td>
                        <td className="tabular py-2 text-right">{Math.round(row.ageHours)}h</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>

            <Card title="How these numbers are calculated">
              <dl className="space-y-2 text-[13px]">
                {Object.entries(data.definitions).map(([term, description]) => (
                  <div key={term}>
                    <dt className="font-medium text-ink">{term.replace(/_/g, ' ')}</dt>
                    <dd className="text-ink-muted">{description}</dd>
                  </div>
                ))}
              </dl>
            </Card>
          </>
        )}
      </div>
    </>
  );
}