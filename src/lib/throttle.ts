// Rate limits, kept in the throttle table because several app processes run at once (see TOFU.md, Requests). Every
// limit is here. A connection is known only by a keyed hash of its address. The per-copy limits do not depend on any
// address header, so a forged or shared address cannot get around them.
//
// A window is fixed: it starts with the first hit after the previous window ended. Counting is one upsert per key, on
// its own outside any business transaction, so it holds no lock a write needs.
import { createHmac } from 'node:crypto';
import type { Db } from './db';
import type { Settings } from './settings';
import { addressKey } from './tokens';

export type Limit = { hits: number; seconds: number };

const MINUTE = 60;
const HOUR = 60 * MINUTE;

export const LIMITS = {
  /** Organizer sign-in failures (an attempt counts until it turns out right; see `refund`). */
  signInPerConnection: { hits: 5, seconds: 15 * MINUTE },
  signInPerCopy: { hits: 50, seconds: HOUR },
  setupPerConnection: { hits: 5, seconds: HOUR },
  /** Member writes: claim, cancel, move, profile, note, new link. Over the per-copy limit: the busy page. */
  memberWritePerConnection: { hits: 30, seconds: 10 * MINUTE },
  memberWritePerCopy: { hits: 2_000, seconds: HOUR },
  /** Private links that match nobody. */
  linkMissPerConnection: { hits: 30, seconds: 10 * MINUTE },
  /** Imports, counted only once the organizer is known, so a stranger cannot use up the organizer's. */
  importPerCopy: { hits: 30, seconds: HOUR }
} as const satisfies Record<string, Limit>;

/** The client's address: x-vercel-forwarded-for, x-real-ip, the first x-forwarded-for entry, else 'unknown'. */
export function clientAddress(headers: Headers): string {
  for (const name of ['x-vercel-forwarded-for', 'x-real-ip', 'x-forwarded-for']) {
    const value = (headers.get(name) ?? '').split(',', 1)[0]?.trim();
    if (value) return value.slice(0, 100);
  }
  return 'unknown';
}

/** A throttle key for one connection: `<kind>:<32 hex characters of HMAC-SHA256(address)>`. */
export function connectionKey(kind: string, headers: Headers, settings: Settings): string {
  const hash = createHmac('sha256', addressKey(settings)).update(clientAddress(headers)).digest('hex').slice(0, 32);
  return `${kind}:${hash}`;
}

/** A throttle key for the whole copy. */
export function copyKey(kind: string): string {
  return `copy:${kind}`;
}

/** Counts one hit on `key` and answers whether it went over `limit`. */
export async function overLimit(db: Db, key: string, limit: Limit): Promise<boolean> {
  const { rows } = await db.query<{ hits: number }>(
    `insert into throttle (key, window_start, hits) values ($1, now(), 1)
     on conflict (key) do update set
       hits = case when throttle.window_start <= now() - make_interval(secs => $2) then 1 else throttle.hits + 1 end,
       window_start = case when throttle.window_start <= now() - make_interval(secs => $2) then now() else throttle.window_start end
     returning hits`,
    [key, limit.seconds]
  );
  return (rows[0]?.hits ?? 0) > limit.hits;
}

/** Takes back one hit on each key: a sign-in that turned out right was not a failure. */
export async function refund(db: Db, keys: readonly string[]): Promise<void> {
  await db.query('update throttle set hits = greatest(hits - 1, 0) where key = any($1::text[])', [keys]);
}

/**
 * On about 1 in 50 writes: deletes throttle rows older than a day and activity older than 120 days. `roll` is the
 * random number in [0, 1), passed in so tests can choose.
 */
export async function pruneSometimes(db: Db, roll: number = Math.random()): Promise<boolean> {
  if (roll >= 1 / 50) return false;
  await db.query(
    "delete from throttle where window_start < now() - interval '1 day'; delete from activity where at < now() - interval '120 days'"
  );
  return true;
}
