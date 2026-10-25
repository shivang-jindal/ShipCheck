import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';

import { registerSchema, type AuthSessionResponse } from '@shipcheck/shared';

import { Button, Field, Input } from '../components/ui';
import { GoogleSignInButton } from '../components/GoogleSignInButton';
import { api, ApiError } from '../lib/api';
import { useSession } from '../lib/session';
import { AuthLayout, FormError } from './AuthLayout';

export function RegisterPage() {
  const navigate = useNavigate();
  const { refresh } = useSession();
  const [form, setForm] = useState({ displayName: '', email: '', password: '' });
  const [errors, setErrors] = useState<Record<string, string[]>>({});

  async function completeSignIn(session: AuthSessionResponse) {
    await refresh();
    const first = session.memberships[0];
    // A brand-new account has no workspace yet; an existing Google account may.
    navigate(first ? `/${first.organizationId}/dashboard` : '/welcome', { replace: true });
  }

  const mutation = useMutation({
    mutationFn: () => {
      const parsed = registerSchema.safeParse(form);
      if (!parsed.success) {
        const fields: Record<string, string[]> = {};
        for (const issue of parsed.error.issues) {
          const key = issue.path.join('.') || 'form';
          (fields[key] ??= []).push(issue.message);
        }
        setErrors(fields);
        return Promise.reject(new ApiError(400, null, 'Please fix the highlighted fields.'));
      }
      return api.post<AuthSessionResponse>('/auth/register', parsed.data);
    },
    onSuccess: completeSignIn,
  });

  return (
    <AuthLayout
      title="Create your ShipCheck account"
      description="You will set up your business workspace next."
      footer={
        <>
          Already registered? <Link to="/login">Sign in</Link>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          setErrors({});
          mutation.mutate();
        }}
        noValidate
      >
        <FormError message={mutation.error instanceof ApiError ? mutation.error.message : null} />

        <Field label="Your name" required error={errors.displayName?.[0]}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              invalid={invalid}
              autoComplete="name"
              value={form.displayName}
              onChange={(event) => setForm({ ...form, displayName: event.target.value })}
              required
            />
          )}
        </Field>

        <Field label="Email" required error={errors.email?.[0]}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              invalid={invalid}
              type="email"
              autoComplete="email"
              value={form.email}
              onChange={(event) => setForm({ ...form, email: event.target.value })}
              required
            />
          )}
        </Field>

        <Field
          label="Password"
          required
          error={errors.password?.[0]}
          hint="At least 10 characters. Store it in a password manager."
        >
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              invalid={invalid}
              type="password"
              autoComplete="new-password"
              value={form.password}
              onChange={(event) => setForm({ ...form, password: event.target.value })}
              required
            />
          )}
        </Field>

        <Button type="submit" variant="primary" loading={mutation.isPending} className="w-full">
          Create account
        </Button>
      </form>

      <GoogleSignInButton onSignedIn={completeSignIn} />
    </AuthLayout>
  );
}