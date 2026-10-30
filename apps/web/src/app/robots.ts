import type { MetadataRoute } from 'next';

const siteUrl = process.env['APP_BASE_URL'] ?? 'http://localhost:3001';

/** Public pages are crawlable; the dashboard, onboarding and api proxies are not. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: ['/', '/pricing', '/sign-up', '/privacy', '/terms'],
      disallow: [
        '/w/',
        '/workspaces',
        '/welcome',
        '/sign-in',
        '/invitations/',
        '/api/',
        '/v1/',
        '/oauth/',
        '/webhooks/',
        '/media/',
        '/l/',
        '/metrics',
        '/health/',
      ],
    },
    sitemap: `${siteUrl}/sitemap.xml`,
  };
}
