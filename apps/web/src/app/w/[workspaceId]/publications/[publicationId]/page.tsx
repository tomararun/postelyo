import { notFound } from 'next/navigation';
import { resolvePublication, retryPublication } from '@/app/actions';
import { Shell } from '@/components/shell';
import { Badge, Button, Card, Input, Notice, QueryNotices, Table } from '@/components/ui';
import { ApiError, api, fmt } from '@/lib/api';
import { loadWorkspace } from '@/lib/workspace';

interface Detail {
  id: string;
  state: string;
  provider: string;
  scheduledLocal: string;
  scheduledTz: string;
  scheduledAt: string;
  publishedAt: string | null;
  delaySeconds: number | null;
  providerPostId: string | null;
  providerPostUrl: string | null;
  cycleNo: number;
  attemptNo: number;
  maxAttempts: number;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  writebackState: string;
  firstCommentState: string | null;
  firstCommentId: string | null;
  firstCommentError: string | null;
  links: { shown: string; target: string; clicks: number }[];
  metrics: {
    tier: string;
    fetchedAt: string;
    impressions: number | null;
    reach: number | null;
    reactions: number | null;
    comments: number | null;
    shares: number | null;
    clicks: number | null;
    saves: number | null;
  }[];
  metricsNextAt: string | null;
  metricsError: string | null;
  attempts: {
    cycleNo: number;
    attemptNo: number;
    startedAt: string;
    finishedAt: string | null;
    outcome: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    workerId: string;
  }[];
}

export default async function PublicationPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; publicationId: string }>;
  searchParams: Promise<{ notice?: string; error?: string }>;
}) {
  const { workspaceId, publicationId } = await params;
  const q = await searchParams;
  const { me, membership } = await loadWorkspace(
    workspaceId,
    `/w/${workspaceId}/publications/${publicationId}`,
  );
  let pub: Detail;
  try {
    pub = await api<Detail>(`/v1/workspaces/${workspaceId}/publications/${publicationId}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }
  const isAdmin = membership.role === 'owner' || membership.role === 'admin';
  const canRetry = membership.role !== 'viewer' && pub.state === 'failed';
  return (
    <Shell
      email={me.user.email}
      workspace={{ id: workspaceId, name: membership.name, role: membership.role }}
    >
      <QueryNotices notice={q.notice} error={q.error} />
      <Card title={`Publication · ${pub.provider}`}>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-[var(--muted)]">State</dt>
            <dd>
              <Badge
                tone={
                  pub.state === 'published'
                    ? 'success'
                    : pub.state === 'failed' || pub.state === 'ambiguous'
                      ? 'danger'
                      : 'neutral'
                }
              >
                {pub.state}
              </Badge>
            </dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">Scheduled</dt>
            <dd>
              {pub.scheduledLocal} {pub.scheduledTz} ({fmt(pub.scheduledAt)})
            </dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">Published</dt>
            <dd>
              {fmt(pub.publishedAt)}
              {pub.delaySeconds !== null && ` · delay ${pub.delaySeconds}s`}
            </dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">Provider post</dt>
            <dd>
              {pub.providerPostUrl ? (
                <a href={pub.providerPostUrl} rel="noopener" className="underline">
                  {pub.providerPostUrl}
                </a>
              ) : (
                (pub.providerPostId ?? '—')
              )}
            </dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">Cycle / attempts</dt>
            <dd>
              {pub.cycleNo} / {pub.attemptNo} of {pub.maxAttempts}
            </dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">Notion writeback</dt>
            <dd>{pub.writebackState}</dd>
          </div>
          {pub.firstCommentState && (
            <div>
              <dt className="text-[var(--muted)]">First comment</dt>
              <dd>
                <Badge
                  tone={
                    pub.firstCommentState === 'posted'
                      ? 'success'
                      : pub.firstCommentState === 'failed'
                        ? 'danger'
                        : 'warning'
                  }
                >
                  {pub.firstCommentState}
                </Badge>{' '}
                {pub.firstCommentError && (
                  <span className="text-[var(--danger)]">{pub.firstCommentError}</span>
                )}
              </dd>
            </div>
          )}
          {pub.links.length > 0 && (
            <div className="sm:col-span-2">
              <dt className="text-[var(--muted)]">Tracked links</dt>
              <dd>
                <ul className="space-y-1 text-xs">
                  {pub.links.map((l) => (
                    <li key={l.shown}>
                      <code>{l.shown}</code> → {l.target} <Badge>{l.clicks} clicks</Badge>
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
          )}
          {pub.lastErrorCode && (
            <div className="sm:col-span-2">
              <dt className="text-[var(--muted)]">Last error</dt>
              <dd>
                <code>{pub.lastErrorCode}</code> {pub.lastErrorMessage}
              </dd>
            </div>
          )}
        </dl>
        <div className="mt-4 flex gap-3">
          {canRetry && (
            <form action={retryPublication.bind(null, workspaceId, publicationId)}>
              <Button>Retry now (new cycle)</Button>
            </form>
          )}
        </div>
      </Card>
      {pub.state === 'ambiguous' && isAdmin && (
        <Card title="Resolve">
          <Notice kind="info">
            Check the platform first. If the post is there, mark it published and paste its URL; if
            not, mark it failed and retry.
          </Notice>
          <form
            action={resolvePublication.bind(null, workspaceId, publicationId)}
            className="mt-3 space-y-3"
          >
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="outcome" value="published" required /> Published on the
              platform
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="outcome" value="failed" /> Not published
            </label>
            <Input name="providerPostUrl" label="Post URL (if published)" type="url" />
            <Button>Resolve</Button>
          </form>
        </Card>
      )}
      {(pub.metrics.length > 0 || pub.metricsNextAt || pub.metricsError) && (
        <Card title="Performance">
          {pub.metrics.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">
              {pub.metricsError
                ? `Metrics unavailable: ${pub.metricsError}`
                : `First numbers arrive about an hour after publishing (next check ${fmt(pub.metricsNextAt)}).`}
            </p>
          ) : (
            <Table
              head={[
                'After',
                'Impressions',
                'Reach',
                'Reactions',
                'Comments',
                'Shares',
                'Clicks',
                'Saves',
                'Fetched',
              ]}
            >
              {pub.metrics.map((m) => (
                <tr key={m.tier}>
                  <td className="py-1 pr-3">{m.tier}</td>
                  <td className="py-1 pr-3">{m.impressions ?? '—'}</td>
                  <td className="py-1 pr-3">{m.reach ?? '—'}</td>
                  <td className="py-1 pr-3">{m.reactions ?? '—'}</td>
                  <td className="py-1 pr-3">{m.comments ?? '—'}</td>
                  <td className="py-1 pr-3">{m.shares ?? '—'}</td>
                  <td className="py-1 pr-3">{m.clicks ?? '—'}</td>
                  <td className="py-1 pr-3">{m.saves ?? '—'}</td>
                  <td className="py-1 text-xs text-[var(--muted)]">{fmt(m.fetchedAt)}</td>
                </tr>
              ))}
            </Table>
          )}
          {pub.metrics.length > 0 && pub.metricsNextAt && (
            <p className="mt-2 text-xs text-[var(--muted)]">Next check {fmt(pub.metricsNextAt)}.</p>
          )}
          {pub.metrics.length > 0 && pub.metricsError && (
            <p className="mt-2 text-xs text-[var(--danger)]">{pub.metricsError}</p>
          )}
        </Card>
      )}
      <Card title="Attempts">
        {pub.attempts.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">No attempts yet.</p>
        ) : (
          <Table head={['Cycle', '#', 'Started', 'Finished', 'Outcome', 'Error', 'Worker']}>
            {pub.attempts.map((a, i) => (
              <tr key={i}>
                <td className="py-2 pr-4">{a.cycleNo}</td>
                <td className="py-2 pr-4">{a.attemptNo}</td>
                <td className="py-2 pr-4">{fmt(a.startedAt)}</td>
                <td className="py-2 pr-4">{fmt(a.finishedAt)}</td>
                <td className="py-2 pr-4">{a.outcome ?? 'in flight'}</td>
                <td className="py-2 pr-4">
                  {a.errorCode ? `${a.errorCode} ${a.errorMessage ?? ''}` : ''}
                </td>
                <td className="py-2 text-xs">{a.workerId}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </Shell>
  );
}
