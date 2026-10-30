import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createWorkspace } from '@/app/actions';
import { Icon } from '@/components/icons';
import { Shell } from '@/components/shell';
import { Badge, Button, Card, Input, QueryNotices } from '@/components/ui';
import { api, getMe } from '@/lib/api';

const TINTS = [
  'from-indigo-500 to-violet-500',
  'from-sky-500 to-indigo-500',
  'from-emerald-500 to-teal-500',
  'from-amber-500 to-orange-500',
  'from-rose-500 to-pink-500',
];

function tint(id: string) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return TINTS[h % TINTS.length];
}

export const metadata = { title: 'Workspaces' };

export default async function WorkspacesPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string; error?: string }>;
}) {
  const me = await getMe();
  if (!me) redirect('/sign-in?next=%2Fworkspaces');
  const q = await searchParams;
  // First-run nudge: the workspace you own has no Notion database connected yet.
  const owned = me.workspaces.find((w) => w.role === 'owner');
  const needsSetup = owned
    ? await api<{ sources: { status: string; disconnectedAt: string | null }[] }>(
        `/v1/workspaces/${owned.id}/content-sources`,
      )
        .then((r) => !r.sources.some((s) => s.status === 'active' && !s.disconnectedAt))
        .catch(() => false)
    : false;
  return (
    <Shell email={me.user.email}>
      <QueryNotices notice={q.notice} error={q.error} />
      {needsSetup && (
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-indigo-200 bg-gradient-to-r from-indigo-50 to-violet-50 p-5">
          <div>
            <p className="font-semibold text-slate-900">Finish setting up {owned!.name}</p>
            <p className="mt-0.5 text-sm text-slate-600">
              Connect your Notion database and a social account to start publishing.
            </p>
          </div>
          <Button href="/welcome">Continue setup</Button>
        </div>
      )}
      <section>
        <p className="mb-4 text-sm text-[var(--muted)]">
          Pick a workspace to open its posts, connections and results.
        </p>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {me.workspaces.map((w) => (
            <Link
              key={w.id}
              href={`/w/${w.id}/posts`}
              className="group relative flex flex-col rounded-2xl border border-[var(--border)] bg-white p-5 shadow-[var(--shadow-card)] transition-all hover:-translate-y-0.5 hover:border-indigo-200 hover:shadow-[var(--shadow-raised)]"
            >
              <div className="flex items-start justify-between gap-3">
                <span
                  className={`flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br text-lg font-semibold text-white uppercase ${tint(w.id)}`}
                >
                  {w.name.slice(0, 1)}
                </span>
                <Badge tone={w.role === 'owner' ? 'success' : 'neutral'}>{w.role}</Badge>
              </div>
              <span className="mt-4 block truncate font-semibold text-slate-900">{w.name}</span>
              <span className="block truncate text-xs text-[var(--muted)]">{w.slug}</span>
              <span className="mt-5 inline-flex items-center gap-1 text-sm font-medium text-[var(--primary)]">
                Open workspace
                <Icon
                  name="arrow"
                  className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
                />
              </span>
            </Link>
          ))}
        </div>
      </section>
      <Card
        title="Create a workspace"
        description="Separate brands or clients each get their own workspace, accounts and team."
      >
        <form action={createWorkspace} className="grid gap-4 sm:grid-cols-[1fr_1fr_auto]">
          <Input name="name" label="Name" required placeholder="Acme Marketing" />
          <Input name="defaultTimezone" label="Default time zone (IANA)" defaultValue="UTC" />
          <div className="flex items-end">
            <Button>Create workspace</Button>
          </div>
        </form>
      </Card>
    </Shell>
  );
}
