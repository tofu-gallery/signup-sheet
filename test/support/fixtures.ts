// Small helpers the database tests share: pools, a barrier for lining up concurrent transactions, days counted from
// today, and rows to start from.
import type pg from 'pg';
import { createPool, type Db } from '../../src/lib/db';
import { addDays, civilToday } from '../../src/lib/time';

/** A day `days` from today in the fixtures' time zone (America/Los_Angeles), so tests never age into the past. */
export function dayFromToday(days: number): string {
  return addDays(civilToday('America/Los_Angeles'), days);
}

/** An app pool (max 3, as each app process has) on `url`. */
export function poolFor(url: string, env: Record<string, string> = {}): pg.Pool {
  return createPool({ DATABASE_URL: url, ...env });
}

/**
 * Lets `count` concurrent tasks wait for one another: each calls the returned function and continues once all have.
 * Lining transactions up this way makes a race happen every time instead of when the scheduler happens to allow it.
 */
export function barrier(count: number): () => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  const everyone = new Promise<void>((resolve) => (release = resolve));
  return () => {
    arrived += 1;
    if (arrived === count) release();
    return everyone;
  };
}

/** Polls `check` every 100 ms until it is true. */
export async function waitFor(check: () => Promise<boolean>, what: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function seedSheet(db: Db, slug = 'snacks', status = 'open'): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "insert into sheets (slug, title, timezone, status) values ($1, 'Snack sign-up', 'America/Los_Angeles', $2) returning id",
    [slug, status]
  );
  return rows[0]!.id;
}

export async function seedSlot(
  db: Db,
  sheetId: string,
  options: { capacity?: number; onDate?: string; label?: string } = {}
): Promise<{ dateId: string; slotId: string }> {
  const date = await db.query<{ id: string }>(
    "insert into dates (sheet_id, on_date, starts_at, ends_at) values ($1, $2, '09:00', '10:30') returning id",
    [sheetId, options.onDate ?? dayFromToday(10)]
  );
  const dateId = date.rows[0]!.id;
  const slot = await db.query<{ id: string }>(
    'insert into slots (sheet_id, date_id, label, capacity) values ($1, $2, $3, $4) returning id',
    [sheetId, dateId, options.label ?? 'Snacks', options.capacity ?? 1]
  );
  return { dateId, slotId: slot.rows[0]!.id };
}

export async function seedPerson(db: Db, name: string, contact = ''): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "insert into people (name, contact, added_by) values ($1, $2, 'member') returning id",
    [name, contact]
  );
  return rows[0]!.id;
}

export async function seedSignup(db: Db, slotId: string, personId: string, status: 'confirmed' | 'waiting'): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "insert into signups (slot_id, person_id, status, added_by) values ($1, $2, $3, 'member') returning id",
    [slotId, personId, status]
  );
  return rows[0]!.id;
}

/** Slots whose stored confirmed_count differs from their confirmed rows (the check run after every test). */
export async function countMismatches(db: Db): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `select s.id from slots s
      where s.confirmed_count <> (select count(*) from signups g where g.slot_id = s.id and g.status = 'confirmed')`
  );
  return rows.map((row) => row.id);
}
