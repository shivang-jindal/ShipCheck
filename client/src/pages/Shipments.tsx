/** Shipment list: filters, paging and CSV export. */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import {
  CARRIER_CATALOGUE,
  SHIPMENT_STATUSES,
  SHIPMENT_STATUS_LABELS,
  type Paginated,
  type ShipmentListItem,
} from '@shipcheck/shared';

import { api, apiDownload, ApiError } from '../lib/api';
import { formatDateTime, relativeTime } from '../lib/format';
import { usePermission, useSession } from '../lib/session';
import { Button, Card, EmptyState, ErrorState, Input, PageHeader, Select, buttonClass } from '../components/ui';
import { Column, DataTable, Pagination, ShipmentStatusBadge } from '../components/patterns';

export function ShipmentsPage() {
  const { activeOrganizationId } = useSession();
  const canExport = usePermission('report.export');
  const canCreate = usePermission('shipment.create');

  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<string>('all');
  const [carrierCode, setCarrierCode] = useState<string>('');
  const [search, setSearch] = useState('');
  const [exportError, setExportError] = useState<string | null>(null);

  const shipments = useQuery({
    queryKey: ['shipcheck', activeOrganizationId, 'shipments', page, status, carrierCode, search],
    queryFn: () =>
      api.get<Paginated<ShipmentListItem>>(
        `/${activeOrganizationId}/shipments?${new URLSearchParams({
          page: String(page),
          pageSize: '25',
          status,
          ...(carrierCode ? { carrierCode } : {}),
          ...(search ? { q: search } : {}),
        })}`,
      ),
    enabled: Boolean(activeOrganizationId),
  });

  const columns: Column<ShipmentListItem>[] = [
    {
      key: 'trackingNumber',
      header: 'Tracking number',
      render: (row) => (
        <Link to={`/${activeOrganizationId}/shipments/${row.id}`} className="tabular font-medium text-ink underline">
          {row.trackingNumber}
        </Link>
      ),
    },
    { key: 'carrierName', header: 'Carrier', render: (row) => row.carrierName },
    { key: 'customerName', header: 'Customer', render: (row) => row.customerName ?? '—' },
    {
      key: 'status',
      header: 'Status',
      render: (row) => (
        <div className="flex flex-col gap-1">
          <ShipmentStatusBadge status={row.derivedStatus} />
          {row.lastCarrierStatus && row.lastCarrierStatus !== row.derivedStatus ? (
            <span className="text-xs text-ink-subtle">carrier reported {SHIPMENT_STATUS_LABELS[row.lastCarrierStatus]}</span>
          ) : null}
        </div>
      ),
    },
    {
      key: 'lastEventAt',
      header: 'Last event',
      render: (row) => (
        <span title={formatDateTime(row.lastEventAt)}>{relativeTime(row.lastEventAt)}</span>
      ),
    },
    {
      key: 'openExceptionCount',
      header: 'Exceptions',
      align: 'right',
      render: (row) =>
        row.openExceptionCount > 0 ? (
          <Link to={`/${activeOrganizationId}/exceptions`} className="tabular underline">
            {row.openExceptionCount}
          </Link>
        ) : (
          <span className="tabular text-ink-subtle">0</span>
        ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Shipments"
        description="Every shipment you track, with the status ShipCheck derived from recorded events."
        actions={
          <>
            {canCreate ? (
              <Link
                to={`/${activeOrganizationId}/shipments/new`}
                className={buttonClass('primary')}
              >
                Add shipment
              </Link>
            ) : null}
            {canExport ? (
              <Button
                variant="secondary"
                onClick={async () => {
                  setExportError(null);
                  try {
                    // The export always covers the whole workspace, not the
                    // current filters; customer email is opt-in.
                    await apiDownload(
                      `/${activeOrganizationId}/exports/shipments`,
                      'shipcheck-shipments.csv',
                      'POST',
                      { includeCustomerEmail: false },
                    );
                  } catch (error) {
                    setExportError(error instanceof ApiError ? error.message : 'Export failed.');
                  }
                }}
              >
                Export all shipments
              </Button>
            ) : null}
          </>
        }
      />

      <Card>
        <div className="flex flex-wrap items-end gap-3 border-b border-line p-3">
          <form
            className="min-w-52 flex-1"
            onSubmit={(event) => {
              event.preventDefault();
              setPage(1);
            }}
          >
            <label htmlFor="shipment-search" className="mb-1 block text-xs font-medium text-ink-muted">
              Search
            </label>
            <Input
              id="shipment-search"
              value={search}
              placeholder="Tracking number, order or customer"
              onChange={(event) => setSearch(event.target.value)}
            />
          </form>
          <div>
            <label htmlFor="shipment-status" className="mb-1 block text-xs font-medium text-ink-muted">
              Status
            </label>
            <Select
              id="shipment-status"
              value={status}
              onChange={(event) => {
                setStatus(event.target.value);
                setPage(1);
              }}
            >
              <option value="all">All statuses</option>
              {SHIPMENT_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {SHIPMENT_STATUS_LABELS[value]}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label htmlFor="shipment-carrier" className="mb-1 block text-xs font-medium text-ink-muted">
              Carrier
            </label>
            <Select
              id="shipment-carrier"
              value={carrierCode}
              onChange={(event) => {
                setCarrierCode(event.target.value);
                setPage(1);
              }}
            >
              <option value="">All carriers</option>
              {CARRIER_CATALOGUE.map((carrier) => (
                <option key={carrier.code} value={carrier.code}>
                  {carrier.displayName}
                </option>
              ))}
            </Select>
          </div>
        </div>

        {exportError ? (
          <p role="alert" className="border-b border-line px-4 py-2 text-[13px] text-[color:var(--color-danger)]">
            {exportError}
          </p>
        ) : null}

        <DataTable
          caption="Shipments tracked by this workspace"
          columns={columns}
          rows={shipments.data?.items ?? []}
          getRowKey={(row) => row.id}
          loading={shipments.isLoading}
          error={shipments.isError ? 'Could not load shipments.' : null}
          onRetry={() => void shipments.refetch()}
          empty={
            <EmptyState
              title="No shipments match"
              description="Adjust the filters, add a shipment, or import a CSV."
            />
          }
        />

        {shipments.data && shipments.data.total > 0 ? (
          <Pagination
            page={shipments.data.page}
            pageSize={shipments.data.pageSize}
            total={shipments.data.total}
            onPageChange={setPage}
          />
        ) : null}
      </Card>

      {shipments.isError ? (
        <ErrorState message="Something went wrong loading shipments." onRetry={() => void shipments.refetch()} />
      ) : null}
    </>
  );
}