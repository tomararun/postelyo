import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AuthLayout } from '@/components/auth-layout';
import { EmailForm } from '@/components/email-form';
import { Notice } from '@/components/ui';
import { getMe } from '@/lib/api';

export const metadata: Metadata = { title: 'Sign in', robots: { index: false } };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; error?: string; next?: string }>;
}) {
  const { sent, error, next } = await searchParams;
  const target = next && next.startsWith('/') && !next.startsWith('//') ? next : '/workspaces';
  if (await getMe()) redirect(target);
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
        <EmailForm next={target} from="sign-in" sent={sent} label="Continue with email" />
        <p className="pt-2 text-center text-sm text-[var(--muted)]">
          New to Postelyo?{' '}
          <Link href="/sign-up" className="font-medium text-[var(--primary)] hover:underline">
            Create a free account
          </Link>
        </p>
        <p className="text-center text-xs text-[var(--subtle)]">
          Teams on single sign-on are sent to their identity provider automatically.
        </p>
      </div>
    </AuthLayout>
  );
}
