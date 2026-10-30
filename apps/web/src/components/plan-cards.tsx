import { CtaLink } from '@/components/site';
import { PLAN_TAGLINE, planHighlights, type PublicPlan } from '@/lib/plans';

/** Plan cards for the homepage and pricing page; prices are flagged as early-access. */
export function PlanCards({ plans, signedIn }: { plans: PublicPlan[]; signedIn: boolean }) {
  const shown = plans.filter((p) => p.id !== 'enterprise');
  const enterprise = plans.find((p) => p.id === 'enterprise');
  if (shown.length === 0) {
    return (
      <p className="text-center text-sm text-slate-500">
        Plans are loading. Refresh in a moment, or{' '}
        <a href="/sign-up" className="text-[var(--primary)] underline">
          start free
        </a>
        .
      </p>
    );
  }
  return (
    <div className="space-y-6">
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {shown.map((p) => {
          const featured = p.id === 'team';
          return (
            <div
              key={p.id}
              className={`relative flex flex-col rounded-2xl border bg-white p-6 ${
                featured
                  ? 'border-indigo-300 shadow-xl ring-1 shadow-indigo-600/10 ring-indigo-200'
                  : 'border-slate-200 shadow-sm'
              }`}
            >
              {featured && (
                <span className="absolute -top-3 left-6 rounded-full bg-[var(--primary)] px-2.5 py-0.5 text-xs font-semibold text-white">
                  Most popular
                </span>
              )}
              <p className="font-semibold text-slate-900">{p.name}</p>
              <p className="mt-1 min-h-[2.5rem] text-sm text-slate-500">{PLAN_TAGLINE[p.id]}</p>
              <p className="mt-5 flex items-baseline gap-1">
                <span className="text-4xl font-semibold tracking-tight text-slate-900">
                  ${p.priceUsd}
                </span>
                <span className="text-sm text-slate-500">/ month</span>
              </p>
              <ul className="mt-6 flex-1 space-y-2.5 text-sm text-slate-600">
                {planHighlights(p).map((h) => (
                  <li key={h} className="flex gap-2.5">
                    <Check />
                    {h}
                  </li>
                ))}
              </ul>
              <div className="mt-7">
                <CtaLink
                  href={signedIn ? '/workspaces' : '/sign-up'}
                  variant={featured ? 'primary' : 'secondary'}
                >
                  {signedIn
                    ? 'Open dashboard'
                    : p.priceUsd === 0
                      ? 'Start free'
                      : `Start with ${p.name}`}
                </CtaLink>
              </div>
            </div>
          );
        })}
      </div>
      {enterprise && (
        <div className="flex flex-col items-start justify-between gap-4 rounded-2xl border border-slate-200 bg-gradient-to-r from-slate-900 to-indigo-950 p-6 text-white sm:flex-row sm:items-center">
          <div>
            <p className="font-semibold">{enterprise.name}</p>
            <p className="mt-1 text-sm text-indigo-200">
              {PLAN_TAGLINE.enterprise} Up to {enterprise.limits.accounts} accounts, custom
              contract.
            </p>
          </div>
          <CtaLink href="mailto:sales@postelyo.example" variant="light">
            Contact us
          </CtaLink>
        </div>
      )}
      <p className="text-center text-xs text-slate-500">
        Early access pricing. No card needed to start; upgrade from the dashboard when you need
        more.
      </p>
    </div>
  );
}

export function Check({ className = 'text-[var(--primary)]' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      className={`mt-0.5 h-4 w-4 shrink-0 ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      aria-hidden="true"
    >
      <path d="M5 10.5l3 3 7-7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
