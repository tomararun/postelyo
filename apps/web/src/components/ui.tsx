import Link from 'next/link';
import type { ReactNode } from 'react';

/** Small shadcn-style primitives, hand-written to keep the dependency surface minimal. */

export function Button({
  children,
  variant = 'primary',
  type = 'submit',
  name,
  value,
  href,
}: {
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'danger' | 'link';
  type?: 'submit' | 'button';
  name?: string;
  value?: string;
  href?: string;
}) {
  const base =
    'inline-flex items-center justify-center rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50';
  const styles = {
    primary: 'bg-[var(--primary)] text-[var(--primary-foreground)] hover:opacity-90',
    secondary: 'border border-[var(--border)] bg-white hover:bg-gray-50',
    danger: 'border border-red-200 bg-white text-[var(--danger)] hover:bg-red-50',
    link: 'text-[var(--primary)] underline-offset-4 hover:underline px-0',
  }[variant];
  if (href) {
    return (
      <Link href={href} className={`${base} ${styles}`}>
        {children}
      </Link>
    );
  }
  return (
    <button type={type} name={name} value={value} className={`${base} ${styles}`}>
      {children}
    </button>
  );
}

export function Card({
  title,
  children,
  actions,
}: {
  title?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-5 shadow-sm">
      {(title || actions) && (
        <div className="mb-4 flex items-center justify-between gap-4">
          {title && <h2 className="text-base font-semibold">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'success' | 'warning' | 'danger';
}) {
  const tones = {
    neutral: 'bg-gray-100 text-gray-800',
    success: 'bg-green-100 text-green-800',
    warning: 'bg-amber-100 text-amber-800',
    danger: 'bg-red-100 text-red-800',
  }[tone];
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${tones}`}>
      {children}
    </span>
  );
}

export function Input({
  name,
  label,
  type = 'text',
  defaultValue,
  placeholder,
  required,
}: {
  name: string;
  label: string;
  type?: string;
  defaultValue?: string | number | null;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium">{label}</span>
      <input
        name={name}
        type={type}
        defaultValue={defaultValue ?? undefined}
        placeholder={placeholder}
        required={required}
        className="w-full rounded-md border border-[var(--border)] bg-white px-3 py-1.5 text-sm outline-none focus:border-gray-400"
      />
    </label>
  );
}

export function Select({
  name,
  label,
  options,
  defaultValue,
}: {
  name: string;
  label?: string;
  options: { value: string; label: string }[];
  defaultValue?: string;
}) {
  const select = (
    <select
      name={name}
      defaultValue={defaultValue}
      className="rounded-md border border-[var(--border)] bg-white px-2 py-1.5 text-sm"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
  return label ? (
    <label className="block text-sm">
      <span className="mb-1 block font-medium">{label}</span>
      {select}
    </label>
  ) : (
    select
  );
}

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--border)] text-left text-xs uppercase text-[var(--muted)]">
            {head.map((h) => (
              <th key={h} className="py-2 pr-4 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--border)]">{children}</tbody>
      </table>
    </div>
  );
}

export function Notice({
  kind = 'info',
  children,
}: {
  kind?: 'info' | 'error' | 'success';
  children: ReactNode;
}) {
  const tones = {
    info: 'border-blue-200 bg-blue-50 text-blue-900',
    error: 'border-red-200 bg-red-50 text-red-900',
    success: 'border-green-200 bg-green-50 text-green-900',
  }[kind];
  return <p className={`rounded-md border px-3 py-2 text-sm ${tones}`}>{children}</p>;
}

/** Reads `?notice=` / `?error=` query params the way the server-rendered pages do. */
export function QueryNotices({
  notice,
  error,
}: {
  notice?: string | undefined;
  error?: string | undefined;
}) {
  return (
    <>
      {notice && <Notice kind="success">{notice}</Notice>}
      {error && <Notice kind="error">{error}</Notice>}
    </>
  );
}
