import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Icon, Logo } from '@/components/icons';
import { CtaLink } from '@/components/site';
import { api, getMe } from '@/lib/api';

export const metadata: Metadata = { title: 'Get set up', robots: { index: false } };

interface Source {
  status: string;
  disconnectedAt: string | null;
}
interface Account {
  disconnectedAt: string | null;
}

/** First-run onboarding: connect Notion, connect an account, schedule the first post. */
export default async function WelcomePage() {
  const me = await getMe();
  if (!me) redirect('/sign-in?next=%2Fwelcome');
  const ws = me.workspaces.find((w) => w.role === 'owner') ?? me.workspaces[0];
  if (!ws) redirect('/workspaces');

  const [sources, social, posts] = await Promise.all([
    api<{ sources: Source[] }>(`/v1/workspaces/${ws.id}/content-sources`).catch(() => ({
      sources: [] as Source[],
    })),
    api<{ accounts: Account[] }>(`/v1/workspaces/${ws.id}/social-accounts`).catch(() => ({
      accounts: [] as Account[],
    })),
    api<{ posts: unknown[] }>(`/v1/workspaces/${ws.id}/posts`).catch(() => ({
      posts: [] as unknown[],
    })),
  ]);
  const notionDone = sources.sources.some((s) => !s.disconnectedAt && s.status === 'active');
  const accountDone = social.accounts.some((a) => !a.disconnectedAt);
  const postDone = posts.posts.length > 0;
  const base = `/w/${ws.id}`;
  const steps = [
    {
      done: notionDone,
      title: 'Connect your Notion database',
      body: 'Authorize Postelyo, pick a page, and we create a ready-made content calendar or use the database you have.',
      href: `${base}/connections`,
      cta: 'Connect Notion',
    },
    {
      done: accountDone,
      title: 'Connect a social account',
      body: 'Link the LinkedIn profile or Page, X, Facebook Page or Instagram account you publish to.',
      href: `${base}/connections`,
      cta: 'Connect an account',
    },
    {
      done: postDone,
      title: 'Schedule your first post',
      body: 'In Notion, write a page, choose Platforms and a Publish Date, then set Status to Scheduled.',
      href: `${base}/posts`,
      cta: 'Open posts',
    },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  const nextStep = steps.find((s) => !s.done);
  const firstName = me.user.name?.split(' ')[0] || me.user.email.split('@')[0];

  return (
    <div className="min-h-screen bg-[var(--background)]">
      <header className="border-b border-[var(--border)] bg-white">
        <div className="mx-auto flex h-16 max-w-3xl items-center justify-between px-5">
          <Link href="/" className="flex items-center gap-2.5">
            <Logo />
            <span className="text-[17px] font-semibold tracking-tight">Postelyo</span>
          </Link>
          <Link
            href="/workspaces"
            className="text-sm font-medium text-slate-600 hover:text-slate-900"
          >
            Skip to dashboard
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-5 py-12">
        <p className="text-sm font-medium text-[var(--primary)]">{ws.name}</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight text-slate-900">
          Welcome, {firstName}
        </h1>
        <p className="mt-2 text-slate-600">
          Three steps and your Notion calendar starts publishing. You can leave and come back any
          time; this page remembers your progress.
        </p>

        <div className="mt-8 flex items-center gap-4">
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-200">
            <div
              className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-violet-500 transition-all"
              style={{ width: `${(doneCount / steps.length) * 100}%` }}
            />
          </div>
          <span className="text-sm font-medium text-slate-600 tabular-nums">
            {doneCount} of {steps.length} done
          </span>
        </div>

        <ol className="mt-8 space-y-4">
          {steps.map((s, i) => {
            const current = s === nextStep;
            return (
              <li
                key={s.title}
                className={`flex gap-4 rounded-2xl border bg-white p-5 sm:p-6 ${
                  current
                    ? 'border-indigo-200 shadow-lg ring-1 shadow-indigo-600/5 ring-indigo-100'
                    : 'border-[var(--border)] shadow-sm'
                }`}
              >
                <span
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${
                    s.done
                      ? 'bg-emerald-500 text-white'
                      : current
                        ? 'bg-[var(--primary)] text-white'
                        : 'bg-slate-100 text-slate-500'
                  }`}
                >
                  {s.done ? (
                    <svg
                      viewBox="0 0 20 20"
                      className="h-4 w-4"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2.4}
                      aria-hidden="true"
                    >
                      <path d="M5 10.5l3 3 7-7" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : (
                    i + 1
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <h2
                    className={`font-semibold ${s.done ? 'text-slate-500 line-through decoration-slate-300' : 'text-slate-900'}`}
                  >
                    {s.title}
                  </h2>
                  <p className="mt-1 text-sm leading-6 text-slate-600">{s.body}</p>
                  {!s.done && (
                    <div className="mt-4">
                      <CtaLink href={s.href} variant={current ? 'primary' : 'secondary'}>
                        {s.cta}
                        <Icon name="arrow" className="h-4 w-4" />
                      </CtaLink>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>

        <div className="mt-10 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-[var(--border)] bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-600">
            {doneCount === steps.length
              ? 'All set. Your posts publish on schedule and results flow back to Notion.'
              : 'Need the full picture first? The dashboard has every setting.'}
          </p>
          <CtaLink
            href={`${base}/posts`}
            variant={doneCount === steps.length ? 'primary' : 'secondary'}
          >
            Go to dashboard
          </CtaLink>
        </div>
      </main>
    </div>
  );
}
