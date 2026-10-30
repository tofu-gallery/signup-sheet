// Cookie names, reading and writing (see TOFU.md, Members and their links).
//
// An app on another host of the same site (the same registrable domain) could set a cookie for the whole domain. Over
// https every name therefore carries the __Host- prefix (Secure, Path=/, no Domain), which only this host can set, and
// the same names without the prefix are ignored. Over plain http (local tests only) the names have no prefix and no
// Secure. The scheme comes from the request's validated origin (guard.ts).

export type Scheme = 'https' | 'http';

/** __Host-ss_org: the organizer. __Host-ss_me: a person's private-link token. __Host-ss_b: the browser's id. */
export type CookieBase = 'ss_org' | 'ss_me' | 'ss_b';

export const MAX_AGE = {
  member: 400 * 24 * 60 * 60,
  browser: 400 * 24 * 60 * 60
} as const;

const VALUE = /^[A-Za-z0-9._-]*$/;

export function cookieName(base: CookieBase, scheme: Scheme): string {
  return scheme === 'https' ? `__Host-${base}` : base;
}

/**
 * The value of this request's cookie, read only under its name for the scheme, or null. Every pair is read: an app on
 * another host of the same site can make browsers send many cookies ahead of this app's own, and the server already
 * bounds the header's size.
 */
export function readCookie(headers: Headers, base: CookieBase, scheme: Scheme): string | null {
  const header = headers.get('cookie');
  if (!header) return null;
  const wanted = cookieName(base, scheme);
  for (const pair of header.split(';')) {
    const equals = pair.indexOf('=');
    if (equals > 0 && pair.slice(0, equals).trim() === wanted) return pair.slice(equals + 1).trim();
  }
  return null;
}

/** A Set-Cookie value: HttpOnly, SameSite=Lax, Path=/, no Domain, and Secure over https. */
export function setCookie(base: CookieBase, value: string, maxAgeSeconds: number, scheme: Scheme): string {
  // Values are the app's own (base64url, digits and dots), so nothing needs encoding; anything else is a bug.
  if (!VALUE.test(value)) throw new Error('a cookie value outside base64url, digits and dots');
  const parts = [`${cookieName(base, scheme)}=${value}`, 'Path=/', `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`, 'HttpOnly', 'SameSite=Lax'];
  if (scheme === 'https') parts.push('Secure');
  return parts.join('; ');
}

export function clearCookie(base: CookieBase, scheme: Scheme): string {
  return setCookie(base, '', 0, scheme);
}
