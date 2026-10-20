/** Shared layout for the signed-out screens. */

import type { ReactNode } from 'react';

import { Card } from '../components/ui';

export function AuthLayout({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-surface-sunken px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-brand-600 text-sm font-bold text-white">
            C
          </span>
          <span className="text-base font-semibold text-ink">ShipCheck</span>
        </div>
        <Card>
          <div className="px-5 py-5">
            <h1 className="text-lg">{title}</h1>
            {description ? <p className="mt-1 text-[13px] text-ink-muted">{description}</p> : null}
            <div className="mt-4">{children}</div>
          </div>
        </Card>
        {footer ? <div className="mt-4 text-center text-[13px] text-ink-muted">{footer}</div> : null}
        <p className="mt-6 text-center text-xs text-ink-subtle">
          ShipCheck is a shipment tracking tool. It records the tracking events it
          actually receives; it is not a carrier and does not guarantee delivery.
        </p>
      </div>
    </div>
  );
}

export function FormError({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-[color:var(--color-danger)]">
      {message}
    </p>
  );
}