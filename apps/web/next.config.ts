import type { NextConfig } from 'next';

/**
 * The browser talks only to this app. Auth, API, OAuth callbacks, webhooks
 * and media are proxied to the api process, so Better Auth's cookies belong to
 * this origin and no business logic lives here (architecture §2.4, Phase 3).
 */
const api = process.env['API_INTERNAL_URL'] ?? 'http://localhost:3000';

const config: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  async rewrites() {
    return [
      { source: '/api/auth/:path*', destination: `${api}/api/auth/:path*` },
      { source: '/v1/:path*', destination: `${api}/v1/:path*` },
      { source: '/oauth/:path*', destination: `${api}/oauth/:path*` },
      { source: '/webhooks/:path*', destination: `${api}/webhooks/:path*` },
      { source: '/media/:path*', destination: `${api}/media/:path*` },
      { source: '/metrics', destination: `${api}/metrics` },
      { source: '/health/:path*', destination: `${api}/health/:path*` },
    ];
  },
};

export default config;
