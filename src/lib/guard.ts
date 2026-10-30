// The Origin guard every POST passes first, and the request's own origin (see TOFU.md, Requests).
//
// An app on another host of the same site (the same registrable domain) is same-site with this one: SameSite=Lax
// cookies ride along on its form posts. A POST is therefore accepted only when its Origin is exactly this copy's
// origin, or, when a browser sent no Origin, when Sec-Fetch-Site says same-origin. `Origin: null`, same-site,
// cross-site, none and no headers at all are refused. Referrer-Policy stays same-origin (next.config.ts), because
// no-referrer makes browsers send `Origin: null` on the app's own forms.
import { words } from '../words';
import type { Scheme } from './cookies';
import { audienceOf, failureResponse, PRIVATE, sentencePage } from './responses';

export type ExpectedOrigin = { scheme: Scheme; host: string; origin: string };

const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*|\[[0-9a-f:.]+\])(?::[0-9]{1,5})?$/;
const LOOPBACK = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/;

/** The first entry of a comma-separated header, trimmed. */
function first(value: string | null): string {
  return (value ?? '').split(',', 1)[0]?.trim() ?? '';
}

/**
 * This copy's origin, from the first X-Forwarded-Proto and X-Forwarded-Host entries (else https, or http for a
 * loopback host, and the Host header). Null when they are not a plain scheme and host. Absolute links (share texts,
 * calendar files, a new private link) are built from it, never from a setting.
 */
export function expectedOrigin(headers: Headers): ExpectedOrigin | null {
  const host = (first(headers.get('x-forwarded-host')) || first(headers.get('host'))).toLowerCase();
  if (host.length > 255 || !HOST.test(host)) return null;
  const proto = first(headers.get('x-forwarded-proto')).toLowerCase();
  if (proto && proto !== 'https' && proto !== 'http') return null;
  const scheme: Scheme = proto === 'http' || (!proto && LOOPBACK.test(host)) ? 'http' : 'https';
  try {
    const url = new URL(`${scheme}://${host}`);
    return { scheme, host: url.host, origin: url.origin };
  } catch {
    return null;
  }
}

function originOf(value: string): string | null {
  const text = value.trim();
  if (!/^https?:\/\/[^\s/?#]+$/i.test(text)) return null;
  try {
    const origin = new URL(text).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

export function originAllowed(headers: Headers): boolean {
  const expected = expectedOrigin(headers);
  if (!expected) return false;
  const origin = headers.get('origin');
  if (origin === null) return first(headers.get('sec-fetch-site')).toLowerCase() === 'same-origin';
  return originOf(origin) === expected.origin;
}

/**
 * Wraps every exported POST handler: `export const POST = guarded(async (request) => …)`. A refused request never
 * reaches the handler. Any error the handler throws becomes a plain answer here (logged without its details), so no
 * error object reaches Next.js's own log. Every answer is private and never cached.
 */
export function guarded<A extends unknown[]>(
  handler: (request: Request, ...rest: A) => Promise<Response>
): (request: Request, ...rest: A) => Promise<Response> {
  return async (request, ...rest) => {
    if (!originAllowed(request.headers)) return sentencePage(403, words.originRefused);
    let response: Response;
    try {
      response = await handler(request, ...rest);
    } catch (error) {
      return failureResponse('POST handler', error, audienceOf(request));
    }
    if (response.headers.has('cache-control')) return response;
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', PRIVATE['Cache-Control']);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  };
}

/** An absolute address on this copy, or null when the request's origin is not usable. */
export function absoluteUrl(headers: Headers, path: string): string | null {
  const expected = expectedOrigin(headers);
  return expected && localPath(path) === path ? `${expected.origin}${path}` : null;
}

/**
 * A redirect target a form sent (like /forget's `to`): a path on this copy, else '/'. It must start with exactly one
 * slash, then neither a slash nor a backslash, and hold only plain path and query characters: no percent-encoding,
 * spaces, control characters or backslashes, which some browsers turn into another host.
 */
export function localPath(to: string): string {
  return to.length <= 300 && /^\/(?![/\\])[A-Za-z0-9\-._~/?=&]*$/.test(to) ? to : '/';
}
