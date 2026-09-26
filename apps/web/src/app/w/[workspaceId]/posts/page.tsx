import Link from 'next/link';
import { Shell } from '@/components/shell';
import { Badge, Card, QueryNotices, Table } from '@/components/ui';
import { api, fmt } from '@/lib/api';
import { loadWorkspace } from '@/lib/workspace';

interface Publication {
  id: string;
  provider: string;
  accountName: string | null;
  state: string;
  scheduledLocal: string;
  scheduledTz: string;
  publishedAt: string | null;
  providerPostUrl: string | null;
  lastErrorMessage: string | null;
}
interface Post {
  id: string;
  title: string;
  state: string;
  sourceStatus: string | null;
  externalUrl: string | null;
  validationErrors: { message: string }[] | null;
  publications: Publication[];
}

const tone = (state: string) =>
  state === 'published'
    ? 'success'
    : ['failed', 'ambiguous', 'partially_failed'].includes(state)
      ? 'danger'
      : state === 'scheduled'
        ? 'warning'
        : 'neutral';

export default async function PostsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ state?: string; notice?: string; error?: string }>;
}) {
  const { workspaceId } = await params;
  const q = await searchParams;
  const { me, membership } = await loadWorkspace(workspaceId, `/w/${workspaceId}/posts`);
  const { posts } = await api<{ posts: Post[] }>(
    `/v1/workspaces/${workspaceId}/posts${q.state ? `?state=${encodeURIComponent(q.state)}` : ''}`,
  );
  const filters = [
    'all',
    'scheduled',
    'publishing',
    'published',
    'partially_failed',
    'failed',
    'cancelled',
  ];
  return (
    <Shell
      email={me.user.email}
      workspace={{ id: workspaceId, name: membership.name, role: membership.role }}
    >
      <QueryNotices notice={q.notice} error={q.error} />
      <Card
        title="Posts"
        actions={
          <nav className="flex gap-3 text-xs">
            {filters.map((f) => (
              <Link
                key={f}
                href={`/w/${workspaceId}/posts${f === 'all' ? '' : `?state=${f}`}`}
                className={
                  (q.state ?? 'all') === f ? 'font-semibold underline' : 'text-[var(--muted)]'
                }
              >
                {f}
              </Link>
            ))}
          </nav>
        }
      >
        {posts.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">
            No posts yet. Connect Notion and set a page to Scheduled.
          </p>
        ) : (
          <Table head={['Post', 'Notion status', 'State', 'Targets']}>
            {posts.map((p) => (
              <tr key={p.id}>
                <td className="py-2 pr-4 align-top">
                  {p.externalUrl ? (
                    <a href={p.externalUrl} rel="noopener" className="font-medium hover:underline">
                      {p.title}
                    </a>
                  ) : (
                    p.title
                  )}
                  {p.validationErrors && p.validationErrors.length > 0 && (
                    <div className="text-xs text-[var(--danger)]">
                      {p.validationErrors.map((e) => e.message).join(' ')}
                    </div>
                  )}
                </td>
                <td className="py-2 pr-4 align-top">{p.sourceStatus ?? '—'}</td>
                <td className="py-2 pr-4 align-top">
                  <Badge tone={tone(p.state)}>{p.state}</Badge>
                </td>
                <td className="py-2 align-top">
                  <ul className="space-y-1">
                    {p.publications.map((pub) => (
                      <li key={pub.id} className="text-xs">
                        <Link
                          href={`/w/${workspaceId}/publications/${pub.id}`}
                          className="hover:underline"
                        >
                          {pub.provider}
                          {pub.accountName ? ` (${pub.accountName})` : ''}
                        </Link>{' '}
                        <Badge tone={tone(pub.state)}>{pub.state}</Badge> {pub.scheduledLocal}{' '}
                        {pub.scheduledTz}
                        {pub.providerPostUrl && (
                          <>
                            {' '}
                            <a href={pub.providerPostUrl} rel="noopener" className="underline">
                              view
                            </a>
                          </>
                        )}
                        {pub.publishedAt && (
                          <span className="text-[var(--muted)]"> · {fmt(pub.publishedAt)}</span>
                        )}
                        {pub.lastErrorMessage && (
                          <div className="text-[var(--danger)]">{pub.lastErrorMessage}</div>
                        )}
                      </li>
                    ))}
                    {p.publications.length === 0 && (
                      <li className="text-xs text-[var(--muted)]">—</li>
                    )}
                  </ul>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </Shell>
  );
}
