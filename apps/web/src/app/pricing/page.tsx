import type { Metadata } from 'next';
import { Check, PlanCards } from '@/components/plan-cards';
import { CtaLink, Eyebrow, SiteFooter, SiteHeader } from '@/components/site';
import { getMe } from '@/lib/api';
import { fmtNumber, loadPlans, type PublicPlan } from '@/lib/plans';

export const metadata: Metadata = {
  title: 'Pricing',
  description:
    'Postelyo plans: start free with one social account, then grow to teams and agencies. Early access pricing, no card needed to start.',
  alternates: { canonical: '/pricing' },
};

type Cell = string | boolean;

const ROWS: { label: string; value: (p: PublicPlan) => Cell }[] = [
  { label: 'Connected social accounts', value: (p) => String(p.limits.accounts) },
  { label: 'Posts per month', value: (p) => fmtNumber(p.limits.postsPerMonth) },
  {
    label: 'Team members',
    value: (p) => (p.limits.members === null ? 'Unlimited' : String(p.limits.members)),
  },
  {
    label: 'AI tokens per month',
    value: (p) => (p.limits.aiTokensPerMonth > 0 ? fmtNumber(p.limits.aiTokensPerMonth) : false),
  },
  { label: 'Notion workflow and exactly-once publishing', value: () => true },
  { label: 'Results and weekly analytics in Notion', value: () => true },
  { label: 'Campaigns, series and approvals', value: () => true },
  { label: 'Public API and signed webhooks', value: (p) => p.features.includes('publicApi') },
  { label: 'Audit export', value: (p) => p.features.includes('auditExport') },
  { label: 'Single sign-on (OIDC)', value: (p) => p.features.includes('sso') },
  { label: 'Per-workspace encryption keys', value: (p) => p.features.includes('tenantKeys') },
];

export default async function PricingPage() {
  const [me, plans] = await Promise.all([getMe(), loadPlans()]);
  const signedIn = me !== null;
  return (
    <div className="bg-white">
      <SiteHeader signedIn={signedIn} />
      <section className="relative overflow-hidden">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 -top-40 h-[30rem] bg-[radial-gradient(60%_50%_at_50%_0%,rgb(99_102_241/0.16),transparent)]"
        />
        <div className="relative mx-auto max-w-6xl px-5 pt-16 pb-12 text-center lg:pt-24">
          <Eyebrow>Pricing</Eyebrow>
          <h1 className="mx-auto mt-3 max-w-3xl text-4xl font-semibold tracking-tight text-slate-900 sm:text-5xl">
            Simple plans that grow with your content
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg leading-8 text-slate-600">
            Start free with one account. Every plan publishes from Notion, never twice, and reports
            results back to the page.
          </p>
        </div>
      </section>
      <section className="mx-auto max-w-6xl px-5 pb-20">
        <PlanCards plans={plans} signedIn={signedIn} />
      </section>

      {plans.length > 0 && (
        <section className="bg-slate-50/70">
          <div className="mx-auto max-w-6xl px-5 py-20">
            <h2 className="text-center text-2xl font-semibold tracking-tight text-slate-900">
              Compare plans
            </h2>
            <div className="mt-10 overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-left">
                    <th className="px-5 py-4 font-semibold text-slate-900">Feature</th>
                    {plans.map((p) => (
                      <th
                        key={p.id}
                        className={`px-5 py-4 text-center font-semibold ${p.id === 'team' ? 'text-[var(--primary)]' : 'text-slate-900'}`}
                      >
                        {p.name}
                        <span className="block text-xs font-normal text-slate-500">
                          {p.custom ? 'Custom' : `$${p.priceUsd}/mo`}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {ROWS.map((row) => (
                    <tr key={row.label} className="hover:bg-slate-50/60">
                      <td className="px-5 py-3.5 text-slate-700">{row.label}</td>
                      {plans.map((p) => {
                        const v = row.value(p);
                        return (
                          <td key={p.id} className="px-5 py-3.5 text-center text-slate-700">
                            {v === true ? (
                              <span className="inline-flex justify-center">
                                <Check />
                                <span className="sr-only">Included</span>
                              </span>
                            ) : v === false ? (
                              <span className="text-slate-300" aria-label="Not included">
                                —
                              </span>
                            ) : (
                              <span className="font-medium tabular-nums">{v}</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-4 text-center text-xs text-slate-500">
              Early access pricing in USD, billed monthly. Limits are per workspace; posts count
              each platform a post is published to.
            </p>
          </div>
        </section>
      )}

      <section className="px-5 py-20 text-center">
        <h2 className="text-2xl font-semibold tracking-tight text-slate-900">
          Not sure which plan fits?
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-slate-600">
          Start on Free and connect your Notion. You can upgrade from the Billing page at any time;
          nothing you set up is lost.
        </p>
        <div className="mt-8 flex justify-center">
          <CtaLink href={signedIn ? '/workspaces' : '/sign-up'} size="lg">
            {signedIn ? 'Open dashboard' : 'Get started free'}
          </CtaLink>
        </div>
      </section>
      <SiteFooter />
    </div>
  );
}
