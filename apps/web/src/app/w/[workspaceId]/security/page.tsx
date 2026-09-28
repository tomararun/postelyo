import { redirect } from 'next/navigation';
import { saveSso, tenantKeyAction } from '@/app/actions';
import { Shell } from '@/components/shell';
import { Badge, Button, Card, Input, Notice, QueryNotices, Select } from '@/components/ui';
import { api, fmt } from '@/lib/api';
import { loadWorkspace } from '@/lib/workspace';

interface Security {
  entitled: {
    planName: string;
    sso: boolean;
    tenantKeys: boolean;
    auditExport: boolean;
  };
  region: string;
  sso: {
    issuer: string;
    clientId: string;
    emailDomain: string;
    defaultRole: string;
    enabled: boolean;
    updatedAt: string;
  } | null;
  ssoRedirectUri: string;
  tenantKeys: {
    enabled: boolean;
    version: number | null;
    createdAt: string | null;
    rotatedAt: string | null;
    credentials: { total: number; onCurrentKey: number };
  };
}

const REGION_LABEL: Record<string, string> = { us: 'United States', eu: 'European Union' };

export default async function SecurityPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ notice?: string; error?: string }>;
}) {
  const { workspaceId } = await params;
  const q = await searchParams;
  const { me, membership, canManage } = await loadWorkspace(
    workspaceId,
    `/w/${workspaceId}/security`,
  );
  if (!canManage)
    redirect(
      `/w/${workspaceId}/settings?error=${encodeURIComponent('Only admins can open Security.')}`,
    );
  const data = await api<Security>(`/v1/workspaces/${workspaceId}/security`);
  const isOwner = membership.role === 'owner';
  const monthAgo = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
  const now = new Date().toISOString();

  return (
    <Shell
      email={me.user.email}
      workspace={{ id: workspaceId, name: membership.name, role: membership.role }}
    >
      <QueryNotices notice={q.notice} error={q.error} />
      <Card title="Data residency">
        <p className="text-sm">
          This workspace is hosted in the{' '}
          <strong>{REGION_LABEL[data.region] ?? data.region.toUpperCase()}</strong> region. Data
          (content snapshots, credentials, results) stays in this region; moving a workspace is an
          operator task described in the runbook.
        </p>
      </Card>

      <Card title="Per-workspace encryption keys">
        {!data.entitled.tenantKeys && (
          <Notice kind="info">
            Per-workspace keys are part of the Enterprise plan. All credentials are already
            encrypted at rest under the platform master key.
          </Notice>
        )}
        <dl className="grid gap-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-[var(--muted)]">Status</dt>
            <dd>
              {data.tenantKeys.enabled ? (
                <Badge tone="success">enabled · v{data.tenantKeys.version}</Badge>
              ) : (
                <Badge>platform key</Badge>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">Credentials</dt>
            <dd>
              {data.tenantKeys.enabled
                ? `${data.tenantKeys.credentials.onCurrentKey} / ${data.tenantKeys.credentials.total} on current key`
                : data.tenantKeys.credentials.total}
            </dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">Enabled</dt>
            <dd>{fmt(data.tenantKeys.createdAt)}</dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">Last rotation</dt>
            <dd>{fmt(data.tenantKeys.rotatedAt)}</dd>
          </div>
        </dl>
        {isOwner && data.entitled.tenantKeys && (
          <form action={tenantKeyAction.bind(null, workspaceId)} className="mt-4 flex gap-2">
            {data.tenantKeys.enabled ? (
              <Button variant="secondary" name="op" value="rotate">
                Rotate key
              </Button>
            ) : (
              <Button name="op" value="enable">
                Enable per-workspace key
              </Button>
            )}
          </form>
        )}
        <p className="mt-3 text-xs text-[var(--muted)]">
          Enabling mints a key for this workspace, wrapped by the platform master key, and re-seals
          every stored credential under it. Rotation re-seals everything under a new version; the
          old version is discarded. Both actions are audited.
        </p>
      </Card>

      <Card title="Single sign-on (OpenID Connect)">
        {!data.entitled.sso && (
          <Notice kind="info">Single sign-on is part of the Enterprise plan.</Notice>
        )}
        {data.sso && (
          <p className="mb-3 text-sm">
            Members with <strong>@{data.sso.emailDomain}</strong> addresses sign in through{' '}
            <span className="font-mono text-xs">{data.sso.issuer}</span>
            {data.sso.enabled ? <Badge tone="success">enabled</Badge> : <Badge>disabled</Badge>} ·
            first-time users join as <strong>{data.sso.defaultRole}</strong> · updated{' '}
            {fmt(data.sso.updatedAt)}
          </p>
        )}
        <p className="mb-3 text-xs text-[var(--muted)]">
          Register this redirect URI with your identity provider:{' '}
          <code className="font-mono">{data.ssoRedirectUri}</code>. Scopes: openid email profile.
        </p>
        {isOwner && data.entitled.sso && (
          <form action={saveSso.bind(null, workspaceId)} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                name="issuer"
                label="Issuer URL"
                placeholder="https://login.example.com"
                defaultValue={data.sso?.issuer ?? ''}
                required
              />
              <Input
                name="emailDomain"
                label="Email domain"
                placeholder="acme.com"
                defaultValue={data.sso?.emailDomain ?? ''}
                required
              />
              <Input
                name="clientId"
                label="Client id"
                defaultValue={data.sso?.clientId ?? ''}
                required
              />
              <Input
                name="clientSecret"
                label={data.sso ? 'Client secret (leave blank to keep)' : 'Client secret'}
                type="password"
              />
              <Select
                name="defaultRole"
                label="Role for first-time users"
                defaultValue={data.sso?.defaultRole ?? 'viewer'}
                options={[
                  { value: 'viewer', label: 'Viewer' },
                  { value: 'editor', label: 'Editor' },
                  { value: 'admin', label: 'Admin' },
                ]}
              />
              <label className="flex items-end gap-2 pb-2 text-sm">
                <input type="checkbox" name="enabled" defaultChecked={data.sso?.enabled ?? true} />{' '}
                Enabled
              </label>
            </div>
            <div className="flex gap-2">
              <Button name="op" value="save">
                Save
              </Button>
              {data.sso && (
                <Button variant="danger" name="op" value="remove">
                  Remove
                </Button>
              )}
            </div>
          </form>
        )}
      </Card>

      <Card title="Audit export">
        {!data.entitled.auditExport && (
          <Notice kind="info">Audit export needs the Team plan or higher.</Notice>
        )}
        <p className="text-sm">
          Download the audit trail as newline-delimited JSON. Each line carries the actor, entity,
          event, states and correlation id; secrets never appear. Exports are themselves audited.
        </p>
        {data.entitled.auditExport && (
          <p className="mt-3">
            <Button
              variant="secondary"
              href={`/v1/workspaces/${workspaceId}/audit/export?from=${encodeURIComponent(monthAgo)}&to=${encodeURIComponent(now)}`}
            >
              Download last 30 days
            </Button>
          </p>
        )}
        <p className="mt-2 text-xs text-[var(--muted)]">
          Other ranges:{' '}
          <code className="font-mono">
            /v1/workspaces/{workspaceId}/audit/export?from=…&amp;to=…
          </code>{' '}
          (up to 366 days) or the public API.
        </p>
      </Card>
    </Shell>
  );
}
