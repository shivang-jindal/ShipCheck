/**
 * CSV import: preview first, commit second (C4).
 *
 * Nothing is written until the user has seen exactly which rows will be
 * created, which will be skipped and why.
 */

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';

import { IMPORT_MAX_BYTES, IMPORT_MAX_ROWS } from '@shipcheck/shared';

import { api, ApiError } from '../lib/api';
import { usePermission, useSession } from '../lib/session';
import {
  Button,
  Card,
  EmptyState,
  Field,
  PageHeader,
  Select,
  Textarea,
} from '../components/ui';
import { MetricCard } from '../components/patterns';

interface PreviewRow {
  trackingNumber: string;
  carrierCode: string;
  orderReference: string | null;
  publicReference: string | null;
  customerName: string | null;
  customerEmail: string | null;
  destinationCountry: string | null;
  shippedAt: string | null;
  estimatedDeliveryAt: string | null;
  internalNotes: string | null;
}

interface ImportPreview {
  importId: string;
  filenameSafe: string;
  headers: string[];
  suggestedMapping: Record<string, string>;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  errors: Array<{ rowNumber: number; errorCode: string; message: string; row: Record<string, string> }>;
  preview: PreviewRow[];
}

interface CommitResult {
  importId: string;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  message: string;
}

const TEMPLATE = 'tracking_number,carrier_code,order_reference,customer_name,customer_email,destination_country,shipped_at,estimated_delivery_at';

export function ImportsPage() {
  const { activeOrganizationId } = useSession();
  const navigate = useNavigate();
  const canImport = usePermission('import.run');

  const [filename, setFilename] = useState('');
  const [content, setContent] = useState('');
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<ImportPreview | null>(null);

  const runPreview = useMutation({
    mutationFn: () =>
      api.post<ImportPreview>(`/${activeOrganizationId}/imports/shipments/preview`, {
        filename: filename.trim() || 'upload.csv',
        content,
        mapping,
      }),
    onSuccess: (data) => {
      setPreview(data);
      setMapping(data.suggestedMapping);
    },
  });

  const commit = useMutation({
    mutationFn: () => {
      if (!preview) throw new Error('No preview');
      return api.post<CommitResult>(`/${activeOrganizationId}/imports/shipments/commit`, {
        filename: preview.filenameSafe,
        content,
        mapping: preview.suggestedMapping,
      });
    },
  });

  function readFile(file: File) {
    if (file.size > IMPORT_MAX_BYTES) {
      window.alert(`That file is larger than the ${Math.round(IMPORT_MAX_BYTES / 1024 / 1024)} MB limit.`);
      return;
    }
    setFilename(file.name);
    const reader = new FileReader();
    reader.onload = () => setContent(String(reader.result ?? ''));
    reader.readAsText(file);
  }

  if (!canImport) {
    return (
      <>
        <PageHeader title="CSV import" />
        <Card>
          <p className="text-[13px] text-ink-muted">
            Your role does not allow running imports. Ask an admin for the
            <code className="mx-1">import.run</code> permission.
          </p>
        </Card>
      </>
    );
  }

  const result = commit.data;

  return (
    <>
      <PageHeader
        title="CSV import"
        description="Upload shipments you already track. Nothing is written until you review the preview."
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="1. Choose a file" className="lg:col-span-1">
          <form
            className="space-y-4"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              if (content.trim()) runPreview.mutate();
            }}
          >
            <Field label="CSV file" hint={`Up to ${Math.round(IMPORT_MAX_BYTES / 1024 / 1024)} MB and ${IMPORT_MAX_ROWS.toLocaleString()} rows.`}>
              {({ id, describedBy }) => (
                <input
                  id={id}
                  type="file"
                  accept=".csv,text/csv"
                  aria-describedby={describedBy}
                  className="block w-full text-[13px]"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) readFile(file);
                  }}
                />
              )}
            </Field>

            <Field label="Or paste the CSV" hint={`The only required column is tracking_number.`}>
              {({ id, describedBy }) => (
                <Textarea
                  id={id}
                  rows={8}
                  aria-describedby={describedBy}
                  spellCheck={false}
                  placeholder={TEMPLATE}
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                />
              )}
            </Field>

            {runPreview.error instanceof ApiError ? (
              <p role="alert" className="text-[13px] text-[color:var(--color-danger)]">
                {runPreview.error.message}
              </p>
            ) : null}

            <Button type="submit" variant="primary" loading={runPreview.isPending} disabled={!content.trim()}>
              Preview import
            </Button>
          </form>
        </Card>

        <div className="space-y-4 lg:col-span-2">
          {result ? (
            <Card title="3. Import finished">
              <div className="grid gap-3 sm:grid-cols-4">
                <MetricCard label="Created" value={result.created} />
                <MetricCard label="Updated" value={result.updated} />
                <MetricCard label="Skipped" value={result.skipped} />
                <MetricCard label="Failed" value={result.failed} />
              </div>
              <p className="mt-3 text-[13px] text-ink-muted">{result.message}</p>
              <Button className="mt-3" variant="secondary" onClick={() => navigate(`/${activeOrganizationId}/shipments`)}>
                View shipments
              </Button>
            </Card>
          ) : null}

          {!preview && !result ? (
            <Card>
              <EmptyState
                title="Nothing to preview yet"
                description="Choose a CSV file or paste rows, then preview. ShipCheck shows you exactly what it will do before writing anything."
              />
            </Card>
          ) : null}

          {preview && !result ? (
            <>
              <Card title="2. Review the preview" description="Nothing has been saved yet.">
                <div className="grid gap-3 sm:grid-cols-4">
                  <MetricCard label="Rows read" value={preview.totalRows} />
                  <MetricCard label="Valid" value={preview.validRows} />
                  <MetricCard label="Invalid" value={preview.invalidRows} />
                  <MetricCard
                    label="Columns mapped"
                    value={`${Object.keys(preview.suggestedMapping).length}/${preview.headers.length}`}
                  />
                </div>

                <details className="mt-4">
                  <summary className="cursor-pointer text-[13px] font-medium text-ink">
                    Column mapping
                  </summary>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    {preview.headers.map((header) => (
                      <Field key={header} label={header}>
                        {({ id }) => (
                          <Select
                            id={id}
                            value={preview.suggestedMapping[header] ?? ''}
                            onChange={(event) =>
                              setMapping({ ...preview.suggestedMapping, [header]: event.target.value })
                            }
                          >
                            <option value="">Do not import</option>
                            <option value="tracking_number">tracking_number</option>
                            <option value="carrier_code">carrier_code</option>
                            <option value="order_reference">order_reference</option>
                            <option value="public_reference">public_reference</option>
                            <option value="customer_name">customer_name</option>
                            <option value="customer_email">customer_email</option>
                            <option value="destination_country">destination_country</option>
                            <option value="shipped_at">shipped_at</option>
                            <option value="estimated_delivery_at">estimated_delivery_at</option>
                            <option value="internal_notes">internal_notes</option>
                          </Select>
                        )}
                      </Field>
                    ))}
                  </div>
                  <Button
                    className="mt-2"
                    size="sm"
                    variant="secondary"
                    loading={runPreview.isPending}
                    onClick={() => runPreview.mutate()}
                  >
                    Re-run preview with this mapping
                  </Button>
                </details>

                <div className="mt-4">
                  <Button
                    variant="primary"
                    loading={commit.isPending}
                    disabled={preview.validRows === 0}
                    onClick={() => commit.mutate()}
                  >
                    Import {preview.validRows} valid row{preview.validRows === 1 ? '' : 's'}
                  </Button>
                  {commit.error instanceof ApiError ? (
                    <p role="alert" className="mt-2 text-[13px] text-[color:var(--color-danger)]">
                      {commit.error.message}
                    </p>
                  ) : null}
                </div>
              </Card>

              {preview.errors.length > 0 ? (
                <Card
                  title={`${preview.errors.length} row${preview.errors.length === 1 ? '' : 's'} will be skipped`}
                  description="Each skipped row is listed with the reason. Fix the source file and import again."
                >
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-[13px]">
                      <caption className="sr-only">Rows that will be skipped</caption>
                      <thead>
                        <tr className="border-b border-line text-xs text-ink-muted uppercase">
                          <th scope="col" className="py-2 font-semibold">Row</th>
                          <th scope="col" className="py-2 font-semibold">Problem</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.errors.slice(0, 100).map((error) => (
                          <tr key={`${error.rowNumber}-${error.errorCode}`} className="border-b border-line last:border-0">
                            <td className="tabular py-1.5">{error.rowNumber}</td>
                            <td className="py-1.5 text-ink-muted">{error.message}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              ) : null}

              <Card title="Rows that will be created">
                {preview.preview.length === 0 ? (
                  <EmptyState title="No valid rows" description="Nothing in this file can be imported as-is." />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-[13px]">
                      <caption className="sr-only">Preview of rows that will be imported</caption>
                      <thead>
                        <tr className="border-b border-line text-xs text-ink-muted uppercase">
                          <th scope="col" className="py-2 font-semibold">Tracking</th>
                          <th scope="col" className="py-2 font-semibold">Carrier</th>
                          <th scope="col" className="py-2 font-semibold">Customer</th>
                          <th scope="col" className="py-2 font-semibold">Destination</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.preview.map((row) => (
                          <tr key={row.trackingNumber} className="border-b border-line last:border-0">
                            <td className="tabular py-1.5">{row.trackingNumber}</td>
                            <td className="py-1.5">{row.carrierCode}</td>
                            <td className="py-1.5">{row.customerName ?? '—'}</td>
                            <td className="py-1.5">{row.destinationCountry ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </>
          ) : null}
        </div>
      </div>
    </>
  );
}