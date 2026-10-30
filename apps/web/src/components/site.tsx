import Link from 'next/link';
import type { ReactNode } from 'react';
import { Logo } from '@/components/icons';

/** Header for the public pages; the right side adapts to the visitor's session. */
export function SiteHeader({ signedIn }: { signedIn: boolean }) {
  return (
    <header className="sticky top-0 z-30 border-b border-slate-200/70 bg-white/80 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-6 px-5">
        <Link href="/" className="flex items-center gap-2.5">
          <Logo />
          <span className="text-[17px] font-semibold tracking-tight text-slate-900">Postelyo</span>
        </Link>
        <nav className="hidden items-center gap-7 text-sm font-medium text-slate-600 md:flex">
          <Link href="/#features" className="hover:text-slate-900">
            Features
          </Link>
          <Link href="/#how-it-works" className="hover:text-slate-900">
            How it works
          </Link>
          <Link href="/pricing" className="hover:text-slate-900">
            Pricing
          </Link>
          <Link href="/#faq" className="hover:text-slate-900">
            FAQ
          </Link>
        </nav>
        <div className="flex items-center gap-2">
          {signedIn ? (
            <CtaLink href="/workspaces">Open dashboard</CtaLink>
          ) : (
            <>
              <Link
                href="/sign-in"
                className="inline-flex rounded-lg px-2 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 sm:px-3"
              >
                Sign in
              </Link>
              <CtaLink href="/sign-up">Get started free</CtaLink>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

export function CtaLink({
  href,
  children,
  size = 'md',
  variant = 'primary',
}: {
  href: string;
  children: ReactNode;
  size?: 'md' | 'lg';
  variant?: 'primary' | 'secondary' | 'light';
}) {
  const sizes = { md: 'h-9 px-4 text-sm', lg: 'h-12 px-6 text-[15px]' }[size];
  const variants = {
    primary:
      'bg-[var(--primary)] text-white shadow-md shadow-indigo-600/25 hover:bg-[var(--primary-hover)]',
    secondary:
      'border border-slate-200 bg-white text-slate-800 shadow-sm hover:border-slate-300 hover:bg-slate-50',
    light: 'bg-white text-indigo-700 shadow-lg shadow-indigo-950/20 hover:bg-indigo-50',
  }[variant];
  return (
    <Link
      href={href}
      className={`inline-flex items-center justify-center gap-2 rounded-lg font-semibold whitespace-nowrap transition-all active:translate-y-px ${sizes} ${variants}`}
    >
      {children}
    </Link>
  );
}

export function SiteFooter() {
  const year = new Date().getUTCFullYear();
  return (
    <footer className="border-t border-slate-200 bg-white">
      <div className="mx-auto grid max-w-6xl gap-10 px-5 py-14 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
        <div>
          <Link href="/" className="flex items-center gap-2.5">
            <Logo />
            <span className="text-[17px] font-semibold tracking-tight">Postelyo</span>
          </Link>
          <p className="mt-4 max-w-xs text-sm leading-6 text-slate-500">
            Plan your social content in Notion. Postelyo publishes it on time, everywhere, and
            brings the results back.
          </p>
        </div>
        <FooterCol
          title="Product"
          links={[
            ['Features', '/#features'],
            ['How it works', '/#how-it-works'],
            ['Pricing', '/pricing'],
            ['FAQ', '/#faq'],
          ]}
        />
        <FooterCol
          title="Account"
          links={[
            ['Get started', '/sign-up'],
            ['Sign in', '/sign-in'],
            ['Dashboard', '/workspaces'],
          ]}
        />
        <FooterCol
          title="Legal"
          links={[
            ['Privacy', '/privacy'],
            ['Terms', '/terms'],
          ]}
        />
      </div>
      <div className="border-t border-slate-100">
        <p className="mx-auto max-w-6xl px-5 py-6 text-xs text-slate-400">
          © {year} Postelyo. Notion, LinkedIn, X, Facebook and Instagram are trademarks of their
          respective owners.
        </p>
      </div>
    </footer>
  );
}

function FooterCol({ title, links }: { title: string; links: [string, string][] }) {
  return (
    <div>
      <p className="text-sm font-semibold text-slate-900">{title}</p>
      <ul className="mt-4 space-y-2.5 text-sm text-slate-500">
        {links.map(([label, href]) => (
          <li key={href}>
            <Link href={href} className="hover:text-slate-900">
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Small uppercase label above a section heading. */
export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="text-sm font-semibold tracking-wide text-[var(--primary)] uppercase">
      {children}
    </p>
  );
}
