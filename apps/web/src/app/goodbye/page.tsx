import type { Metadata } from 'next';
import Link from 'next/link';
import { AuthLayout } from '@/components/auth-layout';

export const metadata: Metadata = { title: 'Account deleted', robots: { index: false } };

/** Shown after self-service account deletion (D64). */
export default function GoodbyePage() {
  return (
    <AuthLayout>
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
        Your account has been deleted
      </h1>
      <p className="mt-3 text-sm leading-6 text-slate-600">
        You are signed out everywhere. Workspaces you were the only member of are being purged, and
        social accounts you connected in shared workspaces were disconnected. A confirmation email
        is on its way.
      </p>
      <p className="mt-3 text-sm leading-6 text-slate-600">
        Your Notion pages are untouched. You can come back any time with a new account.
      </p>
      <div className="mt-8 flex gap-3">
        <Link
          href="/"
          className="inline-flex h-10 items-center rounded-lg border border-slate-200 bg-white px-4 text-sm font-medium text-slate-800 shadow-sm hover:bg-slate-50"
        >
          Back to the homepage
        </Link>
      </div>
    </AuthLayout>
  );
}
