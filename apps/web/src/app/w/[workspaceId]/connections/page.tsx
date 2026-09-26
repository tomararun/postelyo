import { connectNotionToken, disconnectAccount, disconnectSource, syncSource } from '@/app/actions';
import { Shell } from '@/components/shell';
import { Badge, Button, Card, Input, Notice, QueryNotices, Table } from '@/components/ui';
import { api, fmt } from '@/lib/api';
import { loadWorkspace } from '@/lib/workspace';

interface Account {
  id: string;
  provider: string;
  accountType: string;
  displayName: string;
  status: string;
  tokenExpiresAt: string | null;
  disconnectedAt: string | null;
}
interface Source {
  id: string;
  status: string;
  databaseTitle: string | null;
  databaseId: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  disconnectedAt: string | null;
  warnings: { message: string }[];
  authKind: 'oauth' | 'token';
  setupPending: boolean;
  notionWorkspaceName: string | null;
}

export default async function ConnectionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ notice?: string; error?: string; connected?: string }>;
}) {
  const { workspaceId } = await params;
  const q = await searchParams;
  const { me, membership, canManage } = await loadWorkspace(
    workspaceId,
    `/w/${workspaceId}/connections`,
  );
  const [social, sources] = await Promise.all([
    api<{
      accounts: Account[];
      configured: Record<string, boolean>;
      notionOAuthConfigured: boolean;
    }>(`/v1/workspaces/${workspaceId}/social-accounts`),
    api<{ sources: Source[] }>(`/v1/workspaces/${workspaceId}/content-sources`),
  ]);
  const active = social.accounts.filter((a) => !a.disconnectedAt);
  const groups: {
    title: string;
    filter: (a: Account) => boolean;
    connect: string | null;
    label: string;
    enabled: boolean;
  }[] = [
    {
      title: 'LinkedIn profile',
      filter: (a) => a.provider === 'linkedin' && a.accountType === 'member',
      connect: `/v1/workspaces/${workspaceId}/social-accounts/linkedin/connect`,
      label: 'Connect LinkedIn profile',
      enabled: social.configured['linkedin'] === true,
    },
    {
      title: 'LinkedIn Pages',
      filter: (a) => a.provider === 'linkedin' && a.accountType === 'organization',
      connect: `/v1/workspaces/${workspaceId}/social-accounts/linkedin/connect?type=organization`,
      label: 'Connect LinkedIn Pages you administer',
      enabled: social.configured['linkedin'] === true,
    },
    {
      title: 'X',
      filter: (a) => a.provider === 'x',
      connect: `/v1/workspaces/${workspaceId}/social-accounts/x/connect`,
      label: 'Connect X profile',
      enabled: social.configured['x'] === true,
    },
    {
      title: 'Facebook Pages and Instagram',
      filter: (a) => a.provider === 'facebook' || a.provider === 'instagram',
      connect: `/v1/workspaces/${workspaceId}/social-accounts/meta/connect`,
      label: 'Connect Facebook Pages you manage',
      enabled: social.configured['facebook'] === true || social.configured['instagram'] === true,
    },
  ];
  const connectedMsg: Record<string, string> = {
    linkedin: 'LinkedIn profile connected.',
    'linkedin-pages':
      'LinkedIn Pages connected. Disconnect any you do not want Postelyo to post to.',
    x: 'X profile connected.',
    meta: 'Facebook Pages and linked Instagram accounts connected.',
    notion: 'Notion connected.',
  };
  const activeSources = sources.sources.filter((s) => !s.disconnectedAt);
  const pending = activeSources.find((s) => s.setupPending);

  return (
    <Shell
      email={me.user.email}
      workspace={{ id: workspaceId, name: membership.name, role: membership.role }}
    >
      <QueryNotices
        notice={q.notice ?? (q.connected ? connectedMsg[q.connected] : undefined)}
        error={q.error}
      />

      <Card title="Notion">
        {pending && (
          <Notice kind="info">
            Notion is connected but not set up yet.{' '}
            <a className="underline" href={`/w/${workspaceId}/setup?source=${pending.id}`}>
              Finish setup
            </a>
          </Notice>
        )}
        {activeSources.filter((s) => !s.setupPending).length === 0 ? (
          <p className="text-sm text-[var(--muted)]">No Notion database connected.</p>
        ) : (
          <Table head={['Database', 'Status', 'Last sync', '']}>
            {activeSources
              .filter((s) => !s.setupPending)
              .map((s) => (
                <tr key={s.id}>
                  <td className="py-2 pr-4">
                    {s.databaseTitle ?? s.databaseId}
                    <div className="text-xs text-[var(--muted)]">
                      {s.authKind === 'oauth'
                        ? `via Notion OAuth (${s.notionWorkspaceName ?? 'workspace'})`
                        : 'internal token'}
                    </div>
                  </td>
                  <td className="py-2 pr-4">
                    <Badge tone={s.status === 'active' ? 'success' : 'danger'}>{s.status}</Badge>
                    {s.lastError && (
                      <div className="text-xs text-[var(--danger)]">{s.lastError}</div>
                    )}
                    {s.warnings.length > 0 && (
                      <div className="text-xs text-[var(--muted)]">
                        {s.warnings.map((w) => w.message).join(' ')}
                      </div>
                    )}
                  </td>
                  <td className="py-2 pr-4">{fmt(s.lastSyncAt)}</td>
                  <td className="py-2 text-right">
                    {canManage && (
                      <div className="flex justify-end gap-2">
                        <form action={syncSource.bind(null, workspaceId, s.id)}>
                          <Button variant="secondary">Sync now</Button>
                        </form>
                        <form action={disconnectSource.bind(null, workspaceId, s.id)}>
                          <Button variant="danger">Disconnect</Button>
                        </form>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
          </Table>
        )}
        {canManage && (
          <div className="mt-4 grid gap-6 md:grid-cols-2">
            <div className="space-y-2">
              <h3 className="text-sm font-medium">Recommended</h3>
              {social.notionOAuthConfigured ? (
                <Button href={`/v1/workspaces/${workspaceId}/content-sources/notion/connect`}>
                  Connect with Notion
                </Button>
              ) : (
                <p className="text-xs text-[var(--muted)]">
                  Notion OAuth is not configured on this server; use a token.
                </p>
              )}
              <p className="text-xs text-[var(--muted)]">
                Pick the pages Postelyo may use; the template database is created for you.
              </p>
            </div>
            <form action={connectNotionToken.bind(null, workspaceId)} className="space-y-3">
              <h3 className="text-sm font-medium">Or paste an internal integration token</h3>
              <Input name="token" label="Token" type="password" required />
              <Input name="database" label="Content database URL or id" required />
              <Button variant="secondary">Connect database</Button>
            </form>
          </div>
        )}
      </Card>

      {groups.map((g) => {
        const rows = active.filter(g.filter);
        return (
          <Card key={g.title} title={g.title}>
            {!g.enabled ? (
              <p className="text-sm text-[var(--muted)]">
                Not enabled for this workspace or not configured on this server.
              </p>
            ) : (
              <>
                {rows.length === 0 ? (
                  <p className="text-sm text-[var(--muted)]">Nothing connected.</p>
                ) : (
                  <Table head={['Account', 'Status', 'Token expires', '']}>
                    {rows.map((a) => (
                      <tr key={a.id}>
                        <td className="py-2 pr-4">
                          {a.displayName}
                          <div className="text-xs text-[var(--muted)]">
                            {a.provider} · {a.accountType}
                          </div>
                        </td>
                        <td className="py-2 pr-4">
                          <Badge tone={a.status === 'active' ? 'success' : 'warning'}>
                            {a.status}
                          </Badge>
                        </td>
                        <td className="py-2 pr-4">
                          {a.tokenExpiresAt ? a.tokenExpiresAt.slice(0, 10) : 'does not expire'}
                        </td>
                        <td className="py-2 text-right">
                          {canManage && (
                            <form action={disconnectAccount.bind(null, workspaceId, a.id)}>
                              <Button variant="danger">Disconnect</Button>
                            </form>
                          )}
                        </td>
                      </tr>
                    ))}
                  </Table>
                )}
                {canManage && g.connect && (
                  <div className="mt-3">
                    <Button variant="secondary" href={g.connect}>
                      {rows.length === 0 ? g.label : 'Reconnect (refresh authorization)'}
                    </Button>
                  </div>
                )}
              </>
            )}
          </Card>
        );
      })}
    </Shell>
  );
}
