import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';

import type { AuthSessionResponse } from '@shipcheck/shared';

import { api } from '../lib/api';
import {
  GoogleSignInCancelled,
  googleSignInConfigured,
  requestGoogleIdToken,
} from '../lib/firebase';
import { Button } from './ui';

function GoogleMark() {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 18 18" className="h-4 w-4">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.91c1.7-1.57 2.69-3.88 2.69-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.91-2.26c-.81.54-1.84.86-3.05.86-2.34 0-4.33-1.58-5.04-3.71H.96v2.33A9 9 0 0 0 9 18Z"
      />
      <path
        fill="#FBBC05"
        d="M3.96 10.71A5.41 5.41 0 0 1 3.68 9c0-.59.1-1.17.28-1.71V4.96H.96a9 9 0 0 0 0 8.08l3-2.33Z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.58A8.98 8.98 0 0 0 9 0 9 9 0 0 0 .96 4.96l3 2.33C4.67 5.16 6.66 3.58 9 3.58Z"
      />
    </svg>
  );
}

/**
 * "Continue with Google", the only sign-in method.
 *
 * The button is visible even when the deployment has no Firebase config, so the
 * layout is complete; it is disabled with an honest explanation rather than
 * pretending a click would work.
 */
export function GoogleSignInButton({
  onSignedIn,
}: {
  onSignedIn: (session: AuthSessionResponse) => void | Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      const idToken = await requestGoogleIdToken();
      return api.post<AuthSessionResponse>('/auth/google', { idToken });
    },
    onSuccess: (session) => onSignedIn(session),
    onError: (caught) => {
      if (caught instanceof GoogleSignInCancelled) return;
      setError(
        caught instanceof Error
          ? caught.message
          : 'Google sign-in failed. Please try again.',
      );
    },
  });

  return (
    <div className="mt-5">

      <Button
        type="button"
        variant="secondary"
        className="w-full"
        loading={mutation.isPending}
        disabled={!googleSignInConfigured}
        onClick={() => {
          setError(null);
          mutation.mutate();
        }}
      >
        <span className="flex items-center justify-center gap-2">
          <GoogleMark />
          Continue with Google
        </span>
      </Button>

      {!googleSignInConfigured ? (
        <p className="mt-2 text-center text-xs text-ink-subtle">
          Google sign-in is not configured on this deployment yet.
        </p>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="mt-2 text-center text-[13px] text-[color:var(--color-danger)]"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
