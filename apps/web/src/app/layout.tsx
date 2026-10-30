import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';

const inter = Inter({ subsets: ['latin'], display: 'swap', variable: '--font-inter' });

const siteUrl = process.env['APP_BASE_URL'] ?? 'http://localhost:3001';
const description =
  'Plan in Notion, publish everywhere. Postelyo schedules LinkedIn, X, Facebook and Instagram posts from your Notion database and writes the results back.';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: 'Postelyo', template: '%s · Postelyo' },
  description,
  applicationName: 'Postelyo',
  keywords: [
    'Notion social media scheduler',
    'Notion to LinkedIn',
    'schedule posts from Notion',
    'social media calendar',
    'content calendar',
  ],
  openGraph: {
    type: 'website',
    siteName: 'Postelyo',
    title: 'Postelyo · Plan in Notion, publish everywhere',
    description,
    url: '/',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Postelyo · Plan in Notion, publish everywhere',
    description,
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // Browser extensions (scroll lockers, translators, password managers) add attributes such as
    // style="overflow…" to <html>/<body> before React hydrates. suppressHydrationWarning ignores
    // attribute differences on these two elements only; mismatches inside the page still report.
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <body className="min-h-screen antialiased" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
