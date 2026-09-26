import { openPortal, startCheckout } from '@/app/actions';
import { Shell } from '@/components/shell';
import { Badge, Button, Card, Notice, QueryNotices } from '@/components/ui';
import { api, fmt } from '@/lib/api';
import { loadWorkspace } from '@/lib/workspace';

interface Usage {
  plan: string;
  planName: string;
  limits: { accounts: number; postsPerMonth: number; members: number | null };
  used: { accounts: number; postsThisMonth: number; members: number };
  subscription: {
    status: string;
    currentPeriodEnd: string | null;
    cancelAt: string | null;
    graceUntil: string | null;
  } | null;
  billingConfigured: boolean;
  availablePlans: {
    id: string;
    name: string;
    priceUsd: number;
    limits: { accounts: number; postsPerMonth: number; members: number | null };
  }[];
}

export default async function BillingPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ notice?: string; error?: string; checkout?: string }>;
}) {
  const { workspaceId } = await params;
  const q = await searchParams;
  const { me, membership } = await loadWorkspace(workspaceId, `/w/${workspaceId}/billing`);
  const usage = await api<Usage>(`/v1/workspaces/${workspaceId}/billing`);
  const isOwner = membership.role === 'owner';
  const meter = (used: number, limit: number | null) =>
    limit === null ? `${used} (unlimited)` : `${used} / ${limit}`;

  return (
    <Shell
      email={me.user.email}
      workspace={{ id: workspaceId, name: membership.name, role: membership.role }}
    >
      <QueryNotices
        notice={
          q.notice ??
          (q.checkout === 'success'
            ? 'Payment received. The plan updates within a minute.'
            : undefined)
        }
        error={q.error ?? (q.checkout === 'cancelled' ? 'Checkout cancelled.' : undefined)}
      />
      <Card
        title={`Current plan: ${usage.planName}`}
        actions={
          isOwner && usage.subscription && usage.billingConfigured ? (
            <form action={openPortal.bind(null, workspaceId)}>
              <Button variant="secondary">Manage billing</Button>
            </form>
          ) : undefined
        }
      >
        <dl className="grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-[var(--muted)]">Connected accounts</dt>
            <dd className="font-medium">{meter(usage.used.accounts, usage.limits.accounts)}</dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">Posts this month</dt>
            <dd className="font-medium">
              {meter(usage.used.postsThisMonth, usage.limits.postsPerMonth)}
            </dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">Members</dt>
            <dd className="font-medium">{meter(usage.used.members, usage.limits.members)}</dd>
          </div>
        </dl>
        {usage.subscription && (
          <p className="mt-4 text-sm">
            Subscription{' '}
            <Badge tone={usage.subscription.status === 'active' ? 'success' : 'warning'}>
              {usage.subscription.status}
            </Badge>
            {usage.subscription.currentPeriodEnd && (
              <> · renews {fmt(usage.subscription.currentPeriodEnd)}</>
            )}
            {usage.subscription.cancelAt && <> · cancels {fmt(usage.subscription.cancelAt)}</>}
            {usage.subscription.graceUntil && (
              <> · payment failed, paid limits until {fmt(usage.subscription.graceUntil)}</>
            )}
          </p>
        )}
        {!usage.billingConfigured && (
          <Notice kind="info">
            Billing is not configured on this server; plans are informational.
          </Notice>
        )}
      </Card>
      <Card title="Plans">
        <div className="grid gap-4 md:grid-cols-3">
          {usage.availablePlans.map((p) => (
            <div key={p.id} className="rounded-md border border-[var(--border)] p-4">
              <div className="flex items-baseline justify-between">
                <h3 className="font-semibold">{p.name}</h3>
                <span className="text-sm">${p.priceUsd}/mo</span>
              </div>
              <ul className="my-3 space-y-1 text-sm text-[var(--muted)]">
                <li>{p.limits.accounts} connected accounts</li>
                <li>{p.limits.postsPerMonth} posts a month</li>
                <li>
                  {p.limits.members === null ? 'Unlimited members' : `${p.limits.members} members`}
                </li>
              </ul>
              {isOwner && usage.billingConfigured && usage.plan !== p.id && (
                <form action={startCheckout.bind(null, workspaceId)}>
                  <input type="hidden" name="plan" value={p.id} />
                  <Button>{usage.subscription ? 'Switch' : 'Upgrade'}</Button>
                </form>
              )}
              {usage.plan === p.id && <Badge tone="success">current</Badge>}
            </div>
          ))}
          {usage.availablePlans.length === 0 && (
            <p className="text-sm text-[var(--muted)]">
              No paid plans are configured (STRIPE_PRICE_* env vars).
            </p>
          )}
        </div>
        <p className="mt-3 text-xs text-[var(--muted)]">
          Prices are placeholders until pricing is decided. Only owners can change the plan.
        </p>
      </Card>
    </Shell>
  );
}
