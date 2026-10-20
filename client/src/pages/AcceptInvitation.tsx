import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';

import { acceptInvitationSchema } from '@shipcheck/shared';

import { Button, Spinner } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useSession } from '../lib/session';
import { AuthLayout, FormError } from './AuthLayout';

export function AcceptInvitationPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { refresh } = useSession();
  const token = searchParams.get('token') ?? '';
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => {
      const parsed = acceptInvitationSchema.safeParse({ token });
      if (!parsed.success) throw new ApiError(400, null, 'This invitation link is not valid.');
      return api.post<{ organization: { id: string } }>('/auth/accept-invitation', parsed.data);
    },
    onSuccess: async (result) => {
      await refresh();
      navigate(`/${result.organization.id}/dashboard`, { replace: true });
    },
    onError: (mutationError: unknown) => {
      setError(mutationError instanceof ApiError ? mutationError.message : 'Could not accept the invitation.');
    },
  });

  return (
    <AuthLayout title="Join the organization" description="Invitations are single-use and expire after 7 days.">
      <div className="space-y-4">
        <FormError message={error} />
        {mutation.isPending ? (
          <p className="flex items-center gap-2 text-[13px] text-ink-muted">
            <Spinner /> Joining…
          </p>
        ) : (
          <Button
            variant="primary"
            className="w-full"
            disabled={!token}
            onClick={() => mutation.mutate()}
          >
            Accept invitation
          </Button>
        )}
      </div>
    </AuthLayout>
  );
}