import Link from 'next/link';
import type { ReactNode } from 'react';
import { Icon } from '@/components/icons';

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
    'inline-flex items-center justify-center gap-1.5 rounded-lg text-sm font-medium whitespace-nowrap transition-all disabled:pointer-events-none disabled:opacity-50';
  const styles = {
    primary:
      'h-9 px-3.5 bg-[var(--primary)] text-[var(--primary-foreground)] shadow-sm shadow-indigo-600/20 hover:bg-[var(--primary-hover)] active:translate-y-px',
    secondary:
      'h-9 px-3.5 border border-[var(--border)] bg-white text-slate-700 shadow-sm hover:border-[var(--border-strong)] hover:bg-slate-50 active:translate-y-px',
    danger:
      'h-9 px-3.5 border border-red-200 bg-white text-[var(--danger)] shadow-sm hover:border-red-300 hover:bg-red-50 active:translate-y-px',
    link: 'px-0 text-[var(--primary)] underline-offset-4 hover:underline',
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
  description,
  children,
  actions,
}: {
  title?: string;
  description?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-[var(--border)] bg-[var(--card)] shadow-[var(--shadow-card)]">
      {(title || actions) && (
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--border)] px-5 py-4 sm:px-6">
          <div>
            {title && (
              <h2 className="text-[15px] font-semibold tracking-tight text-slate-900">{title}</h2>
            )}
            {description && <p className="mt-0.5 text-sm text-[var(--muted)]">{description}</p>}
          </div>
          {actions}
        </div>
      )}
      <div className="space-y-4 p-5 sm:p-6">{children}</div>
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
    neutral: 'bg-slate-100 text-slate-700 ring-slate-200',
    success: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    warning: 'bg-amber-50 text-amber-800 ring-amber-200',
    danger: 'bg-red-50 text-red-700 ring-red-200',
  }[tone];
  const dot = {
    neutral: 'bg-slate-400',
    success: 'bg-emerald-500',
    warning: 'bg-amber-500',
    danger: 'bg-red-500',
  }[tone];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset ${tones}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden="true" />
      {children}
    </span>
  );
}

const fieldClass =
  'w-full rounded-lg border border-[var(--border)] bg-white px-3 py-2 text-sm text-slate-900 shadow-sm transition-colors placeholder:text-slate-400 hover:border-[var(--border-strong)] focus:border-[var(--primary)] focus:ring-4 focus:ring-[var(--ring)] focus:outline-none';

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
      <span className="mb-1.5 block font-medium text-slate-700">{label}</span>
      <input
        name={name}
        type={type}
        defaultValue={defaultValue ?? undefined}
        placeholder={placeholder}
        required={required}
        className={fieldClass}
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
      className={`${fieldClass} w-auto min-w-[8rem] pr-8`}
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
      <span className="mb-1.5 block font-medium text-slate-700">{label}</span>
      {select}
    </label>
  ) : (
    select
  );
}

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="-mx-5 overflow-x-auto sm:-mx-6">
      <table className="w-full text-sm [&_td]:px-5 [&_td]:py-3 [&_td]:align-middle sm:[&_td]:px-6 [&_tbody_tr]:transition-colors [&_tbody_tr:hover]:bg-slate-50/70">
        <thead>
          <tr className="border-y border-[var(--border)] bg-[var(--surface-muted)] text-left">
            {head.map((h, i) => (
              <th
                key={`${h}-${i}`}
                className="px-5 py-2.5 text-[11px] font-semibold tracking-wider whitespace-nowrap text-slate-500 uppercase sm:px-6"
              >
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
    info: 'border-indigo-100 bg-indigo-50/70 text-indigo-950 [&_svg]:text-indigo-500',
    error: 'border-red-200 bg-red-50 text-red-900 [&_svg]:text-red-500',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-900 [&_svg]:text-emerald-500',
  }[kind];
  const icon = kind === 'error' ? 'alert' : kind === 'success' ? 'check' : 'info';
  return (
    <div className={`flex gap-2.5 rounded-xl border px-3.5 py-3 text-sm leading-6 ${tones}`}>
      <span className="mt-[3px] shrink-0">
        <Icon name={icon} />
      </span>
      <div className="min-w-0">{children}</div>
    </div>
  );
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
