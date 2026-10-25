/**
 * Session + organization context.
 *
 * The organization in the URL is the source of truth; a change writes through
 * to the server so the switcher stays consistent across tabs.
 */

import type { ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate, useParams } from 'react-router-dom';

import type { AuthSessionResponse, MembershipSummary, SessionUser } from '@shipcheck/shared';

import { api } from '../lib/api';

interface SessionValue {
  user: SessionUser | null;
  memberships: MembershipSummary[];
  activeOrganizationId: string | null;
  activeOrganization: MembershipSummary | null;
  role: string | null;
  permissions: string[];
  loading: boolean;
  switchOrganization: (organizationId: string) => Promise<void>;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams();

  const session = useQuery({
    queryKey: ['session'],
    queryFn: () => api.get<AuthSessionResponse>('/auth/session'),
    retry: false,
    staleTime: 60_000,
  });

  const switchMutation = useMutation({
    mutationFn: (organizationId: string) =>
      api.post<AuthSessionResponse>(`/auth/organizations/${organizationId}/switch`),
    onSuccess: () => {
      void queryClient.invalidateQueries();
    },
  });

  const signOut = useCallback(async () => {
    await api.post('/auth/logout');
    queryClient.clear();
    navigate('/login', { replace: true });
  }, [navigate, queryClient]);

  const urlOrganizationId = params.organizationId ?? null;
  const memberships = session.data?.memberships ?? [];
  const activeOrganizationId = urlOrganizationId ?? session.data?.activeOrganizationId ?? null;
  const activeOrganization = useMemo(
    () => memberships.find((membership) => membership.organizationId === activeOrganizationId) ?? null,
    [memberships, activeOrganizationId],
  );

  // Keep the server session pointer aligned with the URL.
  useEffect(() => {
    if (!urlOrganizationId || !session.data) return;
    if (session.data.activeOrganizationId === urlOrganizationId) return;
    if (!memberships.some((membership) => membership.organizationId === urlOrganizationId)) return;
    switchMutation.mutate(urlOrganizationId);
  }, [urlOrganizationId, session.data?.activeOrganizationId]);

  const value = useMemo<SessionValue>(
    () => ({
      user: session.data?.user ?? null,
      memberships,
      activeOrganizationId,
      activeOrganization,
      role: activeOrganization?.role ?? null,
      permissions: activeOrganization?.permissions ?? [],
      loading: session.isLoading,
      switchOrganization: async (organizationId: string) => {
        await switchMutation.mutateAsync(organizationId);
        const section = location.pathname.split('/').filter(Boolean)[1];
        navigate(section ? `/${organizationId}/${section}` : `/${organizationId}`);
      },
      refresh: async () => {
        await session.refetch();
      },
      signOut,
    }),
    [session, memberships, activeOrganizationId, activeOrganization, switchMutation, signOut, location, navigate],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside <SessionProvider>');
  return context;
}

/** Returns false rather than throwing when the user lacks a permission. */
export function usePermission(permission: string): boolean {
  const { permissions } = useSession();
  return permissions.includes(permission);
}