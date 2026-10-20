/** Exception triage: acknowledge, assign, comment and resolve. */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { COMMENT_VISIBILITIES } from '@shipcheck/shared';

import { api, ApiError } from '../lib/api';
import { formatDateTime, relativeTime } from '../lib/format';
import { usePermission, useSession } from '../lib/session';
import {
  Button,
  Card,
  ErrorState,
  Field,
  PageHeader,
  Select,
  Textarea,
} from '../components/ui';
import {
  ActivityTimeline,
  ExceptionStatusBadge,
  ExceptionTypeLabel,
  SeverityBadge,
  ShipmentStatusBadge,
} from '../components/patterns';

interface ExceptionDetail {
  exception: {
    id: string;
    shipmentId: string;
    trackingNumber: string;
    carrierCode: string;
    carrierName: string;
    customerName: string | null;
    type: string;
    severity: string;
    status: string;
    detail: string | null;
    assignedUserId: string | null;
    assignedUserName: string | null;
    openedAt: string;
    acknowledgedAt: string | null;
    resolvedAt: string | null;
    resolutionReason: string | null;
    lastNotifiedAt: string | null;
    shipmentStatus: string;
    lastEventAt: string | null;
  };
  comments: Array<{
    id: string;
    comment: string;
    visibility: 'internal' | 'customer';
    authorName: string | null;
    authorEmail: string;
    createdAt: string;
  }>;
  timeline: Array<{ id: string; action: string; actorEmail: string | null; createdAt: string }>;
}

export function ExceptionDetailPage() {
  const { exceptionId = '' } = useParams();
  const { activeOrganizationId, user } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const canComment = usePermission('exception.comment');
  const canResolve = usePermission('exception.resolve');

  const [comment, setComment] = useState('');
  const [visibility, setVisibility] = useState<'internal' | 'customer'>('internal');
  const [resolveOpen, setResolveOpen] = useState(false);
  const [resolution, setResolution] = useState<{ status: 'resolved' | 'dismissed'; reason: string }>({
    status: 'resolved',
    reason: '',
  });
  const [error, setError] = useState<string | null>(null);

  const detail = useQuery({
    queryKey: ['shipcheck', activeOrganizationId, 'exception', exceptionId],
    queryFn: () =>
      api.get<ExceptionDetail>(`/${activeOrganizationId}/exceptions/${exceptionId}`),
    enabled: Boolean(activeOrganizationId && exceptionId),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['shipcheck', activeOrganizationId] });
  };

  const acknowledge = useMutation({
    mutationFn: () => api.post(`/${activeOrganizationId}/exceptions/${exceptionId}/acknowledge`),
    onSuccess: invalidate,
  });

  const assign = useMutation({
    mutationFn: (assignedUserId: string | null) =>
      api.post(`/${activeOrganizationId}/exceptions/${exceptionId}/assign`, { assignedUserId }),
    onSuccess: invalidate,
  });

  const addComment = useMutation({
    mutationFn: () =>
      api.post(`/${activeOrganizationId}/exceptions/${exceptionId}/comments`, {
        comment: comment.trim(),
        visibility,
      }),
    onSuccess: () => {
      setComment('');
      invalidate();
    },
  });

  const resolve = useMutation({
    mutationFn: () =>
      api.post(`/${activeOrganizationId}/exceptions/${exceptionId}/resolve`, {
        status: resolution.status,
        reason: resolution.reason.trim(),
      }),
    onSuccess: () => {
      setResolveOpen(false);
      invalidate();
    },
  });

  if (detail.isLoading) {
    return (
      <>
        <PageHeader title="Exception" />
        <Card>Loading…</Card>
      </>
    );
  }

  if (detail.isError || !detail.data) {
    return (
      <>
        <PageHeader title="Exception" />
        <Card>
          <ErrorState
            message="This exception could not be loaded. It may belong to another workspace."
            onRetry={() => void detail.refetch()}
          />
        </Card>
      </>
    );
  }

  const { exception, comments, timeline } = detail.data;
  const isOpen = exception.status === 'open' || exception.status === 'acknowledged';

  return (
    <>
      <PageHeader
        title={`${exception.trackingNumber}`}
        description={`${exception.carrierName} · opened ${relativeTime(exception.openedAt)}`}
        actions={
          <Button variant="ghost" onClick={() => navigate(`/${activeOrganizationId}/exceptions`)}>
            Back to queue
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title="What happened">
            <dl className="grid gap-3 text-[13px] sm:grid-cols-2">
              <div>
                <dt className="text-ink-muted">Type</dt>
                <dd className="text-ink"><ExceptionTypeLabel type={exception.type} /></dd>
              </div>
              <div>
                <dt className="text-ink-muted">Severity</dt>
                <dd><SeverityBadge severity={exception.severity} /></dd>
              </div>
              <div>
                <dt className="text-ink-muted">Status</dt>
                <dd><ExceptionStatusBadge status={exception.status} /></dd>
              </div>
              <div>
                <dt className="text-ink-muted">Assigned to</dt>
                <dd className="text-ink">{exception.assignedUserName ?? 'Unassigned'}</dd>
              </div>
              <div>
                <dt className="text-ink-muted">Opened</dt>
                <dd className="tabular">{formatDateTime(exception.openedAt)}</dd>
              </div>
              <div>
                <dt className="text-ink-muted">Last carrier event</dt>
                <dd className="tabular">{formatDateTime(exception.lastEventAt)}</dd>
              </div>
            </dl>
            {exception.detail ? (
              <p className="mt-3 rounded-lg border border-line bg-surface-sunken p-3 text-[13px] text-ink">
                {exception.detail}
              </p>
            ) : null}
            {exception.resolvedAt ? (
              <p className="mt-3 text-[13px] text-ink-muted">
                {exception.status === 'dismissed' ? 'Dismissed' : 'Resolved'} {relativeTime(exception.resolvedAt)}
                {exception.resolutionReason ? `: ${exception.resolutionReason}` : ''}
              </p>
            ) : null}
          </Card>

          {isOpen ? (
            <Card title="Resolve" description="Record what you did. The reason is kept with the exception permanently.">
              {!resolveOpen ? (
                <Button variant="primary" disabled={!canResolve} onClick={() => setResolveOpen(true)}>
                  {canResolve ? 'Resolve this exception' : 'Your role cannot resolve exceptions'}
                </Button>
              ) : (
                <form
                  className="space-y-4"
                  noValidate
                  onSubmit={(event) => {
                    event.preventDefault();
                    setError(null);
                    if (resolution.reason.trim().length < 3) {
                      setError('Give a reason of at least 3 characters.');
                      return;
                    }
                    resolve.mutate();
                  }}
                >
                  {error ? (
                    <p role="alert" className="text-[13px] text-[color:var(--color-danger)]">{error}</p>
                  ) : null}
                  <Field label="Outcome" required>
                    {({ id }) => (
                      <Select
                        id={id}
                        value={resolution.status}
                        onChange={(event) =>
                          setResolution({ ...resolution, status: event.target.value as 'resolved' | 'dismissed' })
                        }
                      >
                        <option value="resolved">Resolved — the problem was fixed</option>
                        <option value="dismissed">Dismissed — not a real problem</option>
                      </Select>
                    )}
                  </Field>
                  <Field label="Reason" required hint="Shown to your team and kept in the audit trail.">
                    {({ id, describedBy }) => (
                      <Textarea
                        id={id}
                        rows={3}
                        aria-describedby={describedBy}
                        value={resolution.reason}
                        onChange={(event) => setResolution({ ...resolution, reason: event.target.value })}
                        required
                      />
                    )}
                  </Field>
                  {resolve.error instanceof ApiError ? (
                    <p role="alert" className="text-[13px] text-[color:var(--color-danger)]">
                      {resolve.error.message}
                    </p>
                  ) : null}
                  <div className="flex gap-2">
                    <Button type="submit" variant="primary" loading={resolve.isPending}>
                      Save outcome
                    </Button>
                    <Button type="button" variant="ghost" onClick={() => setResolveOpen(false)}>
                      Cancel
                    </Button>
                  </div>
                </form>
              )}
            </Card>
          ) : null}

          <Card title="Comments">
            {comments.length === 0 ? (
              <p className="text-[13px] text-ink-muted">No comments yet.</p>
            ) : (
              <ul className="space-y-3">
                {comments.map((entry) => (
                  <li key={entry.id} className="rounded-lg border border-line p-3">
                    <div className="mb-1 flex items-center gap-2 text-xs text-ink-muted">
                      <span className="font-medium text-ink">{entry.authorName ?? entry.authorEmail}</span>
                      <span aria-hidden="true">·</span>
                      <span className="tabular">{formatDateTime(entry.createdAt)}</span>
                      <span
                        className={
                          entry.visibility === 'customer'
                            ? 'ml-auto rounded bg-brand-50 px-1.5 py-0.5 text-[11px] font-medium text-brand-700 uppercase'
                            : 'ml-auto rounded bg-surface-sunken px-1.5 py-0.5 text-[11px] font-medium text-ink-muted uppercase'
                        }
                      >
                        {entry.visibility === 'customer' ? 'customer visible' : 'internal'}
                      </span>
                    </div>
                    <p className="text-[13px] text-ink">{entry.comment}</p>
                  </li>
                ))}
              </ul>
            )}

            {canComment ? (
              <form
                className="mt-4 space-y-3"
                noValidate
                onSubmit={(event) => {
                  event.preventDefault();
                  if (comment.trim()) addComment.mutate();
                }}
              >
                <Field label="Add a comment" required>
                  {({ id, describedBy }) => (
                    <Textarea
                      id={id}
                      rows={3}
                      aria-describedby={describedBy}
                      value={comment}
                      onChange={(event) => setComment(event.target.value)}
                      required
                    />
                  )}
                </Field>
                <div className="flex flex-wrap items-end gap-3">
                  <Field label="Visibility" hint="Customer-visible comments are shown on the tracking page.">
                    {({ id }) => (
                      <Select
                        id={id}
                        value={visibility}
                        onChange={(event) => setVisibility(event.target.value as 'internal' | 'customer')}
                      >
                        {COMMENT_VISIBILITIES.map((value) => (
                          <option key={value} value={value}>
                            {value === 'internal' ? 'Internal only' : 'Customer visible'}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  <Button type="submit" variant="secondary" loading={addComment.isPending}>
                    Post comment
                  </Button>
                </div>
              </form>
            ) : null}
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
          <Card title="Shipment">
            <dl className="space-y-2 text-[13px]">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-ink-muted">Tracking</dt>
                <dd className="tabular">
                  <Link to={`/${activeOrganizationId}/shipments/${exception.shipmentId}`} className="text-ink underline">
                    {exception.trackingNumber}
                  </Link>
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-ink-muted">Carrier</dt>
                <dd className="text-ink">{exception.carrierName}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-ink-muted">Customer</dt>
                <dd className="text-ink">{exception.customerName ?? '—'}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-ink-muted">Status</dt>
                <dd><ShipmentStatusBadge status={exception.shipmentStatus} /></dd>
              </div>
            </dl>
            <Link
              to={`/${activeOrganizationId}/shipments/${exception.shipmentId}`}
              className="mt-3 inline-block text-[13px] text-brand-700 underline"
            >
              Open the shipment
            </Link>
          </Card>

          {isOpen ? (
            <Card title="Triage">
              <div className="space-y-3">
                {exception.status === 'open' ? (
                  <Button
                    className="w-full"
                    variant="secondary"
                    loading={acknowledge.isPending}
                    onClick={() => acknowledge.mutate()}
                  >
                    Acknowledge
                  </Button>
                ) : null}
                <Field label="Assign to" hint="Assigning is optional, but it shows who owns the fix.">
                  {({ id, describedBy }) => (
                    <Select
                      id={id}
                      aria-describedby={describedBy}
                      value={exception.assignedUserId ?? ''}
                      onChange={(event) => assign.mutate(event.target.value || null)}
                    >
                      <option value="">Unassigned</option>
                      {user ? <option value={user.id}>Me ({user.email})</option> : null}
                    </Select>
                  )}
                </Field>
              </div>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}