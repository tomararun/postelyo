import { redirect } from 'next/navigation';
import { requestMagicLink } from '@/app/actions';
import { AuthLayout } from '@/components/auth-layout';
import { Notice } from '@/components/ui';
import { getMe } from '@/lib/api';

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; error?: string; next?: string }>;
}) {
  const { sent, error, next } = await searchParams;
  if (await getMe()) redirect(next && next.startsWith('/') ? next : '/');
  return (
    <AuthLayout>
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Welcome back</h1>
      <p className="mt-1.5 text-sm text-[var(--muted)]">
        Sign in with your email. We&apos;ll send you a one-time link, no password needed.
      </p>
      <div className="mt-8 space-y-4">
        {sent && (
          <Notice kind="success">
            Check your inbox at <strong>{sent}</strong> for a sign-in link. It is valid for 15
            minutes.
          </Notice>
        )}
        {error && <Notice kind="error">{error}</Notice>}
        <form action={requestMagicLink} className="space-y-4">
          <label className="block text-sm">
            <span className="mb-1.5 block font-medium text-slate-700">Work email</span>
            <input
              name="email"
              type="email"
              required
              autoComplete="email"
              placeholder="you@company.com"
              defaultValue={sent ?? undefined}
              className="h-11 w-full rounded-lg border border-[var(--border)] bg-white px-3.5 text-sm shadow-sm transition-colors placeholder:text-slate-400 hover:border-[var(--border-strong)] focus:border-[var(--primary)] focus:ring-4 focus:ring-[var(--ring)] focus:outline-none"
            />
          </label>
          <input type="hidden" name="next" value={next ?? '/'} />
          <button
            type="submit"
            className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-[var(--primary)] text-sm font-semibold text-white shadow-md shadow-indigo-600/25 transition-all hover:bg-[var(--primary-hover)] active:translate-y-px"
          >
            {sent ? 'Send another link' : 'Continue with email'}
            <svg
              viewBox="0 0 20 20"
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path
                d="M4 10h12M11.5 5.5L16 10l-4.5 4.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </form>
        <p className="pt-2 text-center text-xs text-[var(--muted)]">
          New here? Signing in creates your workspace. Teams on single sign-on are sent to their
          identity provider automatically.
        </p>
      </div>
    </AuthLayout>
  );
}
