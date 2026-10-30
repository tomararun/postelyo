import 'server-only';
import { API_URL } from '@/lib/api';

/** Public plan catalog served by the api (`GET /v1/plans`); the single source of plan limits. */
export interface PublicPlan {
  id: 'free' | 'solo' | 'team' | 'agency' | 'enterprise';
  name: string;
  priceUsd: number;
  custom: boolean;
  limits: {
    accounts: number;
    postsPerMonth: number;
    /** null = unlimited */
    members: number | null;
    aiTokensPerMonth: number;
  };
  features: ('publicApi' | 'webhooks' | 'auditExport' | 'sso' | 'tenantKeys')[];
}

/** Empty list when the api is unreachable, so public pages still render. */
export async function loadPlans(): Promise<PublicPlan[]> {
  try {
    const res = await fetch(`${API_URL}/v1/plans`, { next: { revalidate: 300 } });
    if (!res.ok) return [];
    const body = (await res.json()) as { plans?: PublicPlan[] };
    return body.plans ?? [];
  } catch {
    return [];
  }
}

export const PLAN_TAGLINE: Record<PublicPlan['id'], string> = {
  free: 'Try the full Notion workflow on one account.',
  solo: 'For creators publishing every day.',
  team: 'For marketing teams with reviewers and an API.',
  agency: 'For agencies running many brands.',
  enterprise: 'SSO, dedicated keys and data residency.',
};

export const fmtNumber = (n: number) =>
  n >= 1_000_000
    ? `${n / 1_000_000}M`
    : n >= 1000
      ? `${(n / 1000).toLocaleString('en-US')}k`
      : n.toLocaleString('en-US');

/** Short bullet list for a plan card, derived only from the real limits and features. */
export function planHighlights(p: PublicPlan): string[] {
  const out = [
    `${p.limits.accounts} connected social ${p.limits.accounts === 1 ? 'account' : 'accounts'}`,
    `${fmtNumber(p.limits.postsPerMonth)} posts per month`,
    p.limits.members === null
      ? 'Unlimited team members'
      : `${p.limits.members} team ${p.limits.members === 1 ? 'member' : 'members'}`,
    p.limits.aiTokensPerMonth > 0
      ? `AI drafts and variants (${fmtNumber(p.limits.aiTokensPerMonth)} tokens/month)`
      : 'Analytics back in Notion',
  ];
  if (p.features.includes('publicApi')) out.push('Public API, webhooks and audit export');
  if (p.features.includes('sso')) out.push('Single sign-on and per-workspace keys');
  return out;
}
