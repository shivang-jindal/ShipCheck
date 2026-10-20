import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';

import { forgotPasswordSchema } from '@shipcheck/shared';

import { Button, Field, Input } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { AuthLayout, FormError } from './AuthLayout';

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<{ message: string; resetEmailAvailable: boolean } | null>(null);

  const mutation = useMutation({
    mutationFn: () => {
      const parsed = forgotPasswordSchema.safeParse({ email });
      if (!parsed.success) throw new ApiError(400, null, 'Enter a valid email address.');
      return api.post<{ ok: boolean; message: string; resetEmailAvailable: boolean }>(
        '/auth/password/forgot',
        parsed.data,
      );
    },
    onSuccess: (result) => setSent({ message: result.message, resetEmailAvailable: result.resetEmailAvailable }),
  });

  return (
    <AuthLayout
      title="Reset your password"
      description="We will send a single-use link that expires in 60 minutes."
      footer={<Link to="/login">Back to sign in</Link>}
    >
      {sent ? (
        <div className="space-y-3">
          <FormError message={null} />
          <div className="rounded-lg border border-line bg-surface-sunken px-3 py-3 text-[13px] text-ink">
            <p>{sent.message}</p>
            {!sent.resetEmailAvailable ? (
              <p className="mt-2 text-ink-muted">
                No email provider is configured, so no reset email was actually sent. Configure SMTP in
                Integrations, or ask an administrator to reset your password.
              </p>
            ) : null}
          </div>
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate();
          }}
          noValidate
        >
          <FormError message={mutation.error instanceof ApiError ? mutation.error.message : null} />
          <Field label="Email" required>
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
          <Button type="submit" variant="primary" loading={mutation.isPending} className="w-full">
            Send reset link
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}