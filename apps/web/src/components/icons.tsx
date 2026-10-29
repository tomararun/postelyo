import type { ReactNode } from 'react';

/** Small outline icons (20px grid, 1.6 stroke) drawn inline; no icon dependency. */
function Svg({ children, className }: { children: ReactNode; className?: string | undefined }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className ?? 'h-[18px] w-[18px]'}
    >
      {children}
    </svg>
  );
}

export type IconName =
  | 'posts'
  | 'analytics'
  | 'ai'
  | 'connections'
  | 'team'
  | 'billing'
  | 'settings'
  | 'developers'
  | 'security'
  | 'home'
  | 'logout'
  | 'info'
  | 'check'
  | 'alert'
  | 'arrow';

export function Icon({ name, className }: { name: IconName; className?: string }) {
  switch (name) {
    case 'posts':
      return (
        <Svg className={className}>
          <rect x="3.5" y="3" width="13" height="14" rx="2" />
          <path d="M7 7h6M7 10h6M7 13h3.5" />
        </Svg>
      );
    case 'analytics':
      return (
        <Svg className={className}>
          <path d="M3.5 16.5h13" />
          <path d="M6 13.5V9.5M10 13.5V5.5M14 13.5v-6" />
        </Svg>
      );
    case 'ai':
      return (
        <Svg className={className}>
          <path d="M10 2.75l1.6 4.15 4.15 1.6-4.15 1.6L10 14.25 8.4 10.1 4.25 8.5 8.4 6.9z" />
          <path d="M15.5 13.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z" />
        </Svg>
      );
    case 'connections':
      return (
        <Svg className={className}>
          <path d="M8.5 11.5a3 3 0 0 0 4.24 0l2.5-2.5a3 3 0 0 0-4.24-4.24l-.75.75" />
          <path d="M11.5 8.5a3 3 0 0 0-4.24 0l-2.5 2.5a3 3 0 0 0 4.24 4.24l.75-.75" />
        </Svg>
      );
    case 'team':
      return (
        <Svg className={className}>
          <circle cx="7.5" cy="7" r="2.75" />
          <path d="M2.75 16c.5-2.6 2.4-4 4.75-4s4.25 1.4 4.75 4" />
          <path d="M13 4.75a2.5 2.5 0 0 1 0 4.5M14.5 12.25c1.4.5 2.4 1.7 2.75 3.75" />
        </Svg>
      );
    case 'billing':
      return (
        <Svg className={className}>
          <rect x="2.75" y="4.75" width="14.5" height="10.5" rx="2" />
          <path d="M2.75 8.25h14.5M6 12.25h2.5" />
        </Svg>
      );
    case 'settings':
      return (
        <Svg className={className}>
          <circle cx="10" cy="10" r="2.5" />
          <path d="M10 2.75v1.5M10 15.75v1.5M17.25 10h-1.5M4.25 10h-1.5M15.13 4.87l-1.06 1.06M5.93 14.07l-1.06 1.06M15.13 15.13l-1.06-1.06M5.93 5.93L4.87 4.87" />
        </Svg>
      );
    case 'developers':
      return (
        <Svg className={className}>
          <path d="M7 6.5L3.5 10 7 13.5M13 6.5l3.5 3.5-3.5 3.5M11 4.5l-2 11" />
        </Svg>
      );
    case 'security':
      return (
        <Svg className={className}>
          <path d="M10 2.75l5.75 2.25v4.5c0 3.6-2.4 6.3-5.75 7.75-3.35-1.45-5.75-4.15-5.75-7.75V5z" />
          <path d="M7.75 10l1.6 1.6 3-3.1" />
        </Svg>
      );
    case 'home':
      return (
        <Svg className={className}>
          <path d="M3.5 9L10 3.5 16.5 9v7.25a.75.75 0 0 1-.75.75H12.5v-4.5h-5V17H4.25a.75.75 0 0 1-.75-.75z" />
        </Svg>
      );
    case 'logout':
      return (
        <Svg className={className}>
          <path d="M12 6.5V4.75A1.75 1.75 0 0 0 10.25 3h-5.5A1.75 1.75 0 0 0 3 4.75v10.5C3 16.22 3.78 17 4.75 17h5.5A1.75 1.75 0 0 0 12 15.25V13.5" />
          <path d="M8.5 10H17M14.5 7.25L17.25 10l-2.75 2.75" />
        </Svg>
      );
    case 'info':
      return (
        <Svg className={className}>
          <circle cx="10" cy="10" r="7.25" />
          <path d="M10 9.25v4M10 6.5v.01" />
        </Svg>
      );
    case 'check':
      return (
        <Svg className={className}>
          <circle cx="10" cy="10" r="7.25" />
          <path d="M7 10.25l2 2 4-4.25" />
        </Svg>
      );
    case 'alert':
      return (
        <Svg className={className}>
          <path d="M10 3.25L17.5 16.25H2.5z" />
          <path d="M10 8.25v3.5M10 14v.01" />
        </Svg>
      );
    case 'arrow':
      return (
        <Svg className={className}>
          <path d="M4 10h12M11.5 5.5L16 10l-4.5 4.5" />
        </Svg>
      );
  }
}

/** Brand mark: a send arrow on an indigo-violet tile. */
export function Logo({ size = 32 }: { size?: number }) {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-[10px] bg-gradient-to-br from-indigo-500 via-indigo-600 to-violet-600 text-white shadow-[0_4px_12px_-4px_rgb(79_70_229/0.6)]"
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" style={{ width: size * 0.55 }}>
        <path
          d="M3.5 9.6l12.2-5.3c.6-.26 1.2.34.94.94L11.4 17.4c-.3.68-1.28.62-1.48-.1l-1.1-3.97a1 1 0 0 0-.7-.7L4.15 11.5c-.72-.2-.78-1.18-.1-1.48z"
          fill="currentColor"
        />
      </svg>
    </span>
  );
}
