import Link from 'next/link';
import type { ReactNode } from 'react';
import { signOut } from '@/app/actions';
import { Icon, Logo } from '@/components/icons';
import { MobileNav, PageTitle, SideNav, type NavGroup } from '@/components/nav';

function navFor(id: string): NavGroup[] {
  const w = `/w/${id}`;
  return [
    {
      label: 'Content',
      items: [
        { label: 'Posts', href: `${w}/posts`, icon: 'posts' },
        { label: 'Analytics', href: `${w}/analytics`, icon: 'analytics' },
        { label: 'AI', href: `${w}/ai`, icon: 'ai' },
      ],
    },
    {
      label: 'Workspace',
      items: [
        { label: 'Connections', href: `${w}/connections`, icon: 'connections' },
        { label: 'Team', href: `${w}/team`, icon: 'team' },
        { label: 'Billing', href: `${w}/billing`, icon: 'billing' },
        { label: 'Settings', href: `${w}/settings`, icon: 'settings' },
      ],
    },
    {
      label: 'Platform',
      items: [
        { label: 'Developers', href: `${w}/developers`, icon: 'developers' },
        { label: 'Security', href: `${w}/security`, icon: 'security' },
      ],
    },
  ];
}

const HOME: NavGroup[] = [
  { label: 'Account', items: [{ label: 'Workspaces', href: '/workspaces', icon: 'home' }] },
];

function Avatar({ email }: { email: string }) {
  return (
    <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-slate-700 to-slate-900 text-xs font-semibold text-white uppercase">
      {email.slice(0, 1)}
    </span>
  );
}

/** App frame: sidebar on desktop, compact header with scrollable tabs on mobile. */
export function Shell({
  email,
  workspace,
  children,
}: {
  email: string;
  workspace?: { id: string; name: string; role: string } | undefined;
  children: ReactNode;
}) {
  const groups = workspace ? navFor(workspace.id) : HOME;
  return (
    <div className="min-h-screen lg:flex">
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-[var(--border)] bg-white lg:flex">
        <div className="flex h-16 items-center gap-2.5 px-5">
          <Logo />
          <Link
            href="/workspaces"
            className="text-[17px] font-semibold tracking-tight text-slate-900"
          >
            Postelyo
          </Link>
        </div>
        {workspace && (
          <div className="px-3 pb-2">
            <Link
              href="/workspaces"
              className="flex items-center justify-between gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 transition-colors hover:border-[var(--border-strong)]"
              title="Switch workspace"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold text-slate-900">
                  {workspace.name}
                </span>
                <span className="block text-xs text-[var(--muted)] capitalize">
                  {workspace.role}
                </span>
              </span>
              <svg
                viewBox="0 0 20 20"
                className="h-4 w-4 shrink-0 text-slate-400"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.6}
                aria-hidden="true"
              >
                <path d="M7 8l3-3 3 3M7 12l3 3 3-3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </Link>
          </div>
        )}
        <div className="flex-1 overflow-y-auto px-3 py-4">
          <SideNav groups={groups} />
        </div>
        <div className="border-t border-[var(--border)] p-3">
          <div className="flex items-center gap-2.5 rounded-xl px-2 py-1.5">
            <Avatar email={email} />
            <span className="min-w-0 flex-1 truncate text-sm text-slate-700" title={email}>
              {email}
            </span>
            <form action={signOut}>
              <button
                type="submit"
                title="Sign out"
                aria-label="Sign out"
                className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
              >
                <Icon name="logout" />
              </button>
            </form>
          </div>
          <div className="mt-2 flex gap-3 px-2 text-xs text-[var(--subtle)]">
            <Link href="/privacy" className="hover:text-slate-600">
              Privacy
            </Link>
            <Link href="/terms" className="hover:text-slate-600">
              Terms
            </Link>
          </div>
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-10 border-b border-[var(--border)] bg-white/85 backdrop-blur lg:hidden">
          <div className="flex h-14 items-center justify-between gap-3 px-4">
            <Link href="/workspaces" className="flex items-center gap-2">
              <Logo size={28} />
              <span className="font-semibold tracking-tight">Postelyo</span>
            </Link>
            <form action={signOut} className="flex items-center gap-2">
              <span className="max-w-[40vw] truncate text-xs text-[var(--muted)]">{email}</span>
              <button
                type="submit"
                aria-label="Sign out"
                className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"
              >
                <Icon name="logout" />
              </button>
            </form>
          </div>
          <div className="px-4 pb-2">
            <MobileNav groups={groups} />
          </div>
        </header>

        <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-10 lg:py-10">
          <div className="mb-6 lg:mb-8">
            {workspace && (
              <p className="mb-1 text-sm font-medium text-[var(--primary)]">{workspace.name}</p>
            )}
            <PageTitle groups={groups} fallback="Postelyo" />
          </div>
          <main className="space-y-6">{children}</main>
        </div>
      </div>
    </div>
  );
}
