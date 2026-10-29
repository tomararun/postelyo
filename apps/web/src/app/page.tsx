import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createWorkspace } from '@/app/actions';
import { Icon } from '@/components/icons';
import { Shell } from '@/components/shell';
import { Badge, Button, Card, Input, QueryNotices } from '@/components/ui';
import { getMe } from '@/lib/api';

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

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string; error?: string }>;
}) {
  const me = await getMe();
  if (!me) redirect('/sign-in');
  const q = await searchParams;
  return (
    <Shell email={me.user.email}>
      <QueryNotices notice={q.notice} error={q.error} />
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
