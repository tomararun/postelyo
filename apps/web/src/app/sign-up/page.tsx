import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AuthLayout } from '@/components/auth-layout';
import { EmailForm } from '@/components/email-form';
import { Notice } from '@/components/ui';
import { getMe } from '@/lib/api';

export const metadata: Metadata = {
  title: 'Create your account',
  description: 'Start free: connect your Notion database and schedule your first post in minutes.',
  alternates: { canonical: '/sign-up' },
};

const STEPS = [
  'Enter your work email',
  'Open the link we send you',
  'Connect your Notion database',
];

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; error?: string }>;
}) {
  const { sent, error } = await searchParams;
  if (await getMe()) redirect('/welcome');
  return (
    <AuthLayout>
      <span className="inline-flex items-center gap-2 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200 ring-inset">
        Free plan · no card needed
      </span>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight text-slate-900">
        Create your Postelyo account
      </h1>
      <p className="mt-1.5 text-sm text-[var(--muted)]">
        No password to remember. We email you a secure link, and your workspace is ready when you
        open it.
      </p>
      <ol className="mt-6 space-y-2.5">
        {STEPS.map((s, i) => (
          <li key={s} className="flex items-center gap-3 text-sm text-slate-700">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-50 text-xs font-semibold text-[var(--primary)] ring-1 ring-indigo-100">
              {i + 1}
            </span>
            {s}
          </li>
        ))}
      </ol>
      <div className="mt-8 space-y-4">
        {sent && (
          <Notice kind="success">
            Almost there. Open the link we sent to <strong>{sent}</strong> within 15 minutes to
            finish creating your account.
          </Notice>
        )}
        {error && <Notice kind="error">{error}</Notice>}
        <EmailForm next="/welcome" from="sign-up" sent={sent} label="Create free account" />
        <p className="pt-2 text-center text-sm text-[var(--muted)]">
          Already have an account?{' '}
          <Link href="/sign-in" className="font-medium text-[var(--primary)] hover:underline">
            Sign in
          </Link>
        </p>
        <p className="text-center text-xs text-[var(--subtle)]">
          By creating an account you agree to the{' '}
          <Link href="/terms" className="underline">
            terms
          </Link>{' '}
          and{' '}
          <Link href="/privacy" className="underline">
            privacy policy
          </Link>
          .
        </p>
      </div>
    </AuthLayout>
  );
}
