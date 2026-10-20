import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';

import { createOrganizationSchema } from '@shipcheck/shared';

import { Button, Card, Field, Input, Select } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useSession } from '../lib/session';

const TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Dublin',
  'Europe/Berlin',
  'Europe/Paris',
  'Europe/Madrid',
  'Europe/Amsterdam',
  'Europe/Stockholm',
  'Europe/Warsaw',
  'Africa/Lagos',
  'Africa/Cairo',
  'Africa/Johannesburg',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Karachi',
  'Asia/Bangkok',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Australia/Sydney',
  'Pacific/Auckland',
];

export function CreateOrganizationPage() {
  const navigate = useNavigate();
  const { refresh } = useSession();
  const [form, setForm] = useState({
    name: '',
    countryCode: 'US',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    baseCurrency: 'USD',
  });
  const [errors, setErrors] = useState<Record<string, string[]>>({});

  const mutation = useMutation({
    mutationFn: () => {
      const parsed = createOrganizationSchema.safeParse(form);
      if (!parsed.success) {
        const fields: Record<string, string[]> = {};
        for (const issue of parsed.error.issues) {
          const key = issue.path.join('.') || 'form';
          (fields[key] ??= []).push(issue.message);
        }
        setErrors(fields);
        return Promise.reject(new ApiError(400, null, 'Please fix the highlighted fields.'));
      }
      return api.post<{ organization: { id: string } }>('/auth/organizations', parsed.data);
    },
    onSuccess: async (result) => {
      await refresh();
      navigate(`/${result.organization.id}/settings`, { replace: true });
    },
  });

  const timezoneOptions = TIMEZONES.includes(form.timezone)
    ? TIMEZONES
    : [form.timezone, ...TIMEZONES];

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-sunken px-4 py-10">
      <Card className="w-full max-w-lg">
        <div className="px-5 py-5">
          <h1 className="text-lg">Set up your business workspace</h1>
          <p className="mt-1 text-[13px] text-ink-muted">
            Country and timezone are used for stalled-shipment detection, exception
            ageing and daily reports. You can change them later in Settings.
          </p>

          <form
            className="mt-5 space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              setErrors({});
              mutation.mutate();
            }}
            noValidate
          >
            <p
              role="alert"
              className={
                mutation.error instanceof ApiError
                  ? 'rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-[color:var(--color-danger)]'
                  : 'hidden'
              }
            >
              {mutation.error instanceof ApiError ? mutation.error.message : ''}
            </p>

            <Field label="Business name" required error={errors.name?.[0]}>
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  invalid={invalid}
                  value={form.name}
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                  placeholder="Studio North"
                  required
                />
              )}
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Country" required error={errors.countryCode?.[0]} hint="Two-letter ISO code.">
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    invalid={invalid}
                    maxLength={2}
                    value={form.countryCode}
                    onChange={(event) =>
                      setForm({ ...form, countryCode: event.target.value.toUpperCase() })
                    }
                    required
                  />
                )}
              </Field>

              <Field label="Base currency" required error={errors.baseCurrency?.[0]} hint="Used for display only. ShipCheck does not handle money.">
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    invalid={invalid}
                    maxLength={3}
                    value={form.baseCurrency}
                    onChange={(event) =>
                      setForm({ ...form, baseCurrency: event.target.value.toUpperCase() })
                    }
                    required
                  />
                )}
              </Field>
            </div>

            <Field
              label="Timezone"
              required
              error={errors.timezone?.[0]}
              hint="Stalled-shipment detection and exception ageing follow this timezone."
            >
              {({ id, describedBy, invalid }) => (
                <Select
                  id={id}
                  aria-describedby={describedBy}
                  invalid={invalid}
                  value={form.timezone}
                  onChange={(event) => setForm({ ...form, timezone: event.target.value })}
                >
                  {timezoneOptions.map((zone) => (
                    <option key={zone} value={zone}>
                      {zone}
                    </option>
                  ))}
                </Select>
              )}
            </Field>

            <Button type="submit" variant="primary" loading={mutation.isPending} className="w-full">
              Create workspace
            </Button>
          </form>
        </div>
      </Card>
    </div>
  );
}