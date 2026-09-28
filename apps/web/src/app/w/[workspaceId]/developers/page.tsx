import { createApiKey, createWebhook, revokeApiKey, webhookAction } from '@/app/actions';
import { SecretForm } from '@/components/secret-form';
import { Shell } from '@/components/shell';
import { Badge, Button, Card, Input, Notice, QueryNotices, Table } from '@/components/ui';
import { api, fmt } from '@/lib/api';
import { loadWorkspace } from '@/lib/workspace';

interface Developers {
  entitled: { planName: string; publicApi: boolean; webhooks: boolean };
  apiKeys: {
    id: string;
    name: string;
    prefix: string;
    scopes: string[];
    createdAt: string;
    lastUsedAt: string | null;
    expiresAt: string | null;
    revokedAt: string | null;
  }[];
  webhooks: {
    id: string;
    url: string;
    description: string | null;
    events: string[];
    enabled: boolean;
    consecutiveFailures: number;
    disabledReason: string | null;
    lastDeliveryAt: string | null;
    lastStatusCode: number | null;
  }[];
  deliveries: {
    id: string;
    endpointId: string;
    event: string;
    status: string;
    attempts: number;
    lastStatusCode: number | null;
    lastError: string | null;
    createdAt: string;
  }[];
  events: string[];
  openapiUrl: string;
  apiBaseUrl: string;
}

export default async function DevelopersPage({
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
    `/w/${workspaceId}/developers`,
  );
  const data = await api<Developers>(`/v1/workspaces/${workspaceId}/developers`);
  const keyAction = createApiKey.bind(null, workspaceId);
  const hookAction = createWebhook.bind(null, workspaceId);
  const urlOf = (id: string) => data.webhooks.find((w) => w.id === id)?.url ?? id;

  return (
    <Shell
      email={me.user.email}
      workspace={{ id: workspaceId, name: membership.name, role: membership.role }}
    >
      <QueryNotices notice={q.notice} error={q.error} />
      <Card title="Public API">
        {!data.entitled.publicApi && (
          <Notice kind="info">
            The {data.entitled.planName} plan does not include the public API. Upgrade to Team or
            higher on the Billing page.
          </Notice>
        )}
        <p className="text-sm text-[var(--muted)]">
          Base URL <code className="font-mono text-xs">{data.apiBaseUrl}</code>. Send{' '}
          <code className="font-mono text-xs">Authorization: Bearer pk_live_…</code>. Specification:{' '}
          <a href={data.openapiUrl} className="underline">
            openapi.json
          </a>
          . Zapier and Make recipes are in the integrations guide.
        </p>
        <div className="mt-4">
          <Table head={['Key', 'Scopes', 'Created', 'Last used', 'Expires', '']}>
            {data.apiKeys.length === 0 && (
              <tr>
                <td className="py-2 text-[var(--muted)]" colSpan={6}>
                  No API keys yet.
                </td>
              </tr>
            )}
            {data.apiKeys.map((k) => (
              <tr key={k.id}>
                <td className="py-2 pr-4">
                  {k.name}{' '}
                  <code className="font-mono text-xs text-[var(--muted)]">{k.prefix}…</code>{' '}
                  {k.revokedAt && <Badge tone="danger">revoked</Badge>}
                </td>
                <td className="py-2 pr-4">{k.scopes.join(', ')}</td>
                <td className="py-2 pr-4">{fmt(k.createdAt)}</td>
                <td className="py-2 pr-4">{fmt(k.lastUsedAt)}</td>
                <td className="py-2 pr-4">{k.expiresAt ? fmt(k.expiresAt) : 'never'}</td>
                <td className="py-2 text-right">
                  {canManage && !k.revokedAt && (
                    <form action={revokeApiKey.bind(null, workspaceId, k.id)}>
                      <Button variant="danger">Revoke</Button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        </div>
        {canManage && data.entitled.publicApi && (
          <div className="mt-4 border-t border-[var(--border)] pt-4">
            <h3 className="mb-2 text-sm font-semibold">Create a key</h3>
            <SecretForm action={keyAction} submitLabel="Create API key">
              <div className="grid gap-3 sm:grid-cols-3">
                <Input name="name" label="Name" placeholder="Zapier" required />
                <Input name="expiresInDays" label="Expires in days (optional)" type="number" />
                <label className="flex items-end gap-2 pb-2 text-sm">
                  <input type="checkbox" name="write" /> Allow writes (create posts, retry,
                  webhooks)
                </label>
              </div>
            </SecretForm>
          </div>
        )}
      </Card>

      <Card title="Webhooks">
        {!data.entitled.webhooks && (
          <Notice kind="info">
            Webhooks need the Team plan or higher. Events are delivered as signed POSTs with retries
            for up to two days.
          </Notice>
        )}
        <Table head={['Endpoint', 'Events', 'Status', 'Last delivery', '']}>
          {data.webhooks.length === 0 && (
            <tr>
              <td className="py-2 text-[var(--muted)]" colSpan={5}>
                No webhook endpoints yet.
              </td>
            </tr>
          )}
          {data.webhooks.map((w) => (
            <tr key={w.id}>
              <td className="py-2 pr-4">
                <span className="break-all font-mono text-xs">{w.url}</span>
                {w.description && (
                  <span className="block text-xs text-[var(--muted)]">{w.description}</span>
                )}
              </td>
              <td className="py-2 pr-4 text-xs">
                {w.events.length === 0 ? 'all' : w.events.join(', ')}
              </td>
              <td className="py-2 pr-4">
                {w.enabled ? (
                  <Badge tone="success">enabled</Badge>
                ) : (
                  <Badge tone="danger">disabled</Badge>
                )}
                {w.consecutiveFailures > 0 && (
                  <span className="ml-1 text-xs text-[var(--muted)]">
                    {w.consecutiveFailures} failure(s)
                  </span>
                )}
                {w.disabledReason && (
                  <span className="block text-xs text-[var(--muted)]">{w.disabledReason}</span>
                )}
              </td>
              <td className="py-2 pr-4">
                {fmt(w.lastDeliveryAt)}
                {w.lastStatusCode !== null && (
                  <span className="ml-1 text-xs text-[var(--muted)]">HTTP {w.lastStatusCode}</span>
                )}
              </td>
              <td className="py-2 text-right">
                {canManage && (
                  <form
                    action={webhookAction.bind(null, workspaceId, w.id)}
                    className="flex justify-end gap-2"
                  >
                    <Button variant="secondary" name="op" value="test">
                      Send test
                    </Button>
                    <Button variant="secondary" name="op" value={w.enabled ? 'disable' : 'enable'}>
                      {w.enabled ? 'Disable' : 'Enable'}
                    </Button>
                    <Button variant="danger" name="op" value="delete">
                      Delete
                    </Button>
                  </form>
                )}
              </td>
            </tr>
          ))}
        </Table>
        {canManage && data.entitled.webhooks && (
          <div className="mt-4 border-t border-[var(--border)] pt-4">
            <h3 className="mb-2 text-sm font-semibold">Add an endpoint</h3>
            <SecretForm action={hookAction} submitLabel="Add webhook">
              <div className="grid gap-3 sm:grid-cols-2">
                <Input
                  name="url"
                  label="HTTPS URL"
                  placeholder="https://hooks.zapier.com/…"
                  required
                />
                <Input name="description" label="Description (optional)" />
              </div>
              <details className="text-sm">
                <summary className="cursor-pointer text-[var(--muted)]">
                  Events (none selected = every event)
                </summary>
                <div className="mt-2 grid gap-1 sm:grid-cols-3">
                  {data.events.map((e) => (
                    <label key={e} className="flex items-center gap-2 text-xs">
                      <input type="checkbox" name="events" value={e} /> {e}
                    </label>
                  ))}
                </div>
              </details>
            </SecretForm>
          </div>
        )}
      </Card>

      <Card title="Recent deliveries">
        <Table head={['When', 'Event', 'Endpoint', 'Status', 'Attempts', 'Result']}>
          {data.deliveries.length === 0 && (
            <tr>
              <td className="py-2 text-[var(--muted)]" colSpan={6}>
                Nothing delivered yet.
              </td>
            </tr>
          )}
          {data.deliveries.map((d) => (
            <tr key={d.id}>
              <td className="py-2 pr-4">{fmt(d.createdAt)}</td>
              <td className="py-2 pr-4 font-mono text-xs">{d.event}</td>
              <td className="py-2 pr-4 font-mono text-xs">{urlOf(d.endpointId)}</td>
              <td className="py-2 pr-4">
                <Badge
                  tone={
                    d.status === 'delivered'
                      ? 'success'
                      : d.status === 'dead'
                        ? 'danger'
                        : 'warning'
                  }
                >
                  {d.status}
                </Badge>
              </td>
              <td className="py-2 pr-4">{d.attempts}</td>
              <td className="py-2 pr-4 text-xs text-[var(--muted)]">
                {d.lastStatusCode ? `HTTP ${d.lastStatusCode}` : ''} {d.lastError ?? ''}
              </td>
            </tr>
          ))}
        </Table>
      </Card>
    </Shell>
  );
}
