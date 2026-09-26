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
