// What every POST route starts from (see TOFU.md, Requests). Each route is
// `export const POST = guarded(async (request, context) => …)`, so the Origin guard has passed before any of this runs.
// A member's write passes the throttles first; an organizer's write calls requireOrganizer() before any other query.
import type pg from 'pg';
import {
  type Organizer,
  organizerAccess,
  type OrganizerContext,
  organizerFromCookie,
  organizerRefusal,
  requireOrganizer
} from './access';
import { clearCookie, readCookie, type Scheme } from './cookies';
import { appPool } from './db';
import { expectedOrigin } from './guard';
import { actorFor, browserFor, type MemberAuth, memberAuth } from './identity';
import { logFailure } from './log';
import { readForm } from './request';
import { failureResponse, sentencePage, seeOther } from './responses';
import { readSettings, type Settings } from './settings';
import type { WriteContext } from './signups';
import { connectionKey, copyKey, LIMITS, overLimit, pruneSometimes } from './throttle';
import { idFrom, isSlug, type TextError } from './validation';
import { words } from '../words';

export type Post = {
  form: URLSearchParams;
  headers: Headers;
  pool: pg.Pool;
  settings: Settings;
  scheme: Scheme;
  /** Set-Cookie values every answer to this request carries (a browser id made now). */
  cookies: string[];
  organizer: Organizer | null;
  ctx: WriteContext;
};

/** The route's path parameters (Next.js passes them as a promise). */
export type Params<K extends string> = { params: Promise<Record<K, string>> };

function makePost(request: Request, form: URLSearchParams, pool: pg.Pool, settings: Settings, organizer: Organizer | null): Post {
  const scheme = expectedOrigin(request.headers)?.scheme ?? 'https';
  const browser = browserFor(request.headers, scheme);
  return {
    form,
    headers: request.headers,
    pool,
    settings,
    scheme,
    cookies: browser.setCookie ? [browser.setCookie] : [],
    organizer,
    ctx: { actor: actorFor(organizer), browser: browser.id }
  };
}

/**
 * A member's write (claim, cancel, move, profile, note, new link): the per-connection throttle (429) and the per-copy
 * one (the busy page). A request with a valid organizer cookie counts as the organizer in the activity record.
 */
export async function memberPost(request: Request): Promise<Post | Response> {
  const form = await readForm(request);
  const pool = appPool();
  const settings = readSettings();
  const scheme = expectedOrigin(request.headers)?.scheme ?? 'https';
  const organizer = organizerFromCookie(readCookie(request.headers, 'ss_org', scheme), await organizerAccess(pool, settings), settings);
  const post = makePost(request, form, pool, settings, organizer);
  if (await overLimit(pool, connectionKey('member', post.headers, settings), LIMITS.memberWritePerConnection)) {
    return sentencePage(429, words.throttle.memberWrite, {}, post.cookies);
  }
  if (await overLimit(pool, copyKey('member'), LIMITS.memberWritePerCopy)) return sentencePage(503, words.busy, {}, post.cookies);
  return post;
}

/** An organizer's write: refused with 403 unless the request is signed in as the organizer. */
export async function organizerPost(request: Request): Promise<Post | Response> {
  const form = await readForm(request);
  const pool = appPool();
  const settings = readSettings();
  const signedIn = await requireOrganizer(pool, request.headers, settings);
  if (!signedIn) return organizerRefusal('form');
  return makePost(request, form, pool, settings, signedIn.organizer);
}

/**
 * An organizer's GET (a page or a download): the organizer check is its first query. Anyone else is sent to /organizer
 * (303), which shows the setup, sign-in or locked page for the state.
 */
export async function organizerGet(request: Request): Promise<{ pool: pg.Pool; settings: Settings; signedIn: OrganizerContext } | Response> {
  const pool = appPool();
  const settings = readSettings();
  const signedIn = await requireOrganizer(pool, request.headers, settings);
  if (!signedIn) return seeOther('/organizer');
  return { pool, settings, signedIn };
}

/**
 * Wraps a GET handler, as guarded() wraps every POST: an error it throws becomes the plain failure answer (logged
 * without its details), so no error object reaches Next.js's own log. `where` is a fixed phrase for the log.
 */
export function answering<A extends unknown[]>(
  where: string,
  handler: (request: Request, ...rest: A) => Promise<Response>
): (request: Request, ...rest: A) => Promise<Response> {
  return async (request, ...rest) => {
    try {
      return await handler(request, ...rest);
    } catch (error) {
      return failureResponse(where, error);
    }
  };
}

/**
 * The answer to a private link that matches nobody (in a calendar file's address, say): the unknown-link 404, or 429
 * once this connection has tried too many of them.
 */
export async function linkMissed(request: Request, pool: pg.Pool): Promise<Response> {
  if (await overLimit(pool, connectionKey('link-miss', request.headers, readSettings()), LIMITS.linkMissPerConnection)) {
    return sentencePage(429, words.throttle.linkMiss);
  }
  return sentencePage(404, words.member.unknownLink);
}

/** The member this browser's __Host-ss_me link names, while it works. */
export function rememberedMember(post: Post): Promise<MemberAuth | null> {
  return memberAuth(post.pool, readCookie(post.headers, 'ss_me', post.scheme));
}

/** A member route without a working link: the unknown-link page, clearing a cookie that no longer works. */
export function unknownMember(post: Post): Response {
  const clear = readCookie(post.headers, 'ss_me', post.scheme) !== null ? [clearCookie('ss_me', post.scheme)] : [];
  return sentencePage(404, words.member.unknownLink, {}, [...post.cookies, ...clear]);
}

/**
 * A sign-up id that is not this member's (or no longer exists): the same 404 as an unknown link (G6), keeping the
 * member's cookie, which still works for their own.
 */
export function notYours(post: Post): Response {
  return sentencePage(404, words.member.unknownLink, {}, post.cookies);
}

/** Adds Set-Cookie values to an answer made elsewhere (a page shown again after a refusal). */
export function withCookies(response: Response, cookies: readonly string[]): Response {
  if (cookies.length === 0) return response;
  const headers = new Headers(response.headers);
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** 303 to a path on this copy with the request's cookies. */
export function done(post: Post, path: string, cookies: string[] = []): Response {
  return seeOther(path, [...post.cookies, ...cookies]);
}

/** After a write: about 1 in 50 also prunes old throttle and activity rows. A failure there never undoes the answer. */
export async function afterWrite(post: Post): Promise<void> {
  try {
    await pruneSometimes(post.pool);
  } catch (error) {
    logFailure('prune', error);
  }
}

/** A path's id or slug, or null when it is malformed (the route answers 404). */
export function pathId(value: string | undefined): string | null {
  return value === undefined ? null : idFrom(value);
}

export function pathSlug(value: string | undefined): string | null {
  return value !== undefined && isSlug(value) ? value : null;
}

/** A `?e=` code for a field's text error (validation.ts): `name-required`, `note-card` … */
export function textCode(field: string, error: TextError): string {
  return `${field}-${error}`;
}

/** The slug of the sheet a sign-up is on, for an organizer route's redirect (a sign-up never changes sheets). */
export async function signupSheetSlug(post: Post, signupId: string): Promise<string | null> {
  const { rows } = await post.pool.query<{ slug: string }>(
    'select h.slug from signups g join slots s on s.id = g.slot_id join sheets h on h.id = s.sheet_id where g.id = $1',
    [signupId]
  );
  return rows[0]?.slug ?? null;
}

export function notFound(post: Post | null = null): Response {
  return sentencePage(404, words.notFound, {}, post?.cookies ?? []);
}

// --- Pages (GET) ----------------------------------------------------------------------------------------------------

/** What a page's GET needs: the pool, the request's scheme and origin (for absolute links), its query, and now. */
export type PageContext = { pool: pg.Pool; headers: Headers; scheme: Scheme; origin: string; query: URLSearchParams; now: Date };

export function pageContext(request: Request): PageContext {
  const expected = expectedOrigin(request.headers);
  return {
    pool: appPool(),
    headers: request.headers,
    scheme: expected?.scheme ?? 'https',
    origin: expected?.origin ?? '',
    query: new URL(request.url).searchParams,
    now: new Date()
  };
}

/** A person's own page, from the link in their cookie. */
export type MemberPage = PageContext & { personId: string; token: string };

/**
 * A person's own page (GET): who the cookie's link names. Null without a cookie (the page says how to get in); the
 * unknown-link 404 for a cookie that no longer works, clearing it.
 */
export async function memberPage(request: Request): Promise<MemberPage | Response | null> {
  const context = pageContext(request);
  const token = readCookie(context.headers, 'ss_me', context.scheme);
  if (!token) return null;
  const member = await memberAuth(context.pool, token);
  if (!member) return sentencePage(404, words.member.unknownLink, {}, [clearCookie('ss_me', context.scheme)]);
  return { ...context, personId: member.personId, token };
}

/** The person this browser remembers on a public page (their own name and places only), or null. */
export async function rememberedOnPage(context: PageContext): Promise<MemberAuth | null> {
  return memberAuth(context.pool, readCookie(context.headers, 'ss_me', context.scheme));
}
