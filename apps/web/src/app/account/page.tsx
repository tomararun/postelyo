import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { deleteAccount } from '@/app/actions';
import { Shell } from '@/components/shell';
import { Badge, Button, Card, Notice, QueryNotices } from '@/components/ui';
import { api, getMe } from '@/lib/api';

export const metadata: Metadata = { title: 'Your account', robots: { index: false } };

interface Preview {
  deleted: { id: string; name: string }[];
  left: { id: string; name: string; connectedAccounts: number }[];
  blocking: { id: string; name: string; members: number }[];
}

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string; error?: string }>;
}) {
  const me = await getMe();
  if (!me) redirect('/sign-in?next=%2Faccount');
  const q = await searchParams;
  const preview = await api<Preview>('/v1/me/deletion-preview');
  const blocked = preview.blocking.length > 0;

  return (
    <Shell email={me.user.email}>
      <QueryNotices notice={q.notice} error={q.error} />
      <Card title="Profile">
        <dl className="grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-[var(--muted)]">Email</dt>
            <dd className="truncate">{me.user.email}</dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">Name</dt>
            <dd>{me.user.name || '—'}</dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">Workspaces</dt>
            <dd>{me.workspaces.length}</dd>
          </div>
        </dl>
      </Card>

      <Card
        title="Download your data"
        description="A JSON file with your profile, memberships, sign-in sessions, invitations you sent and your activity."
      >
        <p className="text-sm text-[var(--muted)]">
          Workspace content (posts, results, connections) is in each workspace&apos;s own export,
          available to admins under Settings. Access tokens are never included in any export.
        </p>
        <Button variant="secondary" href="/v1/me/export">
          Download my data
        </Button>
      </Card>

      <Card title="Delete your account">
        <p className="text-sm text-slate-700">
          Deleting your account signs you out everywhere and removes your sign-in, profile and
          memberships. It cannot be undone.
        </p>
        {preview.deleted.length > 0 && (
          <div>
            <p className="text-sm font-medium text-slate-900">Deleted with your account</p>
            <p className="mb-2 text-xs text-[var(--muted)]">
              You are the only member, so their posts, connections and tokens are purged too.
            </p>
            <ul className="flex flex-wrap gap-2">
              {preview.deleted.map((w) => (
                <li key={w.id}>
                  <Badge tone="danger">{w.name}</Badge>
                </li>
              ))}
            </ul>
          </div>
        )}
        {preview.left.length > 0 && (
          <div>
            <p className="text-sm font-medium text-slate-900">You will leave</p>
            <p className="mb-2 text-xs text-[var(--muted)]">
              These workspaces stay with their team. Social accounts you connected there are
              disconnected, so nobody can keep posting with your profile.
            </p>
            <ul className="space-y-1 text-sm">
              {preview.left.map((w) => (
                <li key={w.id} className="flex items-center gap-2">
                  <Badge>{w.name}</Badge>
                  {w.connectedAccounts > 0 && (
                    <span className="text-xs text-[var(--muted)]">
                      {w.connectedAccounts} connected{' '}
                      {w.connectedAccounts === 1 ? 'account' : 'accounts'} will be disconnected
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {blocked ? (
          <Notice kind="error">
            You are the only owner of{' '}
            {preview.blocking.map((w, i) => (
              <span key={w.id}>
                {i > 0 && ', '}
                <Link href={`/w/${w.id}/team`} className="font-semibold underline">
                  {w.name}
                </Link>
              </span>
            ))}
            , which still {preview.blocking.length === 1 ? 'has' : 'have'} other members. Make
            another member owner on the Team page, or delete the workspace, then come back.
          </Notice>
        ) : (
          <form
            action={deleteAccount}
            className="space-y-3 rounded-xl border border-red-200 bg-red-50/50 p-4"
          >
            <label className="block text-sm">
              <span className="mb-1.5 block font-medium text-slate-700">
                Type <strong>{me.user.email}</strong> to confirm
              </span>
              <input
                name="confirmEmail"
                type="email"
                required
                autoComplete="off"
                placeholder={me.user.email}
                className="w-full rounded-lg border border-red-200 bg-white px-3 py-2 text-sm shadow-sm focus:border-red-400 focus:ring-4 focus:ring-red-100 focus:outline-none"
              />
            </label>
            <Button variant="danger">Delete my account permanently</Button>
          </form>
        )}
      </Card>
    </Shell>
  );
}
