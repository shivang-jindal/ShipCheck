import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';

import { resetPasswordSchema } from '@shipcheck/shared';

import { Button, Field, Input } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { AuthLayout, FormError } from './AuthLayout';

export function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<string[]>([]);

  const mutation = useMutation({
    mutationFn: () => {
      const parsed = resetPasswordSchema.safeParse({ token, password });
      if (!parsed.success) {
        setErrors(parsed.error.issues.map((issue) => issue.message));
        return Promise.reject(new ApiError(400, null, 'Please fix the highlighted fields.'));
      }
      return api.post<void>('/auth/password/reset', parsed.data);
    },
    onSuccess: () => navigate('/login', { replace: true }),
  });

  return (
    <AuthLayout
      title="Choose a new password"
      description={token ? 'Your reset link is valid for 60 minutes.' : 'This link is missing its token.'}
      footer={<Link to="/login">Back to sign in</Link>}
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          setErrors([]);
          mutation.mutate();
        }}
        noValidate
      >
        <FormError message={mutation.error instanceof ApiError ? mutation.error.message : null} />
        <Field label="New password" required error={errors[0]} hint="At least 10 characters.">
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              invalid={invalid}
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={!token}
              required
            />
          )}
        </Field>
        <Button type="submit" variant="primary" loading={mutation.isPending} className="w-full" disabled={!token}>
          Update password
        </Button>
      </form>
    </AuthLayout>
  );
}