import Link from 'next/link';
import { approvePost, revokeApproval } from '@/app/actions';
import { Shell } from '@/components/shell';
import { Badge, Button, Card, QueryNotices, Table } from '@/components/ui';
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
interface PendingApproval {
  postId: string;
  title: string;
  externalUrl: string | null;
  requestedPlatforms: string[];
  requestedPublishLocal: string | null;
  changedSinceApproval: boolean;
  lastApprovedAt: string | null;
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
  const { me, membership, workspace } = await loadWorkspace(workspaceId, `/w/${workspaceId}/posts`);
  const [{ posts }, approvals] = await Promise.all([
    api<{ posts: Post[] }>(
      `/v1/workspaces/${workspaceId}/posts${q.state ? `?state=${encodeURIComponent(q.state)}` : ''}`,
    ),
    workspace.approval?.required
      ? api<{ pending: PendingApproval[] }>(`/v1/workspaces/${workspaceId}/approvals`)
      : Promise.resolve({ pending: [] as PendingApproval[] }),
  ]);
  const isReviewer =
    membership.role === 'owner' || (workspace.approval?.reviewers ?? []).includes(me.user.id);
  const isAdmin = membership.role === 'owner' || membership.role === 'admin';
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
      {workspace.approval?.required && (
        <Card title="Awaiting approval">
          {approvals.pending.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">Nothing waiting for a reviewer.</p>
          ) : (
            <Table head={['Post', 'Platforms', 'Publish date', 'State', '']}>
              {approvals.pending.map((p) => (
                <tr key={p.postId}>
                  <td className="py-2 pr-4">
                    {p.externalUrl ? (
                      <a
                        href={p.externalUrl}
                        rel="noopener"
                        className="font-medium hover:underline"
                      >
                        {p.title}
                      </a>
                    ) : (
                      p.title
                    )}
                  </td>
                  <td className="py-2 pr-4">{p.requestedPlatforms.join(', ')}</td>
                  <td className="py-2 pr-4">{p.requestedPublishLocal ?? '—'}</td>
                  <td className="py-2 pr-4">
                    <Badge tone={p.changedSinceApproval ? 'warning' : 'neutral'}>
                      {p.changedSinceApproval ? 'changed since approval' : 'awaiting approval'}
                    </Badge>
                  </td>
                  <td className="py-2 text-right">
                    <div className="flex justify-end gap-2">
                      {isReviewer && (
                        <form action={approvePost.bind(null, workspaceId, p.postId)}>
                          <Button>Approve</Button>
                        </form>
                      )}
                      {isAdmin && p.lastApprovedAt && (
                        <form action={revokeApproval.bind(null, workspaceId, p.postId)}>
                          <Button variant="danger">Revoke</Button>
                        </form>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </Table>
          )}
          <p className="mt-2 text-xs text-[var(--muted)]">
            Reviewers approve the exact text they see in Notion; any later edit needs a new
            approval.
          </p>
        </Card>
      )}
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
