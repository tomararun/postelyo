import type { Subscription } from '../../infra/db/schema.js';

/**
 * Plans and limits (Phase 3). Prices live in Stripe (price ids from env);
 * limits live here so enforcement never needs a Stripe call. Amounts shown
 * in the UI are placeholders until pricing is decided.
 */

export type PlanId = 'free' | 'solo' | 'team' | 'agency' | 'enterprise';

/** Phase 7 entitlements; every one is off unless the plan lists it. */
export type PlanFeature = 'publicApi' | 'webhooks' | 'auditExport' | 'sso' | 'tenantKeys';

export interface PlanLimits {
  /** Connected social accounts (active, any provider). */
  accounts: number;
  /** Publications published per calendar month (UTC). */
  postsPerMonth: number;
  /** Members per workspace, including the owner; Infinity = unlimited. */
  members: number;
  /** Phase 6: AI tokens (input + output) per calendar month; 0 = no AI assistance. */
  aiTokensPerMonth: number;
}

export interface Plan {
  id: PlanId;
  name: string;
  /** Monthly price in USD for display only; 0 with `custom` means "contact us". */
  priceUsd: number;
  custom?: boolean;
  limits: PlanLimits;
  features: readonly PlanFeature[];
}

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: 'free',
    name: 'Free',
    priceUsd: 0,
    limits: { accounts: 1, postsPerMonth: 10, members: 1, aiTokensPerMonth: 0 },
    features: [],
  },
  solo: {
    id: 'solo',
    name: 'Solo',
    priceUsd: 19,
    limits: { accounts: 3, postsPerMonth: 100, members: 2, aiTokensPerMonth: 200_000 },
    features: [],
  },
  team: {
    id: 'team',
    name: 'Team',
    priceUsd: 49,
    limits: { accounts: 10, postsPerMonth: 500, members: 5, aiTokensPerMonth: 1_000_000 },
    features: ['publicApi', 'webhooks', 'auditExport'],
  },
  agency: {
    id: 'agency',
    name: 'Agency',
    priceUsd: 149,
    limits: { accounts: 50, postsPerMonth: 5000, members: Infinity, aiTokensPerMonth: 5_000_000 },
    features: ['publicApi', 'webhooks', 'auditExport'],
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    priceUsd: 0,
    custom: true,
    limits: {
      accounts: 200,
      postsPerMonth: 50_000,
      members: Infinity,
      aiTokensPerMonth: 20_000_000,
    },
    features: ['publicApi', 'webhooks', 'auditExport', 'sso', 'tenantKeys'],
  },
};

export function planHas(plan: PlanId, feature: PlanFeature): boolean {
  return PLANS[plan].features.includes(feature);
}

export const PAID_PLANS: readonly PlanId[] = ['solo', 'team', 'agency'];

/** Payment failures keep the paid limits this long before the workspace drops to Free. */
export const GRACE_PERIOD_MS = 14 * 24 * 60 * 60_000;

export function isPlanId(v: string): v is PlanId {
  return v in PLANS;
}

/**
 * The plan whose limits apply right now. A subscription that Stripe reports
 * as active or trialing counts; past-due keeps its plan until `grace_until`;
 * anything else (canceled, unpaid, incomplete) is Free.
 */
export function effectivePlan(sub: Subscription | null | undefined, now: Date): PlanId {
  if (!sub || !isPlanId(sub.plan)) return 'free';
  if (sub.status === 'active' || sub.status === 'trialing') return sub.plan;
  if (sub.status === 'past_due' && sub.graceUntil && sub.graceUntil.getTime() > now.getTime()) {
    return sub.plan;
  }
  return 'free';
}

/** Start of the current calendar month in UTC (the metering window). */
export function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
