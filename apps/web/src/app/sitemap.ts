import type { MetadataRoute } from 'next';

const siteUrl = process.env['APP_BASE_URL'] ?? 'http://localhost:3001';

export default function sitemap(): MetadataRoute.Sitemap {
  const page = (path: string, priority: number, changeFrequency: 'weekly' | 'monthly') => ({
    url: `${siteUrl}${path}`,
    lastModified: new Date(),
    changeFrequency,
    priority,
  });
  return [
    page('/', 1, 'weekly'),
    page('/pricing', 0.8, 'monthly'),
    page('/sign-up', 0.6, 'monthly'),
    page('/privacy', 0.2, 'monthly'),
    page('/terms', 0.2, 'monthly'),
  ];
}
