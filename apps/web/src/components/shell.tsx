import Link from 'next/link';
import type { ReactNode } from 'react';
import { signOut } from '@/app/actions';

export function Shell({
  email,
  workspace,
  children,
}: {
  email: string;
  workspace?: { id: string; name: string; role: string } | undefined;
  children: ReactNode;
}) {
  const nav = workspace
    ? [
        ['Posts', `/w/${workspace.id}/posts`],
        ['Analytics', `/w/${workspace.id}/analytics`],
        ['AI', `/w/${workspace.id}/ai`],
        ['Connections', `/w/${workspace.id}/connections`],
        ['Team', `/w/${workspace.id}/team`],
        ['Billing', `/w/${workspace.id}/billing`],
        ['Settings', `/w/${workspace.id}/settings`],
        ['Developers', `/w/${workspace.id}/developers`],
        ['Security', `/w/${workspace.id}/security`],
      ]
    : [];
  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4 border-b border-[var(--border)] pb-4">
        <div className="flex items-center gap-6">
          <Link href="/" className="text-lg font-semibold">
            Postelyo
          </Link>
          {workspace && (
            <span className="text-sm text-[var(--muted)]">
              {workspace.name} · {workspace.role}
            </span>
          )}
          <nav className="flex gap-4 text-sm">
            {nav.map(([label, href]) => (
              <Link key={href} href={href!} className="hover:underline">
                {label}
              </Link>
            ))}
          </nav>
        </div>
        <form action={signOut} className="flex items-center gap-3 text-sm text-[var(--muted)]">
          <span>{email}</span>
          <button type="submit" className="underline-offset-4 hover:underline">
            Sign out
          </button>
        </form>
      </header>
      <main className="space-y-6">{children}</main>
      <footer className="mt-10 flex gap-4 text-xs text-[var(--muted)]">
        <Link href="/privacy">Privacy</Link>
        <Link href="/terms">Terms</Link>
      </footer>
    </div>
  );
}
