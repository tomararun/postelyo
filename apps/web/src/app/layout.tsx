import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Postelyo',
  description: 'Plan in Notion, publish everywhere.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // Browser extensions (scroll lockers, translators, password managers) add attributes such as
    // style="overflow…" to <html>/<body> before React hydrates. suppressHydrationWarning ignores
    // attribute differences on these two elements only; mismatches inside the page still report.
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen antialiased" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
