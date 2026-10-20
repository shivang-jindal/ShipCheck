/** Shared screen patterns: DataTable, MetricCard, status badges, charts. */

import type { ReactNode } from 'react';
import { useState } from 'react';

import {
  EXCEPTION_SEVERITIES,
  EXCEPTION_SEVERITY_LABELS,
  EXCEPTION_STATUSES,
  EXCEPTION_STATUS_LABELS,
  EXCEPTION_TYPE_LABELS,
  SHIPMENT_STATUS_LABELS,
  type ExceptionSeverity,
  type ExceptionStatus,
  type ExceptionType,
  type ShipmentStatus,
} from '@shipcheck/shared';

import { classNames, formatDateTime } from '../lib/format';
import { Badge, Button, EmptyState, ErrorState, TableSkeleton, type BadgeTone } from './ui';

/* -------------------------------------------------------------------------- */
/* Status badges                                                              */
/* -------------------------------------------------------------------------- */

const ICONS = {
  clock: <svg className="h-3 w-3" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.8" /><path d="M10 6v4l2.5 1.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>,
  check: <svg className="h-3 w-3" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m4.5 10.5 3.5 3.5 7.5-8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  ban: <svg className="h-3 w-3" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.8" /><path d="m5.5 5.5 9 9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>,
  file: <svg className="h-3 w-3" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M5 2.5h6l4 4v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-14a1 1 0 0 1 1-1Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /></svg>,
  warn: <svg className="h-3 w-3" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 6.5v4.5M10 14h.01M8.6 2.9 2.3 14.4A1.6 1.6 0 0 0 3.7 17h12.6a1.6 1.6 0 0 0 1.4-2.6L11.4 2.9a1.6 1.6 0 0 0-2.8 0Z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>,
};

const SHIPMENT_TONES: Record<ShipmentStatus, { tone: BadgeTone; icon: keyof typeof ICONS }> = {
  label_created: { tone: 'neutral', icon: 'file' },
  in_transit: { tone: 'info', icon: 'clock' },
  out_for_delivery: { tone: 'info', icon: 'clock' },
  delivered: { tone: 'success', icon: 'check' },
  exception: { tone: 'danger', icon: 'warn' },
  returned_to_sender: { tone: 'warning', icon: 'ban' },
  // An unrecognised carrier code is surfaced, never guessed (C7).
  unknown: { tone: 'neutral', icon: 'warn' },
};

/** The internally derived shipment status. */
export function ShipmentStatusBadge({ status }: { status: string }) {
  const key = (SHIPMENT_STATUS_LABELS as Record<string, string>)[status]
    ? (status as ShipmentStatus)
    : 'unknown';
  const definition = SHIPMENT_TONES[key];
  return (
    <Badge tone={definition.tone} icon={ICONS[definition.icon]}>
      {SHIPMENT_STATUS_LABELS[key]}
    </Badge>
  );
}

const SEVERITY_TONES: Record<ExceptionSeverity, BadgeTone> = {
  low: 'neutral',
  medium: 'info',
  high: 'warning',
  critical: 'danger',
};

export function SeverityBadge({ severity }: { severity: string }) {
  const key = (EXCEPTION_SEVERITIES as readonly string[]).includes(severity)
    ? (severity as ExceptionSeverity)
    : 'low';
  return <Badge tone={SEVERITY_TONES[key]}>{EXCEPTION_SEVERITY_LABELS[key]}</Badge>;
}

const EXCEPTION_STATUS_TONES: Record<ExceptionStatus, BadgeTone> = {
  open: 'danger',
  acknowledged: 'warning',
  resolved: 'success',
  dismissed: 'neutral',
};

export function ExceptionStatusBadge({ status }: { status: string }) {
  const key = (EXCEPTION_STATUSES as readonly string[]).includes(status)
    ? (status as ExceptionStatus)
    : 'open';
  return (
    <Badge tone={EXCEPTION_STATUS_TONES[key]}>
      {EXCEPTION_STATUS_LABELS[key] ?? status}
    </Badge>
  );
}

export function ExceptionTypeLabel({ type }: { type: string }) {
  return (
    <>
      {(EXCEPTION_TYPE_LABELS as Record<string, string>)[type as ExceptionType] ?? type}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* MetricCard                                                                 */
/* -------------------------------------------------------------------------- */

/** A trend is only rendered when a real comparison exists. */
export function MetricCard({
  label,
  value,
  hint,
  trend,
  icon,
  footer,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  trend?: { value: number; label: string } | null;
  icon?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="card flex flex-col gap-2 p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[13px] font-medium text-ink-muted">{label}</p>
        {icon ? <span className="text-ink-subtle">{icon}</span> : null}
      </div>
      <p className="tabular text-2xl font-semibold text-ink">{value}</p>
      {trend ? (
        <p className="text-xs text-ink-muted">
          <span className={trend.value >= 0 ? 'text-[color:var(--color-success)]' : 'text-[color:var(--color-danger)]'}>
            {trend.value >= 0 ? '+' : ''}
            {trend.value.toFixed(1)}%
          </span>{' '}
          {trend.label}
        </p>
      ) : null}
      {hint ? <p className="text-xs text-ink-subtle">{hint}</p> : null}
      {footer}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* DataTable                                                                  */
/* -------------------------------------------------------------------------- */

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  align?: 'left' | 'right';
  /** Hide on narrow screens; the row becomes a stacked card instead. */
  hideOnMobile?: boolean;
  sortable?: boolean;
  width?: string;
}

export function DataTable<T>({
  columns,
  rows,
  getRowKey,
  loading,
  error,
  empty,
  caption,
  onRetry,
  sort,
  onSortChange,
  rowHref,
}: {
  columns: Column<T>[];
  rows: T[];
  getRowKey: (row: T) => string;
  loading?: boolean;
  error?: string | null;
  empty?: ReactNode;
  caption: string;
  onRetry?: () => void;
  sort?: { key: string; order: 'asc' | 'desc' };
  onSortChange?: (key: string) => void;
  rowHref?: (row: T) => string | null;
}) {
  if (loading) return <TableSkeleton columns={columns.length} />;
  if (error) return <div className="p-4"><ErrorState message={error} {...(onRetry ? { onRetry } : {})} /></div>;
  if (rows.length === 0) {
    return <>{empty ?? <EmptyState title="Nothing here yet" description="No records match the current filters." />}</>;
  }

  return (
    <>
      {/* Desktop: a real table with column headers. */}
      <div className="hidden overflow-x-auto md:block" data-slot="scroll">
        <table className="w-full border-collapse text-left text-[13px]">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-line">
              {columns.map((column) => {
                const isSorted = sort?.key === column.key;
                return (
                  <th
                    key={column.key}
                    scope="col"
                    style={column.width ? { width: column.width } : undefined}
                    className={classNames(
                      'px-4 py-2.5 text-xs font-semibold tracking-wide text-ink-muted uppercase',
                      column.align === 'right' ? 'text-right' : 'text-left',
                    )}
                    aria-sort={isSorted ? (sort!.order === 'asc' ? 'ascending' : 'descending') : undefined}
                  >
                    {column.sortable && onSortChange ? (
                      <button
                        type="button"
                        onClick={() => onSortChange(column.key)}
                        className="inline-flex items-center gap-1 rounded hover:text-ink"
                      >
                        {column.header}
                        <span aria-hidden="true" className="text-[10px]">
                          {isSorted ? (sort!.order === 'asc' ? '▲' : '▼') : '↕'}
                        </span>
                      </button>
                    ) : (
                      column.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={getRowKey(row)} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={classNames(
                      'px-4 py-3 align-middle text-ink',
                      column.align === 'right' ? 'text-right' : 'text-left',
                    )}
                  >
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile: responsive list cards (Part A / A6). */}
      <ul className="flex flex-col divide-y divide-line md:hidden">
        {rows.map((row) => {
          const href = rowHref?.(row) ?? null;
          return (
            <li key={getRowKey(row)} className="px-4 py-3">
              {href ? (
                <a href={href} className="block no-underline">
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
                    {columns.map((column) => (
                      <div key={column.key} className={column.hideOnMobile ? 'hidden' : 'contents'}>
                        <dt className="text-xs text-ink-subtle">{column.header}</dt>
                        <dd className="text-[13px] text-ink">{column.render(row)}</dd>
                      </div>
                    ))}
                  </dl>
                </a>
              ) : (
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
                  {columns.map((column) => (
                    <div key={column.key} className={column.hideOnMobile ? 'hidden' : 'contents'}>
                      <dt className="text-xs text-ink-subtle">{column.header}</dt>
                      <dd className="text-[13px] text-ink">{column.render(row)}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Pagination                                                                 */
/* -------------------------------------------------------------------------- */

export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  return (
    <nav
      className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-3 text-[13px] text-ink-muted"
      aria-label="Pagination"
    >
      <p aria-live="polite">
        {total === 0 ? 'No results' : `Showing ${from}-${to} of ${total}`}
      </p>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
          Previous
        </Button>
        <span className="tabular">
          Page {page} of {totalPages}
        </span>
        <Button size="sm" variant="ghost" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>
          Next
        </Button>
      </div>
    </nav>
  );
}

/* -------------------------------------------------------------------------- */
/* CopyButton                                                                 */
/* -------------------------------------------------------------------------- */

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <Button
      size="sm"
      variant="secondary"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setState('copied');
        } catch {
          setState('failed');
        }
        window.setTimeout(() => setState('idle'), 2500);
      }}
    >
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label}
    </Button>
  );
}

/* -------------------------------------------------------------------------- */
/* Accessible bar chart                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A simple labelled SVG bar chart over counts. The data is also exposed as a
 * real table so screen-reader users and "zero data" states are honest (A6).
 */
export function BarChart({
  data,
  label,
  valueLabel = 'Shipments',
  emptyMessage = 'No data for this period yet.',
}: {
  data: Array<{ label: string; value: number; meta?: string }>;
  label: string;
  valueLabel?: string;
  emptyMessage?: string;
}) {
  if (data.length === 0) {
    return <p className="px-4 py-8 text-center text-[13px] text-ink-subtle">{emptyMessage}</p>;
  }

  const max = Math.max(...data.map((entry) => entry.value), 1);
  const total = data.reduce((sum, entry) => sum + entry.value, 0);

  return (
    <div className="space-y-3">
      <p className="sr-only">{`${label}. ${data.length} bars. Total ${total} ${valueLabel.toLowerCase()}.`}</p>
      <ul className="flex h-40 items-end gap-2 px-1" aria-hidden="true">
        {data.map((entry) => {
          const height = Math.max(2, Math.round((entry.value / max) * 100));
          return (
            <li key={entry.label} className="flex flex-1 flex-col items-center gap-1">
              <span className="w-full rounded-t bg-brand-500" style={{ height: `${height}%` }} />
            </li>
          );
        })}
      </ul>
      <table className="w-full text-left text-[13px]">
        <caption className="sr-only">{label}</caption>
        <thead>
          <tr className="border-b border-line text-xs text-ink-muted uppercase">
            <th scope="col" className="py-1.5 font-semibold">Period</th>
            <th scope="col" className="py-1.5 text-right font-semibold">{valueLabel}</th>
          </tr>
        </thead>
        <tbody>
          {data.map((entry) => (
            <tr key={entry.label} className="border-b border-line last:border-0">
              <td className="py-1.5">
                {entry.label}
                {entry.meta ? <span className="ml-2 text-xs text-ink-subtle">{entry.meta}</span> : null}
              </td>
              <td className="tabular py-1.5 text-right">{entry.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Horizontal proportion bars over counts (never money). */
export function ProportionBars({
  data,
  emptyMessage = 'Nothing to show yet.',
  valueLabel = 'shipments',
}: {
  data: Array<{ label: string; value: number; detail?: string }>;
  emptyMessage?: string;
  valueLabel?: string;
}) {
  if (data.length === 0) {
    return <p className="py-6 text-center text-[13px] text-ink-subtle">{emptyMessage}</p>;
  }
  const total = data.reduce((sum, entry) => sum + entry.value, 0) || 1;

  return (
    <ul className="space-y-3">
      {data.map((entry) => (
        <li key={entry.label}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-[13px]">
            <span className="text-ink">{entry.label}</span>
            <span className="tabular font-medium text-ink">
              {entry.value}
              <span className="ml-1 text-xs text-ink-subtle">{valueLabel}</span>
              <span className="ml-2 text-xs text-ink-subtle">
                {Math.round((entry.value / total) * 100)}%
              </span>
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-surface-sunken" aria-hidden="true">
            <div className="h-full rounded-full bg-brand-500" style={{ width: `${Math.max(1, (entry.value / total) * 100)}%` }} />
          </div>
          {entry.detail ? <p className="mt-0.5 text-xs text-ink-subtle">{entry.detail}</p> : null}
        </li>
      ))}
    </ul>
  );
}

export function DefinitionList({ items }: { items: Array<{ term: string; description: string }> }) {
  return (
    <dl className="space-y-2 text-[13px]">
      {items.map((item) => (
        <div key={item.term}>
          <dt className="font-medium text-ink">{item.term}</dt>
          <dd className="text-ink-muted">{item.description}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Timestamped business/audit events, newest first. */
export function ActivityTimeline({
  title = 'Activity',
  events,
}: {
  title?: string;
  events: Array<{ id: string; at: string; title: string; detail?: string }>;
}) {
  return (
    <section className="card">
      <header className="border-b border-line px-4 py-3">
        <h2>{title}</h2>
      </header>
      {events.length === 0 ? (
        <p className="px-4 py-6 text-center text-[13px] text-ink-subtle">No recorded activity yet.</p>
      ) : (
        <ol className="px-4 py-3">
          {events.map((event, index) => (
            <li key={event.id} className="relative flex gap-3 pb-3 last:pb-0">
              <span className="relative flex flex-col items-center" aria-hidden="true">
                <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-brand-400" />
                {index < events.length - 1 ? <span className="mt-1 w-px flex-1 bg-line" /> : null}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] capitalize text-ink">{event.title}</p>
                <p className="text-xs text-ink-subtle">{formatDateTime(event.at)}</p>
                {event.detail ? <p className="text-xs text-ink-muted">{event.detail}</p> : null}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

