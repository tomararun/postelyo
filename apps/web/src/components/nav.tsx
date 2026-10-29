'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon, type IconName } from '@/components/icons';

export interface NavItem {
  label: string;
  href: string;
  icon: IconName;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

const isActive = (pathname: string, href: string) =>
  href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(href + '/');

/** Sidebar navigation (desktop) with the current section highlighted. */
export function SideNav({ groups }: { groups: NavGroup[] }) {
  const pathname = usePathname();
  return (
    <nav className="space-y-6">
      {groups.map((g) => (
        <div key={g.label}>
          <p className="mb-1.5 px-3 text-[11px] font-semibold tracking-wider text-[var(--subtle)] uppercase">
            {g.label}
          </p>
          <ul className="space-y-0.5">
            {g.items.map((item) => {
              const active = isActive(pathname, item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={`group flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                      active
                        ? 'bg-[var(--primary-soft)] text-[var(--primary)]'
                        : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                    }`}
                  >
                    <span
                      className={
                        active
                          ? 'text-[var(--primary)]'
                          : 'text-slate-400 group-hover:text-slate-600'
                      }
                    >
                      <Icon name={item.icon} />
                    </span>
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** Horizontal, scrollable navigation for small screens. */
export function MobileNav({ groups }: { groups: NavGroup[] }) {
  const pathname = usePathname();
  const items = groups.flatMap((g) => g.items);
  return (
    <nav className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">
      {items.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={`flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium ${
              active
                ? 'bg-[var(--primary-soft)] text-[var(--primary)]'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <Icon name={item.icon} className="h-4 w-4" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Page heading taken from the active navigation entry. */
export function PageTitle({ groups, fallback }: { groups: NavGroup[]; fallback: string }) {
  const pathname = usePathname();
  const items = groups.flatMap((g) => g.items);
  const match = items
    .filter((i) => isActive(pathname, i.href))
    .sort((a, b) => b.href.length - a.href.length)[0];
  const sub = pathname.includes('/publications/') ? 'Publication' : null;
  return (
    <h1 className="text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl">
      {sub ?? match?.label ?? fallback}
    </h1>
  );
}
