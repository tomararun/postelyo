import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Icon, type IconName } from '@/components/icons';
import { Check, PlanCards } from '@/components/plan-cards';
import { CtaLink, Eyebrow, SiteFooter, SiteHeader } from '@/components/site';
import { getMe } from '@/lib/api';
import { loadPlans } from '@/lib/plans';

export const metadata: Metadata = {
  title: { absolute: 'Postelyo · Plan in Notion, publish everywhere' },
  description:
    'Schedule LinkedIn, X, Facebook and Instagram posts straight from your Notion database. Exactly-once publishing, results written back to Notion, approvals and AI drafts.',
  alternates: { canonical: '/' },
};

const STEPS: { title: string; body: string }[] = [
  {
    title: 'Connect your Notion',
    body: 'Sign in, connect Notion in one click and pick a page. Postelyo creates a ready-made content calendar, or uses the database you already have.',
  },
  {
    title: 'Connect your social accounts',
    body: 'Link LinkedIn profiles and Pages, X, Facebook Pages and Instagram. Tokens are encrypted and never leave Postelyo.',
  },
  {
    title: 'Set a page to Scheduled',
    body: 'Write in Notion, pick platforms and a date, flip the status. Postelyo publishes on time and writes the live link back to the page.',
  },
];

const FEATURES: { icon: IconName; title: string; body: string }[] = [
  {
    icon: 'posts',
    title: 'Notion is your calendar',
    body: 'No new editor to learn. Drafts, reviews and schedules live in the Notion database your team already uses.',
  },
  {
    icon: 'connections',
    title: 'Every major platform',
    body: 'LinkedIn profiles and Pages, X, Facebook Pages and Instagram, with per-platform text and images.',
  },
  {
    icon: 'security',
    title: 'Published exactly once',
    body: 'Leases, retries and reconciliation mean an outage delays a post, it never doubles it. Every step is audited.',
  },
  {
    icon: 'analytics',
    title: 'Results back in Notion',
    body: 'Impressions, reactions and clicks land on each page, plus weekly rollups, best times and a Monday report.',
  },
  {
    icon: 'team',
    title: 'Campaigns and approvals',
    body: 'Group posts into campaigns, repeat evergreen content, and require a reviewer before anything goes live.',
  },
  {
    icon: 'ai',
    title: 'AI that drafts, you decide',
    body: 'Turn ideas into drafts and posts into platform variants in your brand voice. Nothing is scheduled without you.',
  },
];

const FAQ: { q: string; a: string }[] = [
  {
    q: 'Do I need to change how my team works in Notion?',
    a: 'No. Postelyo adds a few properties to a content database (status, platforms, publish date) and reads the page body as the post. Everything else stays yours.',
  },
  {
    q: 'Which platforms are supported?',
    a: 'LinkedIn (profiles and company Pages), X, Facebook Pages and Instagram business accounts. Each post can carry its own text per platform.',
  },
  {
    q: 'What happens if a platform is down at the scheduled time?',
    a: 'Postelyo retries with backoff and, when the outcome is unclear, checks the platform before trying again, so a post is never published twice. Notion shows the status the whole time.',
  },
  {
    q: 'Is my data safe?',
    a: 'Social and Notion tokens are encrypted at rest and never written to Notion, logs or the browser. Every workspace is isolated at the database level, and enterprise workspaces can have their own encryption key.',
  },
  {
    q: 'Can I try it for free?',
    a: 'Yes. The Free plan includes one social account and ten posts a month, no card needed. Upgrade from the dashboard when you need more.',
  },
  {
    q: 'Does it work with Zapier, Make or my own tools?',
    a: 'Team plans and above include a public API, signed webhooks and an audit export, documented with an OpenAPI specification.',
  },
];

export default async function HomePage() {
  const [me, plans] = await Promise.all([getMe(), loadPlans()]);
  const signedIn = me !== null;
  const primaryCta = signedIn
    ? { href: '/workspaces', label: 'Open dashboard' }
    : { href: '/sign-up', label: 'Get started free' };

  return (
    <div className="bg-white">
      <SiteHeader signedIn={signedIn} />

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 -top-40 h-[36rem] bg-[radial-gradient(60%_50%_at_50%_0%,rgb(99_102_241/0.18),transparent)]"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 [background-image:linear-gradient(rgb(15_23_42/0.04)_1px,transparent_1px),linear-gradient(90deg,rgb(15_23_42/0.04)_1px,transparent_1px)] [background-size:44px_44px] [mask-image:radial-gradient(ellipse_at_top,black_30%,transparent_70%)]"
        />
        <div className="relative mx-auto grid max-w-6xl items-center gap-14 px-5 pt-16 pb-20 lg:grid-cols-[1.15fr_1fr] lg:pt-24 lg:pb-28">
          <div>
            <span className="inline-flex items-center gap-2 rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700">
              <span className="h-1.5 w-1.5 rounded-full bg-indigo-500" />
              Now in early access
            </span>
            <h1 className="mt-6 text-4xl leading-[1.08] font-semibold tracking-tight text-slate-900 sm:text-5xl lg:text-[3.4rem]">
              Plan in Notion.
              <br />
              <span className="bg-gradient-to-r from-indigo-600 via-violet-600 to-fuchsia-600 bg-clip-text whitespace-nowrap text-transparent">
                Publish everywhere.
              </span>
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-8 text-slate-600">
              Postelyo turns your Notion content database into a social media scheduler. Set a page
              to <em className="font-medium text-slate-800 not-italic">Scheduled</em> and it goes
              live on LinkedIn, X, Facebook and Instagram, on time and exactly once.
            </p>
            <div className="mt-9 flex flex-wrap gap-3">
              <CtaLink href={primaryCta.href} size="lg">
                {primaryCta.label}
                <Icon name="arrow" className="h-4 w-4" />
              </CtaLink>
              <CtaLink href="/#how-it-works" size="lg" variant="secondary">
                See how it works
              </CtaLink>
            </div>
            <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm text-slate-500">
              {[
                'Free plan, no card needed',
                'Set up in 5 minutes',
                'Your content stays in Notion',
              ].map((t) => (
                <li key={t} className="flex items-center gap-2">
                  <Check className="text-emerald-500" />
                  {t}
                </li>
              ))}
            </ul>
          </div>
          <HeroVisual />
        </div>
      </section>

      {/* Platforms strip */}
      <section className="border-y border-slate-100 bg-slate-50/60">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-center gap-x-10 gap-y-3 px-5 py-6 text-sm font-semibold text-slate-400">
          <span className="text-xs font-medium tracking-wide text-slate-400 uppercase">
            Publishes to
          </span>
          {['LinkedIn', 'LinkedIn Pages', 'X', 'Facebook Pages', 'Instagram'].map((p) => (
            <span key={p} className="text-slate-500">
              {p}
            </span>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section id="how-it-works" className="scroll-mt-20">
        <div className="mx-auto max-w-6xl px-5 py-24">
          <SectionHeading
            eyebrow="How it works"
            title="From Notion page to live post in three steps"
            body="No new tool for your writers. Postelyo works in the background and keeps Notion up to date."
          />
          <ol className="mt-14 grid gap-6 md:grid-cols-3">
            {STEPS.map((s, i) => (
              <li
                key={s.title}
                className="relative rounded-2xl border border-slate-200 bg-white p-7 shadow-sm"
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-sm font-semibold text-white shadow-md shadow-indigo-600/25">
                  {i + 1}
                </span>
                <h3 className="mt-5 font-semibold text-slate-900">{s.title}</h3>
                <p className="mt-2 text-sm leading-6 text-slate-600">{s.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="scroll-mt-20 bg-slate-50/70">
        <div className="mx-auto max-w-6xl px-5 py-24">
          <SectionHeading
            eyebrow="Features"
            title="Everything a content team needs, nothing it has to babysit"
          />
          <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <div
                key={f.title}
                className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-shadow hover:shadow-md"
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-50 text-[var(--primary)] ring-1 ring-indigo-100">
                  <Icon name={f.icon} className="h-5 w-5" />
                </span>
                <h3 className="mt-5 font-semibold text-slate-900">{f.title}</h3>
                <p className="mt-2 text-sm leading-6 text-slate-600">{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="scroll-mt-20">
        <div className="mx-auto max-w-6xl px-5 py-24">
          <SectionHeading
            eyebrow="Pricing"
            title="Start free, grow when you need to"
            body="Every plan includes the full Notion workflow, exactly-once publishing and results in Notion."
          />
          <div className="mt-14">
            <PlanCards plans={plans} signedIn={signedIn} />
          </div>
          <p className="mt-6 text-center text-sm">
            <a href="/pricing" className="font-medium text-[var(--primary)] hover:underline">
              Compare all plans in detail
            </a>
          </p>
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="scroll-mt-20 bg-slate-50/70">
        <div className="mx-auto max-w-3xl px-5 py-24">
          <SectionHeading eyebrow="FAQ" title="Questions, answered" />
          <div className="mt-12 divide-y divide-slate-200 rounded-2xl border border-slate-200 bg-white shadow-sm">
            {FAQ.map((f) => (
              <details key={f.q} className="group px-6 py-5">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium text-slate-900">
                  {f.q}
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500 transition-transform group-open:rotate-45">
                    <svg
                      viewBox="0 0 20 20"
                      className="h-3.5 w-3.5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      aria-hidden="true"
                    >
                      <path d="M10 4v12M4 10h12" strokeLinecap="round" />
                    </svg>
                  </span>
                </summary>
                <p className="mt-3 text-sm leading-6 text-slate-600">{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="px-5 py-24">
        <div className="relative mx-auto max-w-5xl overflow-hidden rounded-3xl bg-gradient-to-br from-indigo-600 via-indigo-700 to-violet-700 px-8 py-16 text-center text-white shadow-2xl shadow-indigo-900/20 sm:px-16">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 opacity-[0.12] [background-image:radial-gradient(white_1px,transparent_1px)] [background-size:22px_22px]"
          />
          <h2 className="relative text-3xl font-semibold tracking-tight sm:text-4xl">
            Your next post is already in Notion.
          </h2>
          <p className="relative mx-auto mt-4 max-w-xl text-indigo-100">
            Connect your database, link an account and schedule it in minutes. Free to start.
          </p>
          <div className="relative mt-8 flex justify-center">
            <CtaLink href={primaryCta.href} size="lg" variant="light">
              {signedIn ? 'Open dashboard' : 'Connect your Notion'}
              <Icon name="arrow" className="h-4 w-4" />
            </CtaLink>
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}

function SectionHeading({
  eyebrow,
  title,
  body,
}: {
  eyebrow: string;
  title: string;
  body?: string;
}) {
  return (
    <div className="mx-auto max-w-2xl text-center">
      <Eyebrow>{eyebrow}</Eyebrow>
      <h2 className="mt-3 text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">
        {title}
      </h2>
      {body && <p className="mt-4 text-lg leading-8 text-slate-600">{body}</p>}
    </div>
  );
}

/** Illustration: a Notion-style row on the left becomes live posts on the right. */
function HeroVisual() {
  return (
    <div className="relative" aria-hidden="true">
      <div className="absolute -inset-6 rounded-[2rem] bg-gradient-to-br from-indigo-100 via-white to-violet-100 blur-2xl" />
      <div className="relative space-y-4">
        <Window title="Content calendar · Notion">
          <div className="grid grid-cols-[1.6fr_1fr_1fr] gap-3 border-b border-slate-100 pb-2 text-[11px] font-semibold tracking-wide text-slate-400 uppercase">
            <span>Name</span>
            <span>Status</span>
            <span>Publish date</span>
          </div>
          <Row title="Launch week recap" status="Scheduled" tone="indigo" date="Thu 09:00" />
          <Row
            title="5 lessons from onboarding"
            status="Published"
            tone="emerald"
            date="Tue 08:30"
          />
          <Row title="Customer story: Acme" status="In review" tone="amber" date="Fri 12:00" />
        </Window>
        <div className="flex items-center justify-center gap-2 text-xs font-medium text-indigo-600">
          <span className="h-px w-10 bg-indigo-200" />
          Postelyo publishes on time
          <span className="h-px w-10 bg-indigo-200" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <PostCard
            network="LinkedIn"
            color="bg-[#0a66c2]"
            handle="Acme Corp"
            metric="1,284 impressions"
          />
          <PostCard network="X" color="bg-slate-900" handle="@acme" metric="312 likes" />
        </div>
      </div>
    </div>
  );
}

function Window({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl shadow-slate-900/5">
      <div className="flex items-center gap-2 border-b border-slate-100 bg-slate-50 px-4 py-2.5">
        <span className="h-2.5 w-2.5 rounded-full bg-slate-200" />
        <span className="h-2.5 w-2.5 rounded-full bg-slate-200" />
        <span className="h-2.5 w-2.5 rounded-full bg-slate-200" />
        <span className="ml-2 text-xs font-medium text-slate-500">{title}</span>
      </div>
      <div className="space-y-1 p-4">{children}</div>
    </div>
  );
}

function Row({
  title,
  status,
  tone,
  date,
}: {
  title: string;
  status: string;
  tone: 'indigo' | 'emerald' | 'amber';
  date: string;
}) {
  const tones = {
    indigo: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
    emerald: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  }[tone];
  return (
    <div className="grid grid-cols-[1.6fr_1fr_1fr] items-center gap-3 rounded-lg px-1 py-2 text-sm">
      <span className="truncate font-medium text-slate-800">{title}</span>
      <span>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${tones}`}>
          {status}
        </span>
      </span>
      <span className="text-slate-500">{date}</span>
    </div>
  );
}

function PostCard({
  network,
  color,
  handle,
  metric,
}: {
  network: string;
  color: string;
  handle: string;
  metric: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-lg shadow-slate-900/5">
      <div className="flex items-center gap-2.5">
        <span
          className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold text-white ${color}`}
        >
          {network === 'X' ? 'X' : 'in'}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold text-slate-900">{handle}</span>
          <span className="block text-xs text-slate-400">{network} · just now</span>
        </span>
      </div>
      <div className="mt-3 space-y-1.5">
        <span className="block h-2 w-full rounded bg-slate-100" />
        <span className="block h-2 w-11/12 rounded bg-slate-100" />
        <span className="block h-2 w-2/3 rounded bg-slate-100" />
      </div>
      <p className="mt-3 flex items-center gap-1.5 text-xs font-medium text-emerald-600">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        {metric}
      </p>
    </div>
  );
}
