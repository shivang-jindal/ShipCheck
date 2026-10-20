/** Exception queue: triage, assign, acknowledge, resolve (C3.4). */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import {
  EXCEPTION_SEVERITIES,
  EXCEPTION_SEVERITY_LABELS,
  EXCEPTION_STATUSES,
  EXCEPTION_STATUS_LABELS,
  EXCEPTION_TYPES,
  EXCEPTION_TYPE_LABELS,
  type Paginated,
  type ShipmentExceptionView,
} from '@shipcheck/shared';

import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { Card, EmptyState, PageHeader, Select } from '../components/ui';
import {
  Column,
  DataTable,
  ExceptionStatusBadge,
  ExceptionTypeLabel,
  Pagination,
  SeverityBadge,
} from '../components/patterns';

export function ExceptionsPage() {
  const { activeOrganizationId } = useSession();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<string>('open');
  const [severity, setSeverity] = useState<string>('all');
  const [type, setType] = useState<string>('all');

  const exceptions = useQuery({
    queryKey: ['shipcheck', activeOrganizationId, 'exceptions', page, status, severity, type],
    queryFn: () =>
      api.get<Paginated<ShipmentExceptionView>>(
        `/${activeOrganizationId}/exceptions?${new URLSearchParams({
          page: String(page),
          pageSize: '25',
          status,
          severity,
          type,
        })}`,
      ),
    enabled: Boolean(activeOrganizationId),
  });

  const columns: Column<ShipmentExceptionView>[] = [
    {
      key: 'trackingNumber',
      header: 'Shipment',
      render: (row) => (
        <div>
          <Link
            to={`/${activeOrganizationId}/shipments/${row.shipmentId}`}
            className="tabular block font-medium text-ink underline"
          >
            {row.trackingNumber}
          </Link>
          <span className="text-xs text-ink-muted">{row.customerName ?? '—'}</span>
        </div>
      ),
    },
    {
      key: 'type',
      header: 'Type',
      render: (row) => <ExceptionTypeLabel type={row.type} />,
    },
    { key: 'severity', header: 'Severity', render: (row) => <SeverityBadge severity={row.severity} /> },
    { key: 'status', header: 'Status', render: (row) => <ExceptionStatusBadge status={row.status} /> },
    {
      key: 'assignedUserName',
      header: 'Assigned',
      render: (row) => row.assignedUserName ?? <span className="text-ink-subtle">Unassigned</span>,
    },
    {
      key: 'ageHours',
      header: 'Age',
      align: 'right',
      render: (row) => <span className="tabular">{Math.round(row.ageHours)}h</span>,
    },
    {
      key: 'action',
      header: <span className="sr-only">Open</span>,
      align: 'right',
      render: (row) => (
        <Link
          to={`/${activeOrganizationId}/exceptions/${row.id}`}
          className="text-[13px] text-brand-700 underline"
        >
          Triage
        </Link>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Exceptions"
        description="Shipments that need a human decision. Resolving records what you did and why."
      />

      <Card>
        <div className="flex flex-wrap items-end gap-3 border-b border-line p-3">
          <div>
            <label htmlFor="exception-status" className="mb-1 block text-xs font-medium text-ink-muted">
              Status
            </label>
            <Select
              id="exception-status"
              value={status}
              onChange={(event) => {
                setStatus(event.target.value);
                setPage(1);
              }}
            >
              <option value="all">All statuses</option>
              {EXCEPTION_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {EXCEPTION_STATUS_LABELS[value]}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label htmlFor="exception-severity" className="mb-1 block text-xs font-medium text-ink-muted">
              Severity
            </label>
            <Select
              id="exception-severity"
              value={severity}
              onChange={(event) => {
                setSeverity(event.target.value);
                setPage(1);
              }}
            >
              <option value="all">Any severity</option>
              {EXCEPTION_SEVERITIES.map((value) => (
                <option key={value} value={value}>
                  {EXCEPTION_SEVERITY_LABELS[value]}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label htmlFor="exception-type" className="mb-1 block text-xs font-medium text-ink-muted">
              Type
            </label>
            <Select
              id="exception-type"
              value={type}
              onChange={(event) => {
                setType(event.target.value);
                setPage(1);
              }}
            >
              <option value="all">Any type</option>
              {EXCEPTION_TYPES.map((value) => (
                <option key={value} value={value}>
                  {EXCEPTION_TYPE_LABELS[value]}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <DataTable
          caption="Shipment exceptions"
          columns={columns}
          rows={exceptions.data?.items ?? []}
          getRowKey={(row) => row.id}
          loading={exceptions.isLoading}
          error={exceptions.isError ? 'Could not load exceptions.' : null}
          onRetry={() => void exceptions.refetch()}
          empty={
            <EmptyState
              title="Nothing to triage"
              description="No exception matches these filters. That is good news, not missing data."
            />
          }
        />

        {exceptions.data && exceptions.data.total > 0 ? (
          <Pagination
            page={exceptions.data.page}
            pageSize={exceptions.data.pageSize}
            total={exceptions.data.total}
            onPageChange={setPage}
          />
        ) : null}
      </Card>
    </>
  );
}