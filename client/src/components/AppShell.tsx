/** AppShell: sidebar, header, organization switcher, profile menu. */

import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';

import { classNames } from '../lib/format';
import { useSession } from '../lib/session';
import { Button } from './ui';

interface NavItem {
  to: string;
  label: string;
  icon: React.ReactNode;
  end?: boolean;
}

const NAV: NavItem[] = [
  {
    to: '/dashboard',
    label: 'Dashboard',
    icon: <Icon path="M3 10.5 10 4l7 6.5M5 9.5V16h10V9.5" />,
  },
  {
    to: '/shipments',
    label: 'Shipments',
    icon: <Icon path="M2.5 6.5h9v7h-9zM11.5 9h3l3 2.5v2h-6zM6 16a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM14 16a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" />,
  },
  {
    to: '/exceptions',
    label: 'Exceptions',
    icon: <Icon path="M10 6.5v4.5M10 14h.01M8.6 2.9 2.3 14.4A1.6 1.6 0 0 0 3.7 17h12.6a1.6 1.6 0 0 0 1.4-2.6L11.4 2.9a1.6 1.6 0 0 0-2.8 0Z" />,
  },
  {
    to: '/imports',
    label: 'CSV import',
    icon: <Icon path="M10 3v8m0 0 3-3m-3 3L7 8M3.5 13.5v2a1.5 1.5 0 0 0 1.5 1.5h10a1.5 1.5 0 0 0 1.5-1.5v-2" />,
  },
  {
    to: '/analytics',
    label: 'Analytics',
    icon: <Icon path="M4 16V9M8 16V5M12 16v-4M16 16V7" />,
  },
  {
    to: '/notifications',
    label: 'Notifications',
    icon: <Icon path="M10 3a5 5 0 0 0-5 5v3l-1.5 2.5h13L15 11V8a5 5 0 0 0-5-5ZM8 15a2 2 0 0 0 4 0" />,
  },
  {
    to: '/carriers',
    label: 'Carriers',
    icon: <Icon path="M8 5H6a3 3 0 0 0 0 6h1M12 5h2a3 3 0 0 1 0 6h-1M7 10h6" />,
  },
  {
    to: '/settings',
    label: 'Settings',
    icon: <Icon path="M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM10 2.5v2M10 15.5v2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M2.5 10h2M15.5 10h2M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" />,
  },
];

function Icon({ path }: { path: string }) {
  return (
    <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d={path}
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { activeOrganization, activeOrganizationId, memberships, signOut, user, switchOrganization } = useSession();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    setMobileNavOpen(false);
  }, [location.pathname]);

  const base = `/${activeOrganizationId}`;

  const navigation = (
    <nav aria-label="Main" className="flex flex-1 flex-col gap-0.5 p-2">
      {NAV.map((item) => (
        <NavLink
          key={item.to}
          to={`${base}${item.to}`}
          end={false}
          className={({ isActive }) =>
            classNames(
              'flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium no-underline transition-colors',
              isActive ? 'bg-brand-50 text-brand-700' : 'text-ink-muted hover:bg-surface-sunken hover:text-ink',
            )
          }
        >
          {item.icon}
          {item.label}
        </NavLink>
      ))}
    </nav>
  );

  return (
    <div className="flex min-h-screen">
      <a href="#main" className="skip-link">
        Skip to main content
      </a>

      {/* Desktop sidebar */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-line bg-white lg:flex">
        <Brand organizationName={activeOrganization?.organizationName ?? 'ShipCheck'} />
        {navigation}
        <footer className="border-t border-line p-3 text-xs text-ink-subtle">
          ShipCheck records the tracking events it actually receives. It does not
          contact carriers unless an adapter is connected.
        </footer>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-line bg-white/95 px-4 py-2.5 backdrop-blur">
          <Button
            variant="ghost"
            size="sm"
            className="lg:hidden"
            aria-expanded={mobileNavOpen}
            aria-controls="mobile-nav"
            onClick={() => setMobileNavOpen((open) => !open)}
          >
            <span className="sr-only">{mobileNavOpen ? 'Close navigation' : 'Open navigation'}</span>
            <svg className="h-5 w-5" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </Button>

          <OrganizationSwitcher
            memberships={memberships}
            activeId={activeOrganizationId}
            onSwitch={(id) => void switchOrganization(id)}
          />

          <div className="ml-auto flex items-center gap-2">
            <ProfileMenu
              name={user?.displayName ?? ''}
              email={user?.email ?? ''}
              settingsHref={`${base}/settings`}
              onSignOut={() => void signOut()}
            />
          </div>
        </header>

        {mobileNavOpen ? (
          <div id="mobile-nav" className="border-b border-line bg-white lg:hidden">
            {navigation}
          </div>
        ) : null}

        <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6">
          {children}
        </main>
      </div>
    </div>
  );
}

function Brand({ organizationName }: { organizationName: string }) {
  return (
    <div className="flex items-center gap-2 px-4 py-4">
      <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-600 text-[13px] font-bold text-white">
        C
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold text-ink">ShipCheck</span>
        <span className="block truncate text-xs text-ink-subtle">{organizationName}</span>
      </span>
    </div>
  );
}

function OrganizationSwitcher({
  memberships,
  activeId,
  onSwitch,
}: {
  memberships: Array<{ organizationId: string; organizationName: string; role: string }>;
  activeId: string | null;
  onSwitch: (organizationId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const active = memberships.find((membership) => membership.organizationId === activeId);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (memberships.length === 0) return null;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        className="flex items-center gap-2 rounded-lg border border-line-strong bg-white px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-surface-sunken"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="max-w-[10rem] truncate">{active?.organizationName ?? 'Select organization'}</span>
        <svg className="h-3 w-3 text-ink-subtle" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path d="m5 8 5 5 5-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open ? (
        <ul role="listbox" className="card absolute left-0 top-full z-40 mt-1 w-64 p-1 shadow-[var(--shadow-pop)]">
          {memberships.map((membership) => (
            <li key={membership.organizationId}>
              <button
                type="button"
                role="option"
                aria-selected={membership.organizationId === activeId}
                className={classNames(
                  'flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-[13px]',
                  membership.organizationId === activeId
                    ? 'bg-brand-50 text-brand-700'
                    : 'text-ink hover:bg-surface-sunken',
                )}
                onClick={() => {
                  setOpen(false);
                  onSwitch(membership.organizationId);
                }}
              >
                <span className="truncate">{membership.organizationName}</span>
                <span className="ml-2 shrink-0 text-xs text-ink-subtle capitalize">{membership.role}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ProfileMenu({
  name,
  email,
  settingsHref,
  onSignOut,
}: {
  name: string;
  email: string;
  settingsHref: string;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] text-ink hover:bg-surface-sunken"
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-100 text-[11px] font-semibold text-brand-700">
          {(name || email || '?').slice(0, 1).toUpperCase()}
        </span>
        <span className="hidden max-w-[10rem] truncate sm:block">{name || email}</span>
      </button>
      {open ? (
        <div role="menu" className="card absolute right-0 top-full z-40 mt-1 w-56 p-1 shadow-[var(--shadow-pop)]">
          <div className="px-3 py-2">
            <p className="truncate text-[13px] font-medium text-ink">{name}</p>
            <p className="truncate text-xs text-ink-subtle">{email}</p>
          </div>
          <div className="my-1 h-px bg-line" />
          <Link role="menuitem" to={settingsHref} className="block rounded-md px-3 py-2 text-[13px] text-ink no-underline hover:bg-surface-sunken">
            Profile settings
          </Link>
          <button
            role="menuitem"
            type="button"
            onClick={onSignOut}
            className="block w-full rounded-md px-3 py-2 text-left text-[13px] text-ink hover:bg-surface-sunken"
          >
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}