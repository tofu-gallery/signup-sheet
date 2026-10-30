// Browsers, members, and who a write counts as in the activity record (see TOFU.md, Usage).
//
// The activity record counts only POSTs, from distinct browsers (__Host-ss_b), each as `organizer` when the request
// carries a valid organizer cookie (even on a member's route) and as `member` otherwise. Its row is written inside the
// write's own transaction, so a write that rolls back leaves none. GET requests never write one.
import { randomBytes } from 'node:crypto';
import { type Organizer } from './access';
import { MAX_AGE, readCookie, setCookie, type Scheme } from './cookies';
import type { Db } from './db';
import { isToken, newToken, tokenHash } from './tokens';

const BROWSER_ID = /^[A-Za-z0-9_-]{22}$/;
const ACTIVITY_KIND = /^[a-z_]{1,20}$/;

/** The browser's id: its __Host-ss_b cookie, or a new one (16 random bytes) with the Set-Cookie value that keeps it. */
export function browserFor(headers: Headers, scheme: Scheme): { id: string; setCookie: string | null } {
  const existing = readCookie(headers, 'ss_b', scheme);
  if (existing && BROWSER_ID.test(existing)) return { id: existing, setCookie: null };
  const id = randomBytes(16).toString('base64url');
  return { id, setCookie: setCookie('ss_b', id, MAX_AGE.browser, scheme) };
}

export type Actor = 'member' | 'organizer';

export function actorFor(organizer: Organizer | null): Actor {
  return organizer ? 'organizer' : 'member';
}

/** One activity row, inside the write's own transaction. */
export async function recordActivity(
  tx: Db,
  entry: { actor: Actor; kind: string; browser: string; sheetId: string | null }
): Promise<void> {
  if (!ACTIVITY_KIND.test(entry.kind) || !BROWSER_ID.test(entry.browser)) throw new Error('a malformed activity row');
  await tx.query('insert into activity (actor, kind, browser, sheet_id) values ($1, $2, $3, $4)', [
    entry.actor,
    entry.kind,
    entry.browser,
    entry.sheetId
  ]);
}

export type Member = { id: string; name: string };

/** The person a private-link token belongs to, or null. A malformed token is never looked up. */
export async function memberByToken(db: Db, token: string | null): Promise<Member | null> {
  if (!token || !isToken(token)) return null;
  const { rows } = await db.query<Member>('select id, name from people where token_hash = $1', [tokenHash(token)]);
  return rows[0] ?? null;
}

/** A member acting with their link (from __Host-ss_me): who they are, and the hash their link had when it was read. */
export type MemberAuth = { personId: string; tokenHash: Buffer };

export async function memberAuth(db: Db, token: string | null): Promise<MemberAuth | null> {
  const member = await memberByToken(db, token);
  return member && token ? { personId: member.id, tokenHash: tokenHash(token) } : null;
}

/**
 * Inside a member's write, once it holds its sheet and slot locks (locks.ts): whether their link still works, holding
 * the person's row FOR KEY SHARE until the commit. A new link (W8) needs FOR UPDATE on that row, because token_hash has
 * a unique index, so it either committed first (and this answers false) or waits until this write is done: a write is
 * never made with a link that was already replaced.
 */
export async function memberStillValid(tx: Db, auth: MemberAuth): Promise<boolean> {
  const { rows } = await tx.query('select 1 from people where id = $1 and token_hash = $2 for key share', [
    auth.personId,
    auth.tokenHash
  ]);
  return rows.length === 1;
}

/**
 * A new private link for one person (W8): 32 fresh random bytes, of which only the hash is stored. The old link, and
 * every cookie holding it, stops working at once. With `onlyIfHash` (a member replacing their own), it happens only
 * while their link is still the one they used, so a link already replaced cannot replace the new one. Returns the new
 * token (shown once, never stored), or null when nothing was replaced.
 */
export async function replaceLink(db: Db, personId: string, onlyIfHash: Buffer | null = null): Promise<string | null> {
  const token = newToken();
  const { rowCount } = await db.query(
    'update people set token_hash = $1, link_made_at = now() where id = $2 and ($3::bytea is null or token_hash = $3::bytea)',
    [tokenHash(token), personId, onlyIfHash]
  );
  return rowCount === 1 ? token : null;
}
