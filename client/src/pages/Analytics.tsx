/**
 * Delivery analytics (C3.9).
 *
 * Sample sizes and warnings are always shown. Carriers are never ranked,
 * because a comparison here would be misleading.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { CARRIER_CATALOGUE } from '@shipcheck/shared';

import { api } from '../lib/api';
import { todayIso } from '../lib/format';
import { useSession } from '../lib/session';
import {
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  PageHeader,
  Select,
} from '../components/ui';
import { BarChart, MetricCard, ProportionBars } from '../components/patterns';

interface DeliveryReport {
  range: { from: string; to: string };
  outcomes: Array<{ status: string; label: string; count: number; share: number }>;
  totalShipments: number;
  averageTransitHoursByCarrier: Array<{
    carrierCode: string;
    carrierName: string;
    sampleSize: number;
    averageHours: number;
  }>;
  exceptionsByCarrier: Array<{
    carrierCode: string;
    carrierName: string;
    total: number;
    critical: number;
  }>;
  delayAging: Array<{ bucket: string; label: string; count: number; averageHours: number }>;
  warnings: string[];
}

export function AnalyticsPage() {
  const { activeOrganizationId } = useSession();
  const [from, setFrom] = useState(`${todayIso().slice(0, 4)}-01-01`);
  const [to, setTo] = useState(todayIso());
  const [carrierCode, setCarrierCode] = useState('');

  const report = useQuery({
    queryKey: ['shipcheck', activeOrganizationId, 'delivery', from, to, carrierCode],
    queryFn: () =>
      api.get<DeliveryReport>(
        `/${activeOrganizationId}/reports/delivery?${new URLSearchParams({
          from,
          to,
          ...(carrierCode ? { carrierCode } : {}),
        })}`,
      ),
    enabled: Boolean(activeOrganizationId),
  });

  const data = report.data;
  const delivered = data?.outcomes.find((row) => row.status === 'delivered')?.count ?? 0;

  return (
    <>
      <PageHeader
        title="Analytics"
        description="What your recorded shipment data shows, with the limits of that data made explicit."
      />

      <Card className="mb-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="From">
            {({ id }) => (
              <Input id={id} type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
            )}
          </Field>
          <Field label="To">
            {({ id }) => (
              <Input id={id} type="date" value={to} onChange={(event) => setTo(event.target.value)} />
            )}
          </Field>
          <Field label="Carrier">
            {({ id }) => (
              <Select id={id} value={carrierCode} onChange={(event) => setCarrierCode(event.target.value)}>
                <option value="">All carriers</option>
                {CARRIER_CATALOGUE.map((carrier) => (
                  <option key={carrier.code} value={carrier.code}>
                    {carrier.displayName}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      </Card>

      {report.isError ? (
        <Card>
          <ErrorState message="Could not load the delivery report." onRetry={() => void report.refetch()} />
        </Card>
      ) : null}

      {data ? (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              label="Shipments in range"
              value={data.totalShipments}
              hint={`${data.range.from} to ${data.range.to}`}
            />
            <MetricCard
              label="Delivered"
              value={delivered}
              hint={
                data.totalShipments > 0
                  ? `${Math.round((delivered / data.totalShipments) * 100)}% of shipments in range`
                  : 'No shipments in range'
              }
            />
            <MetricCard
              label="Exceptions opened"
              value={data.exceptionsByCarrier.reduce((sum, row) => sum + row.total, 0)}
              hint="Raised in this window."
            />
            <MetricCard
              label="Critical exceptions"
              value={data.exceptionsByCarrier.reduce((sum, row) => sum + row.critical, 0)}
              hint="Highest severity."
            />
          </div>

          <Card title="Read this before using the numbers">
            <ul className="list-disc space-y-1 pl-5 text-[13px] text-ink-muted">
              {data.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Outcome mix">
              <ProportionBars
                data={data.outcomes
                  .filter((row) => row.count > 0)
                  .map((row) => ({ label: row.label, value: row.count }))}
                emptyMessage="No shipments in this range."
                valueLabel="shipments"
              />
            </Card>

            <Card title="Shipments created per day">
              <BarChart
                label="Shipments created per day"
                emptyMessage="No shipments in this range."
                data={data.outcomes.map((row) => ({ label: row.label, value: row.count }))}
              />
            </Card>
          </div>

          <Card
            title="Average transit time"
            description="Only shipments with both a ship date and a delivery date are included. Small samples are not comparable."
          >
            {data.averageTransitHoursByCarrier.length === 0 ? (
              <EmptyState
                title="No delivered shipments"
                description="Transit time needs a ship date and a delivery date. Nothing in this range has both."
              />
            ) : (
              <table className="w-full text-left text-[13px]">
                <caption className="sr-only">Average transit hours by carrier</caption>
                <thead>
                  <tr className="border-b border-line text-xs text-ink-muted uppercase">
                    <th scope="col" className="py-2 font-semibold">Carrier</th>
                    <th scope="col" className="py-2 text-right font-semibold">Sample size</th>
                    <th scope="col" className="py-2 text-right font-semibold">Average hours</th>
                  </tr>
                </thead>
                <tbody>
                  {data.averageTransitHoursByCarrier.map((row) => (
                    <tr key={row.carrierCode} className="border-b border-line last:border-0">
                      <td className="py-2 text-ink">{row.carrierName}</td>
                      <td className="tabular py-2 text-right">{row.sampleSize}</td>
                      <td className="tabular py-2 text-right">
                        {row.averageHours}
                        {row.sampleSize < 5 ? (
                          <span className="ml-2 text-xs text-ink-subtle">too small to compare</span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card title="Exception time to resolution">
            <ProportionBars
              data={data.delayAging.map((row) => ({
                label: row.label,
                value: row.count,
                detail: row.count > 0 ? `Average ${row.averageHours}h` : undefined,
              }))}
              emptyMessage="No exceptions were opened in this range."
              valueLabel="exceptions"
            />
          </Card>
        </div>
      ) : null}
    </>
  );
}