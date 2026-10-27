/** Workspace settings: profile, members, audit and danger zone. */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { ROLES, ROLE_LABELS, type Role } from '@shipcheck/shared';

import { api, ApiError } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { usePermission, useSession } from '../lib/session';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  PageHeader,
  Select,
} from '../components/ui';

interface OrganizationResponse {
  organization: {
    id: string;
    name: string;
    slug: string;
    countryCode: string;
    timezone: string;
    baseCurrency: string;
    createdAt: string;
  };
  role: string;
  permissions: string[];
}

interface Member {
  id: string;
  email: string;
  displayName: string | null;
  role: string;
  status: string;
  joinedAt: string | null;
  createdAt: string;
}

interface AuditEntry {
  id: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  actorEmail: string | null;
  createdAt: string;
}

export function SettingsPage() {
  const { activeOrganizationId, role, signOut } = useSession();
  const queryClient = useQueryClient();
  const canManageSettings = usePermission('settings.manage');
  const canManageMembers = usePermission('member.manage');

  const [name, setName] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'admin' | 'member' | 'viewer'>('member');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);

  const organization = useQuery({
    queryKey: ['shipcheck', activeOrganizationId, 'organization'],
    queryFn: () => api.get<OrganizationResponse>(`/${activeOrganizationId}`),
    enabled: Boolean(activeOrganizationId),
  });

  const members = useQuery({
    queryKey: ['shipcheck', activeOrganizationId, 'members'],
    queryFn: () => api.get<{ members: Member[] }>(`/${activeOrganizationId}/members`),
    enabled: Boolean(activeOrganizationId),
  });

  const audit = useQuery({
    queryKey: ['shipcheck', activeOrganizationId, 'audit'],
    queryFn: () =>
      api.get<{ entries: AuditEntry[] }>(`/${activeOrganizationId}/audit?page=1&pageSize=50`),
    enabled: Boolean(activeOrganizationId && usePermission('audit.view')),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['shipcheck', activeOrganizationId] });
  };

  const saveProfile = useMutation({
    mutationFn: () =>
      api.patch(`/${activeOrganizationId}`, { name: (name ?? organization.data?.organization.name ?? '').trim() }),
    onSuccess: () => {
      setError(null);
      setNotice('Workspace details saved.');
      invalidate();
    },
    onError: (cause) => {
      setNotice(null);
      setError(cause instanceof ApiError ? cause.message : 'Could not save.');
    },
  });

  const invite = useMutation({
    mutationFn: () =>
      api.post<{ invitation: { acceptUrl?: string; emailed: boolean } }>(
        `/${activeOrganizationId}/members/invitations`,
        { email: inviteEmail.trim(), role: inviteRole },
      ),
    onSuccess: (data) => {
      setError(null);
      setInviteEmail('');
      setInviteUrl(data.invitation.acceptUrl ?? null);
      setNotice(
        data.invitation.emailed
          ? 'Invitation queued for delivery.'
          : 'Invitation created. No email provider is configured, so copy the link below.',
      );
      invalidate();
    },
    onError: (cause) => {
      setNotice(null);
      setError(cause instanceof ApiError ? cause.message : 'Could not create the invitation.');
    },
  });

  const changeRole = useMutation({
    mutationFn: ({ memberId, nextRole }: { memberId: string; nextRole: string }) =>
      api.patch(`/${activeOrganizationId}/members/${memberId}`, { role: nextRole }),
    onSuccess: invalidate,
  });

  const removeMember = useMutation({
    mutationFn: (memberId: string) => api.del(`/${activeOrganizationId}/members/${memberId}`),
    onSuccess: invalidate,
  });

  if (organization.isError) {
    return (
      <>
        <PageHeader title="Settings" />
        <Card>
          <ErrorState message="Could not load the workspace." onRetry={() => void organization.refetch()} />
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Settings" description="Workspace, team and audit trail." />

      {error ? (
        <p role="alert" className="mb-4 text-[13px] text-[color:var(--color-danger)]">{error}</p>
      ) : null}
      {notice ? (
        <p role="status" className="mb-4 text-[13px] text-[color:var(--color-success)]">{notice}</p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Workspace">
          <form
            className="space-y-4"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              saveProfile.mutate();
            }}
          >
            <Field label="Workspace name" required>
              {({ id }) => (
                <Input
                  id={id}
                  value={name ?? organization.data?.organization.name ?? ''}
                  disabled={!canManageSettings}
                  onChange={(event) => setName(event.target.value)}
                  required
                />
              )}
            </Field>
            <dl className="grid gap-2 text-[13px] sm:grid-cols-2">
              <div>
                <dt className="text-ink-muted">Country</dt>
                <dd className="text-ink">{organization.data?.organization.countryCode}</dd>
              </div>
              <div>
                <dt className="text-ink-muted">Timezone</dt>
                <dd className="text-ink">{organization.data?.organization.timezone}</dd>
              </div>
              <div>
                <dt className="text-ink-muted">Your role</dt>
                <dd className="text-ink">{role ? ROLE_LABELS[role as Role] ?? role : '—'}</dd>
              </div>
              <div>
                <dt className="text-ink-muted">Created</dt>
                <dd className="tabular text-ink">
                  {formatDateTime(organization.data?.organization.createdAt)}
                </dd>
              </div>
            </dl>
            {canManageSettings ? (
              <Button type="submit" variant="primary" loading={saveProfile.isPending}>
                Save
              </Button>
            ) : (
              <p className="text-[13px] text-ink-muted">
                Your role cannot change workspace settings.
              </p>
            )}
          </form>
        </Card>

        <Card title="Invite a teammate">
          {canManageMembers ? (
            <form
              className="space-y-4"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                invite.mutate();
              }}
            >
              <Field label="Email" required>
                {({ id }) => (
                  <Input
                    id={id}
                    type="email"
                    value={inviteEmail}
                    onChange={(event) => setInviteEmail(event.target.value)}
                    required
                  />
                )}
              </Field>
              <Field label="Role" required hint="Viewers can read but not change anything.">
                {({ id, describedBy }) => (
                  <Select
                    id={id}
                    aria-describedby={describedBy}
                    value={inviteRole}
                    onChange={(event) => setInviteRole(event.target.value as 'admin' | 'member' | 'viewer')}
                  >
                    {(['admin', 'member', 'viewer'] as const).map((value) => (
                      <option key={value} value={value}>
                        {ROLE_LABELS[value]}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Button type="submit" variant="primary" loading={invite.isPending}>
                Send invitation
              </Button>
              {inviteUrl ? (
                <div className="rounded-lg border border-line bg-surface-sunken p-3">
                  <p className="text-[13px] text-ink">
                    Share this link directly. It is shown once.
                  </p>
                  <p className="tabular mt-1 break-all text-xs text-ink-muted">{inviteUrl}</p>
                </div>
              ) : null}
            </form>
          ) : (
            <p className="text-[13px] text-ink-muted">
              Your role cannot invite teammates.
            </p>
          )}
        </Card>
      </div>

      <Card className="mt-4" title="Team">
        {members.isLoading ? (
          <p className="text-[13px] text-ink-muted">Loading…</p>
        ) : members.isError ? (
          <ErrorState message="Could not load members." onRetry={() => void members.refetch()} />
        ) : (members.data?.members ?? []).length === 0 ? (
          <EmptyState title="No members" description="This workspace has no members." />
        ) : (
          <table className="w-full text-left text-[13px]">
            <caption className="sr-only">Workspace members</caption>
            <thead>
              <tr className="border-b border-line text-xs text-ink-muted uppercase">
                <th scope="col" className="py-2 font-semibold">Member</th>
                <th scope="col" className="py-2 font-semibold">Role</th>
                <th scope="col" className="py-2 font-semibold">Status</th>
                <th scope="col" className="py-2 font-semibold">Joined</th>
                <th scope="col" className="py-2 text-right font-semibold">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {(members.data?.members ?? []).map((member) => (
                <tr key={member.id} className="border-b border-line last:border-0">
                  <td className="py-2">
                    <span className="block text-ink">{member.displayName ?? member.email}</span>
                    <span className="block text-xs text-ink-muted">{member.email}</span>
                  </td>
                  <td className="py-2">
                    {canManageMembers ? (
                      <Select
                        aria-label={`Role for ${member.email}`}
                        value={member.role}
                        onChange={(event) =>
                          changeRole.mutate({ memberId: member.id, nextRole: event.target.value })
                        }
                      >
                        {(['admin', 'member', 'viewer'] as const).map((value) => (
                          <option key={value} value={value}>
                            {ROLE_LABELS[value]}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <span>{ROLE_LABELS[member.role as Role] ?? member.role}</span>
                    )}
                  </td>
                  <td className="py-2">
                    <Badge tone={member.status === 'active' ? 'success' : 'neutral'}>{member.status}</Badge>
                  </td>
                  <td className="tabular py-2">{formatDateTime(member.joinedAt)}</td>
                  <td className="py-2 text-right">
                    {canManageMembers && member.role !== 'owner' ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={removeMember.isPending}
                        onClick={() => removeMember.mutate(member.id)}
                      >
                        Remove
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {usePermission('audit.view') ? (
        <Card
          className="mt-4"
          title="Audit trail"
          description="Every change to a shipment, exception or setting, with who made it."
        >
          {audit.isError ? (
            <ErrorState message="Could not load the audit trail." onRetry={() => void audit.refetch()} />
          ) : (audit.data?.entries ?? []).length === 0 ? (
            <EmptyState title="Nothing recorded yet" description="The audit trail is empty." />
          ) : (
            <ul className="divide-y divide-line">
              {(audit.data?.entries ?? []).map((entry) => (
                <li key={entry.id} className="flex items-baseline justify-between gap-3 py-2">
                  <span className="min-w-0">
                    <span className="block text-[13px] text-ink">
                      {entry.action.replace(/[._]/g, ' ')}
                    </span>
                    <span className="block text-xs text-ink-muted">
                      {entry.actorEmail ?? 'system'}
                      {entry.entityType ? ` · ${entry.entityType}` : ''}
                    </span>
                  </span>
                  <span className="tabular shrink-0 text-xs text-ink-subtle">
                    {formatDateTime(entry.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}

      <Card className="mt-4" title="Your account">
        <p className="text-[13px] text-ink-muted">
          Signed in as {useSessionEmail()}. ShipCheck uses Google as its only sign-in method, so
          there is no password to change or reset. To use a different account, sign out and choose
          it on the Google screen.
        </p>
        <Button className="mt-3" variant="secondary" onClick={() => void signOut()}>
          Sign out
        </Button>
      </Card>

      <p className="mt-4 text-xs text-ink-subtle">
        Roles available: {ROLES.map((value) => ROLE_LABELS[value]).join(', ')}.
      </p>
    </>
  );
}

/** Small helper so the account card can name the signed-in user. */
function useSessionEmail(): string {
  const { user } = useSession();
  return user?.email ?? 'your account';
}