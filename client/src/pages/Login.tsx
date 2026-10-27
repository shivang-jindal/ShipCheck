import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';

import type { AuthSessionResponse } from '@shipcheck/shared';

import { GoogleSignInButton } from '../components/GoogleSignInButton';
import { useSession } from '../lib/session';
import { AuthLayout } from './AuthLayout';

/**
 * The only way in. There is deliberately no password form, registration page or
 * reset link: accounts are created by Google on first sign-in.
 */
export function LoginPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { refresh } = useSession();

  async function completeSignIn(session: AuthSessionResponse) {
    queryClient.clear();
    await refresh();
    const first = session.memberships[0];
    navigate(first ? `/${first.organizationId}/dashboard` : '/welcome', { replace: true });
  }

  return (
    <AuthLayout
      title="Sign in to ShipCheck"
      description="Google is the only sign-in method. There is no password to create, remember or reset."
    >
      <GoogleSignInButton onSignedIn={completeSignIn} />
    </AuthLayout>
  );
}