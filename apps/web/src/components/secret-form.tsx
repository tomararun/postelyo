'use client';

import { useActionState, type ReactNode } from 'react';
import type { SecretResult } from '@/app/actions';

/**
 * A form whose server action returns a secret that must be shown once and
 * never travel through a URL (security.md §7). The secret stays in the
 * component state of this page load; reloading clears it.
 */
export function SecretForm({
  action,
  submitLabel,
  children,
}: {
  action: (prev: SecretResult, formData: FormData) => Promise<SecretResult>;
  submitLabel: string;
  children: ReactNode;
}) {
  const [state, formAction, pending] = useActionState(action, {} as SecretResult);
  return (
    <form action={formAction} className="space-y-3">
      {state.error && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
          {state.error}
        </p>
      )}
      {state.secret && (
        <div className="space-y-1 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-900">
          <p className="font-medium">
            {state.label ?? 'Secret'}: copy it now, it is not shown again.
          </p>
          <code className="block break-all rounded bg-white px-2 py-1 font-mono text-xs text-gray-900">
            {state.secret}
          </code>
        </div>
      )}
      {children}
      <button
        type="submit"
        disabled={pending}
        className="inline-flex items-center justify-center rounded-md bg-[var(--primary)] px-3 py-1.5 text-sm font-medium text-[var(--primary-foreground)] transition-colors hover:opacity-90 disabled:opacity-50"
      >
        {pending ? 'Working…' : submitLabel}
      </button>
    </form>
  );
}
