/** Modal / ConfirmDialog with focus management (WCAG 2.2 AA). */

import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';

import { Button } from './ui';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'md' | 'lg';
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !panel) return;
      // Trap focus inside the dialog.
      const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) => element.offsetParent !== null,
      );
      if (focusable.length === 0) return;
      const firstElement = focusable[0]!;
      const lastElement = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && document.activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      previousFocus.current?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 p-0 sm:items-center sm:p-4">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`card w-full ${size === 'lg' ? 'sm:max-w-2xl' : 'sm:max-w-md'} max-h-[90vh] overflow-y-auto rounded-b-none sm:rounded-b-[var(--radius-card)]`}
      >
        <header className="border-b border-line px-4 py-3">
          <h2>{title}</h2>
          {description ? <div className="mt-1 text-[13px] text-ink-muted">{description}</div> : null}
        </header>
        {children ? <div className="px-4 py-4">{children}</div> : null}
        {footer ? (
          <footer className="flex flex-wrap justify-end gap-2 border-t border-line px-4 py-3">{footer}</footer>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Destructive actions require a confirmation with a clear, specific summary -
 * never a generic "Are you sure?".
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  summary,
  confirmLabel,
  tone = 'danger',
  requirePhrase,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  title: string;
  summary: ReactNode;
  confirmLabel: string;
  tone?: 'danger' | 'primary';
  requirePhrase?: string;
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const locked = requirePhrase ? value !== requirePhrase : false;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            disabled={locked || busy}
            loading={busy}
            onClick={() => {
              setBusy(true);
              void Promise.resolve(onConfirm()).finally(() => setBusy(false));
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-[13px] text-ink-muted">{summary}</div>
      {requirePhrase ? (
        <label className="mt-3 block text-[13px] font-medium text-ink">
          Type <code className="rounded bg-surface-sunken px-1">{requirePhrase}</code> to confirm
          <input
            className="mt-1.5 w-full rounded-lg border border-line-strong bg-white px-3 py-2 text-sm"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            autoComplete="off"
          />
        </label>
      ) : null}
    </Modal>
  );
}