// Who may open the organizer pages (see TOFU.md, Organizer access).
//
// The state lives in the one app_state row. Until ORGANIZER_PASSWORD is saved, the first browser that posts Set up
// within 24 hours of the database's creation holds a setup seat for at most 7 days. Any non-blank ORGANIZER_PASSWORD
// retires the seat for good, even one too short to sign in with (that state is locked-short), so a seat left beside a
// saved password can never be a stranger's way in. The database's clock decides every time limit.
//
// GET requests never take the seat. Retiring it is a write a GET can cause, because it depends only on the saved
// setting, never on anything a request sends. (The only other one: a link that matches nobody counts against its
// throttle, at /me/<token> and in calendar files' addresses.)
import { createHmac, randomBytes } from 'node:crypto';
import { words } from '../words';
import { readCookie } from './cookies';
import type { Db } from './db';
import { expectedOrigin } from './guard';
import { sentencePage } from './responses';
import type { Settings } from './settings';
import { organizerKey, sameBytes, sha256 } from './tokens';

export type OrganizerState =
  | 'setup-open'
  | 'held'
  | 'password'
  | 'locked-short'
  | 'locked-removed'
  | 'locked-expired'
  | 'locked-unclaimed';

export type OrganizerAccess = {
  state: OrganizerState;
  /** While the state is held: the seat's hash and when it ends. */
  seat: { hash: Buffer; until: Date } | null;
};

/** Who is signed in as the organizer, and how. */
export type Organizer = { via: 'seat' | 'password' };

export const PASSWORD_MIN_LENGTH = 12;
export const SEAT_SECONDS = 7 * 24 * 60 * 60;
export const PASSWORD_COOKIE_SECONDS = 90 * 24 * 60 * 60;
/** A wrong password is answered after this long. */
export const WRONG_PASSWORD_DELAY_MS = 1_000;
// How far in the future a password cookie's issue time may be (clocks of two app processes).
const CLOCK_SKEW_SECONDS = 5 * 60;

/** The organizer state, computed for each request that needs it. Run it on its own, never inside a write's transaction. */
export async function organizerAccess(db: Db, settings: Settings): Promise<OrganizerAccess> {
  if (settings.organizerPassword) {
    await db.query(
      "update app_state set seat_state = 'retired', seat_hash = null, retired_at = now() where id = 1 and seat_state <> 'retired'"
    );
    const long = [...settings.organizerPassword].length >= PASSWORD_MIN_LENGTH;
    return { state: long ? 'password' : 'locked-short', seat: null };
  }

  const { rows } = await db.query<{ seat_state: string; seat_hash: Buffer | null; seat_until: Date | null; seat_live: boolean; setup_window: boolean }>(
    `select seat_state, seat_hash, seat_until, coalesce(now() < seat_until, false) as seat_live,
            now() < created_at + interval '24 hours' as setup_window
       from app_state where id = 1`
  );
  const row = rows[0];
  if (!row) throw new Error('app_state has no row');
  if (row.seat_state === 'retired') return { state: 'locked-removed', seat: null };
  if (row.seat_state === 'held') {
    return row.seat_live && row.seat_hash && row.seat_until
      ? { state: 'held', seat: { hash: row.seat_hash, until: row.seat_until } }
      : { state: 'locked-expired', seat: null };
  }
  return { state: row.setup_window ? 'setup-open' : 'locked-unclaimed', seat: null };
}

export type SeatTaken = { cookieValue: string; maxAgeSeconds: number; until: Date };

/**
 * POST /organizer/setup: takes the seat in one statement, only while it is open and within the database's first 24
 * hours. Null when another browser took it first, the window has passed, or a password is saved.
 */
export async function takeSeat(db: Db, settings: Settings): Promise<SeatTaken | null> {
  if (settings.organizerPassword) return null;
  const secret = randomBytes(32);
  const { rows } = await db.query<{ seat_until: Date }>(
    `update app_state
        set seat_state = 'held', seat_hash = $1, seat_taken_at = now(), seat_until = now() + make_interval(secs => $2)
      where id = 1 and seat_state = 'open' and now() < created_at + interval '24 hours'
      returning seat_until`,
    [sha256(secret), SEAT_SECONDS]
  );
  const row = rows[0];
  if (!row) return null;
  return { cookieValue: `seat.${secret.toString('base64url')}`, maxAgeSeconds: SEAT_SECONDS, until: row.seat_until };
}

/** "Give up setup": the seat holder ends the seat at once; the state becomes locked-expired. */
export async function giveUpSeat(db: Db, cookieValue: string | null): Promise<boolean> {
  const secret = seatSecret(cookieValue);
  if (!secret) return false;
  const { rowCount } = await db.query(
    "update app_state set seat_until = now() where id = 1 and seat_state = 'held' and seat_hash = $1 and now() < seat_until",
    [sha256(secret)]
  );
  return rowCount === 1;
}

/**
 * Whether the request's __Host-ss_org value signs it in: a seat cookie matching the held seat, or a password cookie
 * while a password is saved. Nothing else: in every other state no cookie works.
 */
export function organizerFromCookie(
  cookieValue: string | null,
  access: OrganizerAccess,
  settings: Settings,
  now: Date = new Date()
): Organizer | null {
  if (!cookieValue) return null;
  if (access.state === 'held' && access.seat) {
    const secret = seatSecret(cookieValue);
    return secret && sameBytes(sha256(secret), access.seat.hash) ? { via: 'seat' } : null;
  }
  if (access.state === 'password' && passwordCookieValid(cookieValue, settings, now)) return { via: 'password' };
  return null;
}

/** The typed password, trimmed, against the saved one. False whenever the saved one cannot be used to sign in. */
export function passwordMatches(typed: string, settings: Settings): boolean {
  if ([...settings.organizerPassword].length < PASSWORD_MIN_LENGTH) return false;
  return sameBytes(sha256(typed.trim()), sha256(settings.organizerPassword));
}

/** The cookie a right password earns: `pw.<issued unix seconds>.<HMAC>`, for 90 days. */
export function passwordCookie(settings: Settings, now: Date = new Date()): { cookieValue: string; maxAgeSeconds: number } {
  const issued = Math.floor(now.getTime() / 1000);
  return { cookieValue: `pw.${issued}.${passwordMac(settings, issued)}`, maxAgeSeconds: PASSWORD_COOKIE_SECONDS };
}

export type OrganizerContext = { access: OrganizerAccess; organizer: Organizer };

/**
 * The organizer check. Every organizer page and route except /organizer, its setup and its sign-in calls it before its
 * first other query, and refuses when it answers null: a route with `organizerRefusal`, a page by sending the browser
 * to /organizer.
 */
export async function requireOrganizer(
  db: Db,
  headers: Headers,
  settings: Settings,
  now: Date = new Date()
): Promise<OrganizerContext | null> {
  const access = await organizerAccess(db, settings);
  const scheme = expectedOrigin(headers)?.scheme ?? 'https';
  const organizer = organizerFromCookie(readCookie(headers, 'ss_org', scheme), access, settings, now);
  return organizer ? { access, organizer } : null;
}

/** A route's answer to a request that is not the organizer's: 403 for a form post, 401 JSON for the import. */
export function organizerRefusal(kind: 'form' | 'json'): Response {
  if (kind === 'form') return sentencePage(403, words.signInFirst);
  return Response.json({ error: words.signInFirst }, { status: 401, headers: { 'Cache-Control': 'private, no-store' } });
}

/** Whether a sign-in form can work in this state: only when a long enough password is saved. */
export function signInFormShown(state: OrganizerState): boolean {
  return state === 'password';
}

/** Why a Set up press cannot take the seat in this state (the answer to a setup POST that lost or came too late). */
export function setupRefusal(state: OrganizerState): string {
  switch (state) {
    case 'setup-open':
    case 'held':
      return words.organizer.setupLost;
    case 'password':
      return words.organizer.setupClosed;
    case 'locked-short':
      return words.organizer.lockedShort;
    case 'locked-removed':
      return words.organizer.lockedRemoved;
    case 'locked-expired':
      return words.organizer.lockedExpired;
    case 'locked-unclaimed':
      return words.organizer.lockedUnclaimed;
  }
}

function passwordMac(settings: Settings, issued: number): string {
  return createHmac('sha256', organizerKey(settings)).update(`org\0${issued}`).digest('base64url');
}

const PASSWORD_COOKIE = /^pw\.([0-9]{1,12})\.([A-Za-z0-9_-]{43})$/;

function passwordCookieValid(cookieValue: string, settings: Settings, now: Date): boolean {
  const match = PASSWORD_COOKIE.exec(cookieValue);
  if (!match?.[1] || !match[2]) return false;
  const issued = Number(match[1]);
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (issued > nowSeconds + CLOCK_SKEW_SECONDS || nowSeconds - issued > PASSWORD_COOKIE_SECONDS) return false;
  return sameBytes(Buffer.from(match[2]), Buffer.from(passwordMac(settings, issued)));
}

const SEAT_COOKIE = /^seat\.([A-Za-z0-9_-]{43})$/;

function seatSecret(cookieValue: string | null): Buffer | null {
  const match = cookieValue ? SEAT_COOKIE.exec(cookieValue) : null;
  return match?.[1] ? Buffer.from(match[1], 'base64url') : null;
}
