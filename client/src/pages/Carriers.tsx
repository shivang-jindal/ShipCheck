/**
 * Carrier integrations (C3.2).
 *
 * ShipCheck ships no carrier adapter. Every card states that plainly and the
 * UI never implies that tracking data is flowing when it is not.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, ApiError } from '../lib/api';
import { formatDateTime, relativeTime } from '../lib/format';
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
import { Badge } from '../components/ui';

interface CarrierStatus {
  carrierCode: string;
  displayName: string;
  implemented: boolean;
  status: 'not_configured' | 'configured' | 'error' | 'disabled';
  enabled: boolean;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  pollIntervalMinutes: number;
  maskedKeys: Array<{ key: string; masked: string }>;
  supportedEvents: string[];
  documentedRateLimit: string | null;
  setupGuide: string[];
  limitations: string[];
}

const STATUS_TONE: Record<CarrierStatus['status'], 'neutral' | 'success' | 'danger' | 'warning'> = {
  not_configured: 'neutral',
  configured: 'success',
  error: 'danger',
  disabled: 'warning',
};

const STATUS_LABEL: Record<CarrierStatus['status'], string> = {
  not_configured: 'Not connected',
  configured: 'Configured',
  error: 'Last attempt failed',
  disabled: 'Disabled',
};

export function CarriersPage() {
  const { activeOrganizationId } = useSession();
  const queryClient = useQueryClient();
  const canManage = usePermission('integration.manage');

  const [drafts, setDrafts] = useState<Record<string, { apiKey: string; apiSecret: string; enabled: boolean }>>({});
  const [error, setError] = useState<string | null>(null);

  const carriers = useQuery({
    queryKey: ['shipcheck', activeOrganizationId, 'carriers'],
    queryFn: () => api.get<{ integrations: CarrierStatus[] }>(`/${activeOrganizationId}/integrations/carriers`),
    enabled: Boolean(activeOrganizationId),
  });

  const save = useMutation({
    mutationFn: ({ carrierCode }: { carrierCode: string }) => {
      const draft = drafts[carrierCode];
      if (!draft) throw new Error('Nothing to save');
      // The API takes a generic credential bag so a future adapter can define
      // its own keys without a schema change.
      const credentials: Record<string, string> = {};
      if (draft.apiKey.trim()) credentials.apiKey = draft.apiKey.trim();
      if (draft.apiSecret.trim()) credentials.apiSecret = draft.apiSecret.trim();
      return api.put(`/${activeOrganizationId}/integrations/carriers/${carrierCode}`, {
        credentials,
        enabled: draft.enabled,
      });
    },
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['shipcheck', activeOrganizationId] });
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : 'Could not save the carrier settings.');
    },
  });

  const test = useMutation({
    mutationFn: (carrierCode: string) =>
      api.post<{ ok: boolean; message: string }>(
        `/${activeOrganizationId}/integrations/carriers/${carrierCode}/test`,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['shipcheck', activeOrganizationId] });
    },
  });

  if (carriers.isError) {
    return (
      <>
        <PageHeader title="Carriers" />
        <Card>
          <ErrorState
            message="Could not load carrier settings."
            onRetry={() => void carriers.refetch()}
          />
        </Card>
      </>
    );
  }

  const rows = carriers.data?.integrations ?? [];

  return (
    <>
      <PageHeader
        title="Carriers"
        description="Which carrier feeds ShipCheck will use — and which ones are not available yet."
      />

      <Card className="mb-4">
        <p className="text-[13px] text-ink">
          <strong>No carrier adapter ships with ShipCheck.</strong> Adding API credentials does not
          start a data feed: there is no code that calls a carrier yet. Until one exists, track
          shipments manually or import them from CSV, and everything you record is labelled with
          its source.
        </p>
      </Card>

      {error ? (
        <p role="alert" className="mb-4 text-[13px] text-[color:var(--color-danger)]">{error}</p>
      ) : null}

      {rows.length === 0 ? (
        <Card>
          <EmptyState title="No carriers listed" description="The carrier catalogue is empty." />
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {rows.map((carrier) => {
            const draft = drafts[carrier.carrierCode] ?? {
              apiKey: '',
              apiSecret: '',
              enabled: carrier.enabled,
            };
            return (
              <Card
                key={carrier.carrierCode}
                title={carrier.displayName}
                description={`Carrier code: ${carrier.carrierCode}`}
                actions={
                  <Badge tone={STATUS_TONE[carrier.status]}>
                    {carrier.implemented ? STATUS_LABEL[carrier.status] : 'Not connected'}
                  </Badge>
                }
              >
                <p className="mb-3 rounded-lg border border-line bg-surface-sunken px-3 py-2 text-[13px] text-ink-muted">
                  {carrier.implemented
                    ? 'Adapter available.'
                    : 'Adapter not implemented. Credentials can be stored now and will be used once an adapter ships.'}
                </p>

                <dl className="space-y-1.5 text-[13px]">
                  <div className="flex justify-between gap-3">
                    <dt className="text-ink-muted">Last check</dt>
                    <dd className="tabular">{formatDateTime(carrier.lastCheckedAt)}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-ink-muted">Last success</dt>
                    <dd className="tabular">{formatDateTime(carrier.lastSuccessAt)}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-ink-muted">Poll interval</dt>
                    <dd className="tabular">{carrier.pollIntervalMinutes} min</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-ink-muted">Documented rate limit</dt>
                    <dd className="text-ink">{carrier.documentedRateLimit ?? 'Unknown'}</dd>
                  </div>
                </dl>

                {carrier.lastErrorCode ? (
                  <p className="mt-2 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[13px]">
                    <strong>{carrier.lastErrorCode}</strong>
                    {carrier.lastErrorMessage ? ` — ${carrier.lastErrorMessage}` : ''}
                  </p>
                ) : null}

                {carrier.maskedKeys.length > 0 ? (
                  <div className="mt-3">
                    <p className="text-xs font-medium text-ink-muted">Stored credentials</p>
                    <ul className="mt-1 space-y-0.5 text-[13px]">
                      {carrier.maskedKeys.map((entry) => (
                        <li key={entry.key} className="tabular text-ink-muted">
                          {entry.key}: <span className="text-ink">{entry.masked}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {canManage ? (
                  <form
                    className="mt-4 space-y-3 border-t border-line pt-4"
                    noValidate
                    onSubmit={(event) => {
                      event.preventDefault();
                      save.mutate({ carrierCode: carrier.carrierCode });
                    }}
                  >
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="API key" hint="Stored encrypted. Never shown again in full.">
                        {({ id, describedBy }) => (
                          <Input
                            id={id}
                            type="password"
                            autoComplete="off"
                            aria-describedby={describedBy}
                            value={draft.apiKey}
                            onChange={(event) =>
                              setDrafts({
                                ...drafts,
                                [carrier.carrierCode]: { ...draft, apiKey: event.target.value },
                              })
                            }
                          />
                        )}
                      </Field>
                      <Field label="API secret" hint="Stored encrypted. Never shown again in full.">
                        {({ id, describedBy }) => (
                          <Input
                            id={id}
                            type="password"
                            autoComplete="off"
                            aria-describedby={describedBy}
                            value={draft.apiSecret}
                            onChange={(event) =>
                              setDrafts({
                                ...drafts,
                                [carrier.carrierCode]: { ...draft, apiSecret: event.target.value },
                              })
                            }
                          />
                        )}
                      </Field>
                    </div>
                    <label className="flex items-center gap-2 text-[13px] text-ink">
                      <input
                        type="checkbox"
                        checked={draft.enabled}
                        onChange={(event) =>
                          setDrafts({
                            ...drafts,
                            [carrier.carrierCode]: { ...draft, enabled: event.target.checked },
                          })
                        }
                      />
                      Poll this carrier for new events
                    </label>
                    <div className="flex flex-wrap gap-2">
                      <Button type="submit" variant="secondary" loading={save.isPending}>
                        Save settings
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        loading={test.isPending}
                        onClick={() => test.mutate(carrier.carrierCode)}
                      >
                        Test connection
                      </Button>
                    </div>
                    {test.data ? (
                      <p className="text-[13px] text-ink-muted">
                        {test.data.ok ? 'Connected.' : 'Not connected.'} {test.data.message}
                      </p>
                    ) : null}
                  </form>
                ) : null}

                {carrier.setupGuide.length > 0 ? (
                  <details className="mt-3">
                    <summary className="cursor-pointer text-[13px] font-medium text-ink">Setup notes</summary>
                    <ul className="mt-1 list-disc pl-5 text-[13px] text-ink-muted">
                      {carrier.setupGuide.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  </details>
                ) : null}

                {carrier.limitations.length > 0 ? (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-[13px] font-medium text-ink">Limitations</summary>
                    <ul className="mt-1 list-disc pl-5 text-[13px] text-ink-muted">
                      {carrier.limitations.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  </details>
                ) : null}

                {carrier.lastCheckedAt ? (
                  <p className="mt-2 text-[11px] text-ink-subtle">
                    Checked {relativeTime(carrier.lastCheckedAt)}.
                  </p>
                ) : null}
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}