/**
 * Notification rules and the outbox (C3.5).
 *
 * A message marked "sent" means the provider accepted it. ShipCheck never
 * claims an email was delivered, and the page says so.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { NOTIFICATION_EVENT_TYPES } from '@shipcheck/shared';

import { api, ApiError } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { usePermission, useSession } from '../lib/session';
import { Badge, Card, EmptyState, ErrorState, Field, PageHeader } from '../components/ui';

interface NotificationRule {
  eventType: string;
  enabled: boolean;
  templateId: string;
  cooldownMinutes: number;
  recipientMode: string | null;
  recipients: string[] | null;
}

interface OutboxRow {
  id: string;
  templateId: string;
  recipient: string;
  subject: string;
  status: 'queued' | 'sent' | 'failed' | 'skipped';
  errorMessage: string | null;
  createdAt: string;
  sentAt: string | null;
}

interface NotificationsResponse {
  rules: NotificationRule[];
  email: {
    provider: string;
    deliversMessages: boolean;
    detail: string;
    setupHint: string;
  };
  outbox: OutboxRow[];
  note: string;
}

const EVENT_LABELS: Record<string, string> = {
  shipment_created: 'Shipment added',
  in_transit: 'In transit',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  exception: 'Exception raised',
};

const STATUS_TONE = {
  queued: 'neutral',
  sent: 'success',
  failed: 'danger',
  skipped: 'warning',
} as const;

export function NotificationsPage() {
  const { activeOrganizationId } = useSession();
  const queryClient = useQueryClient();
  const canManage = usePermission('notification.manage');
  const [error, setError] = useState<string | null>(null);

  const notifications = useQuery({
    queryKey: ['shipcheck', activeOrganizationId, 'notifications'],
    queryFn: () => api.get<NotificationsResponse>(`/${activeOrganizationId}/settings/notifications`),
    enabled: Boolean(activeOrganizationId),
  });

  const save = useMutation({
    mutationFn: (rules: NotificationRule[]) =>
      api.patch(`/${activeOrganizationId}/settings/notifications`, { rules }),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['shipcheck', activeOrganizationId] });
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : 'Could not save the rules.');
    },
  });

  if (notifications.isError) {
    return (
      <>
        <PageHeader title="Notifications" />
        <Card>
          <ErrorState message="Could not load notification settings." onRetry={() => void notifications.refetch()} />
        </Card>
      </>
    );
  }

  const data = notifications.data;
  const rules = data?.rules ?? [];

  function toggle(rule: NotificationRule) {
    save.mutate(
      rules.map((candidate) =>
        candidate.eventType === rule.eventType
          ? { ...candidate, enabled: !candidate.enabled }
          : candidate,
      ),
    );
  }

  return (
    <>
      <PageHeader
        title="Notifications"
        description="Which shipment events trigger an email, and what ShipCheck has actually sent."
      />

      {error ? (
        <p role="alert" className="mb-4 text-[13px] text-[color:var(--color-danger)]">{error}</p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Email provider" description="What will happen when a rule fires.">
          {data ? (
            <>
              <p className="text-[13px] text-ink">
                <strong>{data.email.provider}</strong>
              </p>
              <p className="mt-1 text-[13px] text-ink-muted">{data.email.detail}</p>
              {!data.email.deliversMessages ? (
                <p className="mt-2 rounded-lg border border-line bg-surface-sunken px-3 py-2 text-[13px] text-ink-muted">
                  This provider cannot confirm delivery. ShipCheck records a message as
                  <em> sent</em> when the provider accepts it and never claims more than that.
                </p>
              ) : null}
              <p className="mt-2 text-xs text-ink-subtle">{data.email.setupHint}</p>
            </>
          ) : (
            <p className="text-[13px] text-ink-muted">Loading…</p>
          )}
        </Card>

        <Card title="Rules" description="One rule per event. Cooldown prevents repeat emails for one shipment.">
          {!canManage ? (
            <p className="text-[13px] text-ink-muted">
              Your role cannot change notification rules. Ask an admin for the
              <code className="mx-1">notification.manage</code> permission.
            </p>
          ) : rules.length === 0 ? (
            <EmptyState title="No rules yet" description="No notification rules are configured." />
          ) : (
            <ul className="divide-y divide-line">
              {rules.map((rule) => (
                <li key={rule.eventType} className="flex items-center justify-between gap-3 py-2.5">
                  <div>
                    <p className="text-[13px] font-medium text-ink">
                      {EVENT_LABELS[rule.eventType] ?? rule.eventType}
                    </p>
                    <p className="tabular text-xs text-ink-muted">
                      template {rule.templateId} · cooldown {rule.cooldownMinutes} min
                    </p>
                  </div>
                  <label className="flex items-center gap-2 text-[13px] text-ink">
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      disabled={save.isPending}
                      onChange={() => toggle(rule)}
                    />
                    {rule.enabled ? 'On' : 'Off'}
                  </label>
                </li>
              ))}
            </ul>
          )}
          {rules.length > 0 && NOTIFICATION_EVENT_TYPES.length !== rules.length ? (
            <p className="mt-3 text-xs text-ink-subtle">
              ShipCheck supports: {NOTIFICATION_EVENT_TYPES.join(', ').replace(/_/g, ' ')}.
            </p>
          ) : null}
        </Card>
      </div>

      <Card
        className="mt-4"
        title="Outbox"
        description="The last messages ShipCheck queued. Status is what the provider reported, not a delivery guarantee."
      >
        {!data || data.outbox.length === 0 ? (
          <EmptyState title="Nothing sent yet" description="No notification has been queued for this workspace." />
        ) : (
          <>
            <p className="mb-3 rounded-lg border border-line bg-surface-sunken px-3 py-2 text-[13px] text-ink-muted">
              {data.note}
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[13px]">
                <caption className="sr-only">Recently queued notification messages</caption>
                <thead>
                  <tr className="border-b border-line text-xs text-ink-muted uppercase">
                    <th scope="col" className="py-2 font-semibold">Recipient</th>
                    <th scope="col" className="py-2 font-semibold">Subject</th>
                    <th scope="col" className="py-2 font-semibold">Status</th>
                    <th scope="col" className="py-2 font-semibold">Queued</th>
                    <th scope="col" className="py-2 font-semibold">Sent</th>
                  </tr>
                </thead>
                <tbody>
                  {data.outbox.map((row) => (
                    <tr key={row.id} className="border-b border-line last:border-0">
                      <td className="py-1.5">{row.recipient}</td>
                      <td className="py-1.5 text-ink-muted">
                        {row.subject}
                        {row.errorMessage ? ` — ${row.errorMessage}` : ''}
                      </td>
                      <td className="py-1.5">
                        <Badge tone={STATUS_TONE[row.status]}>{row.status}</Badge>
                      </td>
                      <td className="tabular py-1.5">{formatDateTime(row.createdAt)}</td>
                      <td className="tabular py-1.5">{formatDateTime(row.sentAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>

      <Card className="mt-4" title="Recipients" description="Where notification emails are sent.">
        <Field label="How recipients are chosen" hint="Configure this in Settings.">
          {() => <p className="text-[13px] text-ink-muted">Open Settings to manage recipients.</p>}
        </Field>
      </Card>
    </>
  );
}