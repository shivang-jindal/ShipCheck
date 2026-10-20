import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { loginSchema, type AuthSessionResponse } from '@shipcheck/shared';

import { Button, Field, Input } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useSession } from '../lib/session';
import { AuthLayout, FormError } from './AuthLayout';

export function LoginPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { refresh } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string[]>>({});

  const mutation = useMutation({
    mutationFn: () => {
      const parsed = loginSchema.safeParse({ email, password });
      if (!parsed.success) {
        const fields: Record<string, string[]> = {};
        for (const issue of parsed.error.issues) {
          const key = issue.path.join('.') || 'form';
          (fields[key] ??= []).push(issue.message);
        }
        setErrors(fields);
        return Promise.reject(new ApiError(400, null, 'Please fix the highlighted fields.'));
      }
      return api.post<AuthSessionResponse>('/auth/login', parsed.data);
    },
    onSuccess: async (session) => {
      queryClient.clear();
      await refresh();
      const first = session.memberships[0];
      navigate(first ? `/${first.organizationId}/dashboard` : '/welcome', { replace: true });
    },
  });

  return (
    <AuthLayout
      title="Sign in to ShipCheck"
      description="Invoice, track payments and follow up on overdue balances."
      footer={
        <>
          No account yet?{' '}
          <Link to="/register">Create one</Link>
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

        <Field label="Email" required error={errors.email?.[0]}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              invalid={invalid}
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          )}
        </Field>

        <Field label="Password" required error={errors.password?.[0]}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              invalid={invalid}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          )}
        </Field>

        <Button type="submit" variant="primary" loading={mutation.isPending} className="w-full">
          Sign in
        </Button>

        <Link className="block text-center text-[13px]" to="/forgot-password">
          Forgot your password?
        </Link>
      </form>
    </AuthLayout>
  );
}