import { and, count, eq, gte, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../../infra/db/client.js';
import {
  auditLog,
  billingCustomer,
  membership,
  socialAccount,
  stripeEvent,
  subscription,
  workspace,
  type Subscription,
} from '../../infra/db/schema.js';
import { withTenantScope } from '../../infra/db/tenant-scope.js';
import type { Logger } from '../../infra/logger.js';
import type { Clock } from '../../shared/clock.js';
import { uuidv7 } from '../../shared/ids.js';
import { recordAudit } from '../audit/audit.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { verifyStripeWebhook, type BillingGateway, type Stripe } from './gateway.js';
import {
  GRACE_PERIOD_MS,
  PAID_PLANS,
  PLANS,
  effectivePlan,
  isPlanId,
  monthStart,
  type PlanId,
  type PlanLimits,
} from './plans.js';

export class BillingError extends Error {
  constructor(
    public readonly code: 'not_configured' | 'unknown_plan' | 'no_customer' | 'invalid_signature',
    message: string,
  ) {
    super(message);
    this.name = 'BillingError';
  }
}

export class PlanLimitError extends Error {
  constructor(
    public readonly limit: keyof PlanLimits,
    public readonly plan: PlanId,
    message: string,
  ) {
    super(message);
    this.name = 'PlanLimitError';
  }
}

export interface BillingConfig {
  /** Stripe price ids per paid plan; a missing id hides that plan from checkout. */
  prices: Partial<Record<PlanId, string>>;
  webhookSecret: string | null;
  appBaseUrl: string;
}

export interface BillingDeps {
  db: Db;
  gateway: BillingGateway | null;
  config: BillingConfig;
  clock: Clock;
  logger: Logger;
}

export interface UsageSummary {
  plan: PlanId;
  planName: string;
  limits: {
    accounts: number;
    postsPerMonth: number;
    members: number | null;
    /** Phase 6 */
    aiTokensPerMonth: number;
  };
  used: { accounts: number; postsThisMonth: number; members: number };
  subscription: {
    status: string;
    currentPeriodEnd: Date | null;
    cancelAt: Date | null;
    graceUntil: Date | null;
  } | null;
  billingConfigured: boolean;
  availablePlans: { id: PlanId; name: string; priceUsd: number; limits: PlanLimits }[];
}

/**
 * Billing (Phase 3): plans, usage and limit enforcement in the services; Stripe
 * Checkout, Customer Portal and signed webhooks for the money side. The
 * `subscription` row mirrors Stripe and is the only thing enforcement reads.
 */
export class BillingService {
  constructor(private readonly deps: BillingDeps) {}

  get configured(): boolean {
    return this.deps.gateway !== null;
  }

  /** Current subscription row (latest by update time), read in system scope for jobs and guards. */
  async subscriptionFor(workspaceId: string): Promise<Subscription | null> {
    const rows = await this.deps.db
      .select()
      .from(subscription)
      .where(eq(subscription.workspaceId, workspaceId))
      .orderBy(subscription.updatedAt);
    // Prefer a live subscription over historical canceled ones.
    return (
      rows.find(
        (r) => r.status === 'active' || r.status === 'trialing' || r.status === 'past_due',
      ) ??
      rows.at(-1) ??
      null
    );
  }

  /**
   * With a subscription, Stripe's state decides. Without one, `workspace.plan`
   * is the source of truth so operators can comp pilots by setting the column.
   */
  async planFor(workspaceId: string): Promise<PlanId> {
    const sub = await this.subscriptionFor(workspaceId);
    if (sub) return effectivePlan(sub, this.deps.clock.now());
    const [ws] = await this.deps.db
      .select({ plan: workspace.plan })
      .from(workspace)
      .where(eq(workspace.id, workspaceId))
      .limit(1);
    return ws && isPlanId(ws.plan) ? ws.plan : 'free';
  }

  async limitsFor(workspaceId: string): Promise<{ plan: PlanId; limits: PlanLimits }> {
    const plan = await this.planFor(workspaceId);
    return { plan, limits: PLANS[plan].limits };
  }

  /** Published publications this calendar month, metered from the audit stream. */
  async postsThisMonth(workspaceId: string): Promise<number> {
    const [row] = await this.deps.db
      .select({ n: count() })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.workspaceId, workspaceId),
          eq(auditLog.event, 'publication.state_changed'),
          eq(auditLog.toState, 'published'),
          gte(auditLog.occurredAt, monthStart(this.deps.clock.now())),
        ),
      );
    return row?.n ?? 0;
  }

  async activeAccounts(workspaceId: string): Promise<number> {
    const [row] = await this.deps.db
      .select({ n: count() })
      .from(socialAccount)
      .where(
        and(
          eq(socialAccount.workspaceId, workspaceId),
          isNull(socialAccount.disconnectedAt),
          inArray(socialAccount.status, ['active', 'needs_reauth']),
        ),
      );
    return row?.n ?? 0;
  }

  async members(workspaceId: string): Promise<number> {
    const [row] = await this.deps.db
      .select({ n: count() })
      .from(membership)
      .where(eq(membership.workspaceId, workspaceId));
    return row?.n ?? 0;
  }

  /** Throws when connecting `adding` more accounts would exceed the plan. */
  async assertAccountCapacity(workspaceId: string, adding: number): Promise<void> {
    const { plan, limits } = await this.limitsFor(workspaceId);
    const used = await this.activeAccounts(workspaceId);
    if (used + adding > limits.accounts) {
      throw new PlanLimitError(
        'accounts',
        plan,
        `The ${PLANS[plan].name} plan allows ${limits.accounts} connected account(s); ${used} are connected. Upgrade the plan or disconnect an account.`,
      );
    }
  }

  async assertMemberCapacity(workspaceId: string): Promise<void> {
    const { plan, limits } = await this.limitsFor(workspaceId);
    const used = await this.members(workspaceId);
    if (used + 1 > limits.members) {
      throw new PlanLimitError(
        'members',
        plan,
        `The ${PLANS[plan].name} plan allows ${limits.members} member(s). Upgrade the plan to invite more people.`,
      );
    }
  }

  /** Whether scheduling one more publication now would exceed the monthly post limit. */
  async postLimitReached(
    workspaceId: string,
  ): Promise<{ reached: boolean; plan: PlanId; limit: number; used: number }> {
    const { plan, limits } = await this.limitsFor(workspaceId);
    const used = await this.postsThisMonth(workspaceId);
    return { reached: used >= limits.postsPerMonth, plan, limit: limits.postsPerMonth, used };
  }

  async usage(ctx: TenantContext): Promise<UsageSummary> {
    const sub = await this.subscriptionFor(ctx.workspaceId);
    const plan = effectivePlan(sub, this.deps.clock.now());
    const limits = PLANS[plan].limits;
    return {
      plan,
      planName: PLANS[plan].name,
      limits: {
        accounts: limits.accounts,
        postsPerMonth: limits.postsPerMonth,
        members: Number.isFinite(limits.members) ? limits.members : null,
        aiTokensPerMonth: limits.aiTokensPerMonth,
      },
      used: {
        accounts: await this.activeAccounts(ctx.workspaceId),
        postsThisMonth: await this.postsThisMonth(ctx.workspaceId),
        members: await this.members(ctx.workspaceId),
      },
      subscription: sub
        ? {
            status: sub.status,
            currentPeriodEnd: sub.currentPeriodEnd,
            cancelAt: sub.cancelAt,
            graceUntil: sub.graceUntil,
          }
        : null,
      billingConfigured: this.configured,
      availablePlans: PAID_PLANS.filter((p) => this.deps.config.prices[p]).map((p) => ({
        id: p,
        name: PLANS[p].name,
        priceUsd: PLANS[p].priceUsd,
        limits: PLANS[p].limits,
      })),
    };
  }

  /** Hosted Checkout URL for a paid plan. */
  async checkout(ctx: TenantContext, plan: string, customerEmail: string): Promise<string> {
    if (!this.deps.gateway) throw new BillingError('not_configured', 'Billing is not configured');
    if (!isPlanId(plan) || plan === 'free' || !this.deps.config.prices[plan]) {
      throw new BillingError('unknown_plan', `Unknown or unavailable plan "${plan}"`);
    }
    const [customer] = await withTenantScope(this.deps.db, ctx.workspaceId, (tx) =>
      tx
        .select()
        .from(billingCustomer)
        .where(eq(billingCustomer.workspaceId, ctx.workspaceId))
        .limit(1),
    );
    const base = `${this.deps.config.appBaseUrl}/w/${ctx.workspaceId}/billing`;
    const session = await this.deps.gateway.createCheckoutSession({
      workspaceId: ctx.workspaceId,
      customerId: customer?.stripeCustomerId ?? null,
      customerEmail,
      priceId: this.deps.config.prices[plan],
      successUrl: `${base}?checkout=success`,
      cancelUrl: `${base}?checkout=cancelled`,
    });
    await recordAudit(this.deps.db, {
      workspaceId: ctx.workspaceId,
      actor: ctx.actor,
      entityType: 'workspace',
      entityId: ctx.workspaceId,
      event: 'billing.checkout_started',
      correlationId: ctx.correlationId,
      data: { plan, sessionId: session.id },
    });
    return session.url;
  }

  /** Customer Portal URL (change plan, payment method, invoices, cancel). */
  async portal(ctx: TenantContext): Promise<string> {
    if (!this.deps.gateway) throw new BillingError('not_configured', 'Billing is not configured');
    const [customer] = await withTenantScope(this.deps.db, ctx.workspaceId, (tx) =>
      tx
        .select()
        .from(billingCustomer)
        .where(eq(billingCustomer.workspaceId, ctx.workspaceId))
        .limit(1),
    );
    if (!customer)
      throw new BillingError('no_customer', 'This workspace has no billing account yet');
    const session = await this.deps.gateway.createPortalSession(
      customer.stripeCustomerId,
      `${this.deps.config.appBaseUrl}/w/${ctx.workspaceId}/billing`,
    );
    return session.url;
  }

  /**
   * Signed Stripe webhook. Idempotent on the event id; unknown event types are
   * recorded and ignored. Never throws for a valid signature: Stripe retries
   * on non-2xx, so we only fail the request when the signature is bad.
   */
  async handleWebhook(
    rawBody: Buffer,
    signature: string | undefined,
    correlationId: string,
  ): Promise<string> {
    if (!this.deps.config.webhookSecret || !signature) {
      throw new BillingError('invalid_signature', 'Stripe webhooks are not configured');
    }
    let event: Stripe.Event;
    try {
      event = verifyStripeWebhook(rawBody, signature, this.deps.config.webhookSecret);
    } catch (err) {
      throw new BillingError(
        'invalid_signature',
        `Invalid Stripe signature: ${(err as Error).message}`,
      );
    }
    const now = this.deps.clock.now();
    const inserted = await this.deps.db
      .insert(stripeEvent)
      .values({ id: event.id, type: event.type, receivedAt: now })
      .onConflictDoNothing()
      .returning({ id: stripeEvent.id });
    if (inserted.length === 0) return 'duplicate';

    let outcome: string;
    try {
      outcome = await this.apply(event, correlationId);
    } catch (err) {
      this.deps.logger.error({ err, eventId: event.id, type: event.type }, 'stripe event failed');
      outcome = `error:${(err as Error).message.slice(0, 200)}`;
    }
    await this.deps.db
      .update(stripeEvent)
      .set({ processedAt: this.deps.clock.now(), outcome })
      .where(eq(stripeEvent.id, event.id));
    return outcome;
  }

  private async apply(event: Stripe.Event, correlationId: string): Promise<string> {
    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object;
        const workspaceId = s.metadata?.['workspaceId'] ?? s.client_reference_id;
        const customerId = typeof s.customer === 'string' ? s.customer : s.customer?.id;
        if (!workspaceId || !customerId) return 'ignored:missing_ids';
        await this.deps.db
          .insert(billingCustomer)
          .values({
            workspaceId,
            stripeCustomerId: customerId,
            email: s.customer_details?.email ?? s.customer_email ?? null,
          })
          .onConflictDoUpdate({
            target: billingCustomer.workspaceId,
            set: { stripeCustomerId: customerId },
          });
        return 'customer_linked';
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        return this.upsertSubscription(sub, correlationId);
      }
      case 'invoice.payment_failed': {
        const inv = event.data.object;
        const subId = subscriptionIdOf(inv);
        if (!subId) return 'ignored:no_subscription';
        const now = this.deps.clock.now();
        const [row] = await this.deps.db
          .update(subscription)
          .set({
            status: 'past_due',
            graceUntil: new Date(now.getTime() + GRACE_PERIOD_MS),
            updatedAt: now,
          })
          .where(eq(subscription.stripeSubscriptionId, subId))
          .returning();
        if (row) await this.syncWorkspacePlan(row.workspaceId, correlationId, 'payment_failed');
        return row ? 'grace_started' : 'ignored:unknown_subscription';
      }
      case 'invoice.paid': {
        const inv = event.data.object;
        const subId = subscriptionIdOf(inv);
        if (!subId) return 'ignored:no_subscription';
        const now = this.deps.clock.now();
        const [row] = await this.deps.db
          .update(subscription)
          .set({ status: 'active', graceUntil: null, updatedAt: now })
          .where(eq(subscription.stripeSubscriptionId, subId))
          .returning();
        if (row) await this.syncWorkspacePlan(row.workspaceId, correlationId, 'payment_succeeded');
        return row ? 'payment_recorded' : 'ignored:unknown_subscription';
      }
      default:
        return 'ignored';
    }
  }

  private async upsertSubscription(
    sub: Stripe.Subscription,
    correlationId: string,
  ): Promise<string> {
    const workspaceId = sub.metadata?.['workspaceId'];
    const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
    let wsId = workspaceId;
    if (!wsId) {
      const [c] = await this.deps.db
        .select()
        .from(billingCustomer)
        .where(eq(billingCustomer.stripeCustomerId, customerId))
        .limit(1);
      wsId = c?.workspaceId;
    }
    if (!wsId) return 'ignored:unknown_workspace';
    await this.deps.db
      .insert(billingCustomer)
      .values({ workspaceId: wsId, stripeCustomerId: customerId })
      .onConflictDoNothing();
    const priceId = sub.items.data[0]?.price.id ?? null;
    const plan = this.planForPrice(priceId);
    const now = this.deps.clock.now();
    const periodEnd = sub.items.data[0]?.current_period_end;
    const values = {
      workspaceId: wsId,
      stripePriceId: priceId,
      plan,
      status: sub.status,
      currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
      cancelAt: sub.cancel_at ? new Date(sub.cancel_at * 1000) : null,
      ...(sub.status !== 'past_due' ? { graceUntil: null } : {}),
      updatedAt: now,
    };
    await this.deps.db
      .insert(subscription)
      .values({ id: uuidv7(), stripeSubscriptionId: sub.id, ...values })
      .onConflictDoUpdate({ target: subscription.stripeSubscriptionId, set: values });
    await this.syncWorkspacePlan(wsId, correlationId, `subscription.${sub.status}`);
    return `subscription_${sub.status}`;
  }

  private planForPrice(priceId: string | null): PlanId {
    if (!priceId) return 'free';
    for (const p of PAID_PLANS) if (this.deps.config.prices[p] === priceId) return p;
    return 'free';
  }

  /** Keeps `workspace.plan` equal to the effective plan and audits changes. */
  async syncWorkspacePlan(
    workspaceId: string,
    correlationId: string,
    reason: string,
  ): Promise<PlanId> {
    const plan = await this.planFor(workspaceId);
    const [before] = await this.deps.db
      .select({ plan: workspace.plan })
      .from(workspace)
      .where(eq(workspace.id, workspaceId))
      .limit(1);
    if (before && before.plan !== plan) {
      await this.deps.db
        .update(workspace)
        .set({ plan, updatedAt: this.deps.clock.now() })
        .where(eq(workspace.id, workspaceId));
      await recordAudit(this.deps.db, {
        workspaceId,
        actor: { type: 'webhook', id: 'stripe' },
        entityType: 'workspace',
        entityId: workspaceId,
        event: 'billing.plan_changed',
        fromState: before.plan,
        toState: plan,
        correlationId,
        data: { reason },
      });
    }
    return plan;
  }

  /** Maintenance: past-due subscriptions whose grace ended drop the workspace to Free. */
  async expireGracePeriods(correlationId: string): Promise<number> {
    const now = this.deps.clock.now();
    const rows = await this.deps.db
      .select()
      .from(subscription)
      .where(eq(subscription.status, 'past_due'));
    let n = 0;
    for (const row of rows) {
      if (row.graceUntil && row.graceUntil.getTime() <= now.getTime()) {
        const plan = await this.syncWorkspacePlan(row.workspaceId, correlationId, 'grace_expired');
        if (plan === 'free') n += 1;
      }
    }
    return n;
  }
}

function subscriptionIdOf(inv: Stripe.Invoice): string | null {
  const details = (inv as { parent?: { subscription_details?: { subscription?: unknown } } }).parent
    ?.subscription_details?.subscription;
  if (typeof details === 'string') return details;
  if (details && typeof details === 'object' && 'id' in details) return String(details.id);
  const legacy = (inv as { subscription?: unknown }).subscription;
  if (typeof legacy === 'string') return legacy;
  if (legacy && typeof legacy === 'object' && 'id' in legacy) return String(legacy.id);
  return null;
}
