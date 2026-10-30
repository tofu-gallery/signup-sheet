import type { NextConfig } from 'next';

// No `output` (Tofu's nextjs preset runs `next start`), no next/image, and no X-Powered-By. Every page and route is
// dynamic (each exports `dynamic = 'force-dynamic'`), so nothing read from the database is frozen at build time.

// The script and style allowances follow from having no middleware (Next.js nonces need one): user text only ever
// reaches a page through src/lib/html.ts, which escapes every value, and that is the XSS defence. `next dev` alone also
// needs eval for its reloading.
const scriptSources = process.env.NODE_ENV === 'development' ? "'self' 'unsafe-inline' 'unsafe-eval'" : "'self' 'unsafe-inline'";

const everyResponse = [
  {
    key: 'Content-Security-Policy',
    value: `default-src 'self'; script-src ${scriptSources}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'`
  },
  { key: 'X-Frame-Options', value: 'DENY' },
  // Never no-referrer: browsers then send `Origin: null` on the app's own forms, which the Origin guard refuses.
  { key: 'Referrer-Policy', value: 'same-origin' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Robots-Tag', value: 'noindex, nofollow' }
];

const privatePages = [{ key: 'Cache-Control', value: 'private, no-store' }];

const config: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      { source: '/:path*', headers: everyResponse },
      // The bare paths too: '/me/:path*' alone does not cover '/me'.
      { source: '/me', headers: privatePages },
      { source: '/me/:path*', headers: privatePages },
      { source: '/organizer', headers: privatePages },
      { source: '/organizer/:path*', headers: privatePages }
    ];
  }
};

export default config;
