import Link from 'next/link';
import type { ReactNode } from 'react';
import { Logo } from '@/components/icons';

const FEATURES = [
  {
    title: 'Plan where you already write',
    body: 'Your Notion database stays the calendar. Set a page to Scheduled and Postelyo does the rest.',
  },
  {
    title: 'Publish everywhere, exactly once',
    body: 'LinkedIn, X, Facebook and Instagram, with retries that never post twice.',
  },
  {
    title: 'Results flow back to Notion',
    body: 'Links, metrics and weekly reports land next to the content that earned them.',
  },
];

/** Split screen for signed-out pages: brand story on the left, the form on the right. */
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      <aside className="relative hidden overflow-hidden bg-gradient-to-br from-indigo-950 via-indigo-900 to-violet-900 p-12 text-white lg:flex lg:flex-col">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-32 -right-24 h-96 w-96 rounded-full bg-violet-500/30 blur-3xl"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-40 -left-20 h-[28rem] w-[28rem] rounded-full bg-indigo-500/25 blur-3xl"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-[0.07] [background-image:radial-gradient(white_1px,transparent_1px)] [background-size:22px_22px]"
        />
        <Link href="/" className="relative flex items-center gap-2.5">
          <Logo size={36} />
          <span className="text-lg font-semibold tracking-tight">Postelyo</span>
        </Link>
        <div className="relative mt-auto max-w-md">
          <h2 className="text-4xl leading-tight font-semibold tracking-tight">
            Plan in Notion.
            <br />
            <span className="bg-gradient-to-r from-indigo-200 to-violet-200 bg-clip-text text-transparent">
              Publish everywhere.
            </span>
          </h2>
          <ul className="mt-10 space-y-6">
            {FEATURES.map((f) => (
              <li key={f.title} className="flex gap-3.5">
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/10 ring-1 ring-white/20">
                  <svg
                    viewBox="0 0 20 20"
                    className="h-3.5 w-3.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2.2}
                    aria-hidden="true"
                  >
                    <path d="M5 10.5l3 3 7-7" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                <span>
                  <span className="block font-medium">{f.title}</span>
                  <span className="mt-0.5 block text-sm leading-6 text-indigo-200/90">
                    {f.body}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <p className="relative mt-12 text-xs text-indigo-300/80">
          Credentials stay encrypted on our side. Nothing secret ever touches Notion.
        </p>
      </aside>
      <div className="flex flex-col justify-center px-6 py-12 sm:px-12">
        <div className="mx-auto w-full max-w-sm">
          <Link href="/" className="mb-10 flex items-center gap-2.5 lg:hidden">
            <Logo />
            <span className="text-lg font-semibold tracking-tight">Postelyo</span>
          </Link>
          {children}
        </div>
        <div className="mx-auto mt-12 flex w-full max-w-sm gap-4 text-xs text-[var(--subtle)]">
          <Link href="/privacy" className="hover:text-slate-600">
            Privacy
          </Link>
          <Link href="/terms" className="hover:text-slate-600">
            Terms
          </Link>
        </div>
      </div>
    </div>
  );
}
