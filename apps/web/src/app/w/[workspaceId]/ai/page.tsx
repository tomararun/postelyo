import { updateAiSettings } from '@/app/actions';
import { Shell } from '@/components/shell';
import { Badge, Button, Card, Input, Notice, QueryNotices, Table } from '@/components/ui';
import { api, fmt } from '@/lib/api';
import { loadWorkspace } from '@/lib/workspace';

interface AiPage {
  usage: {
    enabled: boolean;
    entitled: boolean;
    model: string;
    provider: string;
    budgetTokens: number;
    usedTokens: number;
    costUsd: number;
    generations: number;
    monthStart: string;
  };
  recent: {
    id: string;
    purpose: string;
    model: string;
    entityType: string | null;
    entityId: string | null;
    totalTokens: number;
    costUsd: number;
    outcome: string;
    error: string | null;
    durationMs: number;
    createdAt: string;
    outputPreview: string;
  }[];
}

const PURPOSE_LABEL: Record<string, string> = {
  variants: 'Platform variants',
  draft_from_idea: 'Draft from idea',
  repurpose: 'Repurpose',
  alt_text: 'Alt text',
  suggestions: 'Suggestions',
};

export default async function AiPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ notice?: string; error?: string }>;
}) {
  const { workspaceId } = await params;
  const q = await searchParams;
  const { me, membership, workspace, canManage } = await loadWorkspace(
    workspaceId,
    `/w/${workspaceId}/ai`,
  );
  const data = await api<AiPage>(`/v1/workspaces/${workspaceId}/ai`);
  const u = data.usage;
  const pct =
    u.budgetTokens > 0 ? Math.min(100, Math.round((u.usedTokens / u.budgetTokens) * 100)) : 0;
  const ai = workspace.ai ?? { enabled: false };

  return (
    <Shell
      email={me.user.email}
      workspace={{ id: workspaceId, name: membership.name, role: membership.role }}
    >
      <QueryNotices notice={q.notice} error={q.error} />
      <Card title="AI assistance">
        {u.provider === 'none' && (
          <Notice kind="info">AI assistance is not configured on this server.</Notice>
        )}
        {u.provider !== 'none' && !u.entitled && (
          <Notice kind="info">
            The current plan does not include AI assistance. Upgrade on the Billing page.
          </Notice>
        )}
        <dl className="grid gap-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-[var(--muted)]">Status</dt>
            <dd>
              <Badge tone={u.enabled && u.entitled ? 'success' : 'neutral'}>
                {u.enabled && u.entitled ? 'on' : 'off'}
              </Badge>
            </dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">Model</dt>
            <dd>
              {u.model} <span className="text-xs text-[var(--muted)]">({u.provider})</span>
            </dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">Tokens this month</dt>
            <dd>
              {u.usedTokens.toLocaleString('en-US')} / {u.budgetTokens.toLocaleString('en-US')} (
              {pct}%)
            </dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">Cost this month</dt>
            <dd>
              ${u.costUsd.toFixed(2)} over {u.generations} generations
            </dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-[var(--muted)]">
          In Notion: tick <strong>Generate variants</strong> to fill empty platform texts, pick a{' '}
          <strong>Repurpose</strong> option to create linked drafts, or set an idea to{' '}
          <strong>Draft with AI</strong>. Nothing is ever scheduled by the AI; you decide when a
          post goes out, and the approval policy applies as usual.
        </p>
      </Card>

      {canManage && (
        <Card title="Settings and guardrails">
          <form action={updateAiSettings.bind(null, workspaceId)} className="space-y-3">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="enabled" defaultChecked={ai.enabled} />
              Enable AI assistance for this workspace
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium">
                Brand voice (injected into every prompt)
              </span>
              <textarea
                name="voice"
                rows={5}
                defaultValue={ai.voice ?? ''}
                placeholder="Who we are, how we sound, what we never say."
                className="w-full rounded-md border border-[var(--border)] bg-white px-3 py-1.5 text-sm"
              />
            </label>
            <Input
              name="bannedPhrases"
              label="Banned phrases (comma separated; output containing one is discarded)"
              defaultValue={(ai.bannedPhrases ?? []).join(', ')}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                name="monthlyTokenBudget"
                label="Monthly token cap (blank = plan limit)"
                type="number"
                defaultValue={ai.monthlyTokenBudget ?? ''}
              />
              <Input
                name="model"
                label="Model override (blank = server default)"
                defaultValue={ai.model ?? ''}
              />
            </div>
            <Button>Save</Button>
          </form>
        </Card>
      )}

      <Card title="Recent generations">
        {data.recent.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">Nothing generated yet.</p>
        ) : (
          <Table head={['When', 'Purpose', 'Outcome', 'Tokens', 'Cost', 'Output']}>
            {data.recent.map((g) => (
              <tr key={g.id}>
                <td className="py-2 pr-3 text-xs">{fmt(g.createdAt)}</td>
                <td className="py-2 pr-3">{PURPOSE_LABEL[g.purpose] ?? g.purpose}</td>
                <td className="py-2 pr-3">
                  <Badge
                    tone={
                      g.outcome === 'ok'
                        ? 'success'
                        : g.outcome === 'guardrail'
                          ? 'warning'
                          : 'danger'
                    }
                  >
                    {g.outcome}
                  </Badge>
                  {g.error && <div className="text-xs text-[var(--danger)]">{g.error}</div>}
                </td>
                <td className="py-2 pr-3">{g.totalTokens.toLocaleString('en-US')}</td>
                <td className="py-2 pr-3">${g.costUsd.toFixed(4)}</td>
                <td className="py-2 text-xs text-[var(--muted)]">{g.outputPreview}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </Shell>
  );
}
