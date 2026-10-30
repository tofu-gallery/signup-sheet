// Helpers for the sign-up core's tests: future dates, members with links, route calls without a server, the state checks
// run after each test, and negative controls that run a changed copy of the source.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import type { Db } from '../../src/lib/db';
import type { MemberAuth } from '../../src/lib/identity';
import type { WriteContext } from '../../src/lib/signups';
import { newToken, tokenHash } from '../../src/lib/tokens';
import { countMismatches, dayFromToday } from './fixtures';
import { REPO } from './postgres';

// Future dates live in fixtures.ts (seedSlot counts from today too); the tests that use these helpers take them here.
export { dayFromToday };

/** A write context for a member (or the organizer) from a fixed browser. */
export function member(browser = 'memberBrowser_000000000'.slice(0, 22)): WriteContext {
  return { actor: 'member', browser };
}

export function organizer(browser = 'organizerBrowser_00000'.slice(0, 22)): WriteContext {
  return { actor: 'organizer', browser };
}

/** A person with a private link, as a claim would have made them. */
export async function personWithLink(db: Db, name: string, contact = ''): Promise<{ id: string; token: string; auth: MemberAuth }> {
  const token = newToken();
  const { rows } = await db.query<{ id: string }>(
    "insert into people (name, contact, token_hash, link_made_at, added_by) values ($1, $2, $3, now(), 'member') returning id",
    [name, contact, tokenHash(token)]
  );
  const id = rows[0]!.id;
  return { id, token, auth: { personId: id, tokenHash: tokenHash(token) } };
}

/** A sheet with one date `days` ahead (or the date given) and slots of the given capacities. */
export async function sheetWithSlots(
  db: Db,
  options: { slug: string; capacities: number[]; onDate?: string; status?: string; names?: 'full' | 'taken'; noteRequired?: boolean }
): Promise<{ sheetId: string; dateId: string; slotIds: string[] }> {
  const sheet = await db.query<{ id: string }>(
    `insert into sheets (slug, title, timezone, status, names, note_required)
     values ($1, 'Snack sign-up', 'America/Los_Angeles', $2, $3, $4) returning id`,
    [options.slug, options.status ?? 'open', options.names ?? 'full', options.noteRequired ?? false]
  );
  const sheetId = sheet.rows[0]!.id;
  const date = await db.query<{ id: string }>(
    "insert into dates (sheet_id, on_date, starts_at, ends_at) values ($1, $2, '09:00', '10:30') returning id",
    [sheetId, options.onDate ?? dayFromToday(10)]
  );
  const dateId = date.rows[0]!.id;
  const slotIds: string[] = [];
  for (const [position, capacity] of options.capacities.entries()) {
    const slot = await db.query<{ id: string }>(
      'insert into slots (sheet_id, date_id, label, capacity, position) values ($1, $2, $3, $4, $5) returning id',
      [sheetId, dateId, `Slot ${position + 1}`, capacity, position]
    );
    slotIds.push(slot.rows[0]!.id);
  }
  return { sheetId, dateId, slotIds };
}

/** Another date on a sheet, with slots. */
export async function dateWithSlots(db: Db, sheetId: string, onDate: string, capacities: number[]): Promise<{ dateId: string; slotIds: string[] }> {
  const date = await db.query<{ id: string }>(
    "insert into dates (sheet_id, on_date, starts_at, ends_at) values ($1, $2, '09:00', '10:30') returning id",
    [sheetId, onDate]
  );
  const dateId = date.rows[0]!.id;
  const slotIds: string[] = [];
  for (const [position, capacity] of capacities.entries()) {
    const slot = await db.query<{ id: string }>(
      'insert into slots (sheet_id, date_id, label, capacity, position) values ($1, $2, $3, $4, $5) returning id',
      [sheetId, dateId, `Slot ${position + 1}`, capacity, position]
    );
    slotIds.push(slot.rows[0]!.id);
  }
  return { dateId, slotIds };
}

/** A slot's sign-ups in queue order: who is confirmed and who waits, by person name. */
export async function roster(db: Db, slotId: string): Promise<{ confirmed: string[]; waiting: string[] }> {
  const { rows } = await db.query<{ name: string; status: string }>(
    `select p.name, g.status from signups g join people p on p.id = g.person_id
      where g.slot_id = $1 order by g.queued_at, g.id`,
    [slotId]
  );
  return {
    confirmed: rows.filter((row) => row.status === 'confirmed').map((row) => row.name),
    waiting: rows.filter((row) => row.status === 'waiting').map((row) => row.name)
  };
}

export async function count(db: Db, sql: string, values: unknown[] = []): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`select (${sql})::int as n`, values);
  return rows[0]!.n;
}

/** The check after every test: each slot's stored count equals its confirmed rows, and none is over capacity. */
export async function assertCountsConsistent(db: Db): Promise<void> {
  assert.deepEqual(await countMismatches(db), [], 'stored confirmed_count equals the confirmed rows');
  assert.equal(await count(db, 'select count(*) from slots where confirmed_count > capacity'), 0);
}

/**
 * Every business row a write could change, in a fixed order: the group's settings, sheets, dates, slots (with their
 * counts), people (with their link and paid state), sign-ups and the activity record. Two equal snapshots mean nothing
 * a refusal must leave alone was changed. Throttle rows are left out: a refused request may count against a limit.
 */
export async function snapshot(db: Db): Promise<Record<string, unknown[]>> {
  const tables: Record<string, string> = {
    group: 'select group_name, organizer_name, organizer_contact, dues_label, dues_amount_cents from app_state',
    sheets: 'select * from sheets order by id',
    dates: 'select * from dates order by id',
    slots: 'select * from slots order by id',
    people: 'select * from people order by id',
    signups: 'select * from signups order by id',
    activity: 'select * from activity order by id'
  };
  const result: Record<string, unknown[]> = {};
  for (const [name, sql] of Object.entries(tables)) result[name] = (await db.query(sql)).rows;
  return result;
}

/** Local tests reset the throttle between independent cases; the limits themselves are never relaxed. */
export async function resetThrottle(db: Db): Promise<void> {
  await db.query('truncate throttle');
}

// --- Calling route handlers directly (no HTTP server) --------------------------------------------------------------

export const ORIGIN = 'http://127.0.0.1:3000';

const shared = globalThis as typeof globalThis & { signupSheetPool?: pg.Pool };

/** Points the route handlers' own pool (appPool) and settings at `databaseUrl`, ending the pool they used before. */
export async function useDatabase(databaseUrl: string, password = ''): Promise<void> {
  await endRoutePool();
  process.env.DATABASE_URL = databaseUrl;
  process.env.ORGANIZER_PASSWORD = password;
}

export async function endRoutePool(): Promise<void> {
  await shared.signupSheetPool?.end();
  delete shared.signupSheetPool;
}

/**
 * A form POST as a browser on this copy sends it (plain http on loopback, so cookies have no __Host- prefix). `headers`
 * adds more, such as the address headers that tell two connections apart.
 */
export function formPost(
  path: string,
  fields: Record<string, string>,
  options: { cookies?: Record<string, string>; origin?: string | null; headers?: Record<string, string> } = {}
): Request {
  const headers = new Headers({ host: '127.0.0.1:3000', 'content-type': 'application/x-www-form-urlencoded', ...options.headers });
  if (options.origin !== null) headers.set('origin', options.origin ?? ORIGIN);
  const jar = Object.entries(options.cookies ?? {});
  if (jar.length > 0) headers.set('cookie', jar.map(([name, value]) => `${name}=${value}`).join('; '));
  return new Request(`${ORIGIN}${path}`, { method: 'POST', headers, body: new URLSearchParams(fields).toString() });
}

/** A JSON POST as an agent or the live check sends it to the import: with this copy's Origin, as JSON unless `headers` say otherwise. */
export function jsonPost(path: string, body: string, cookies: Record<string, string> = {}, headers: Record<string, string> = {}): Request {
  const all = new Headers({ host: '127.0.0.1:3000', origin: ORIGIN, 'content-type': 'application/json', ...headers });
  const jar = Object.entries(cookies);
  if (jar.length > 0) all.set('cookie', jar.map(([name, value]) => `${name}=${value}`).join('; '));
  return new Request(`${ORIGIN}${path}`, { method: 'POST', headers: all, body });
}

export function get(path: string, cookies: Record<string, string> = {}): Request {
  const headers = new Headers({ host: '127.0.0.1:3000' });
  const jar = Object.entries(cookies);
  if (jar.length > 0) headers.set('cookie', jar.map(([name, value]) => `${name}=${value}`).join('; '));
  return new Request(`${ORIGIN}${path}`, { headers });
}

export function params<T extends Record<string, string>>(values: T): { params: Promise<T> } {
  return { params: Promise.resolve(values) };
}

/** The value a response's Set-Cookie gives `name`, or null. */
export function cookieSet(response: Response, name: string): string | null {
  for (const line of response.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const [key, value] = (pair ?? '').split('=');
    if (key === name) return value ?? '';
  }
  return null;
}

// --- Negative controls: a changed copy of the source --------------------------------------------------------------

export type Edit = { file: string; from: string; to: string };

/**
 * Copies src/ and scripts/ into a scratch directory inside the repository (so its imports still find node_modules),
 * applies each edit (which must match exactly once, so a control can never pass by missing its target), and answers an
 * importer for the copy's modules and a cleanup. Nothing here ever changes the real source.
 */
export function changedCopy(edits: Edit[]): {
  load<T>(file: string): Promise<T>;
  remove(): void;
} {
  const dir = join(REPO, `.controls-${process.pid}-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir);
  cpSync(join(REPO, 'src'), join(dir, 'src'), { recursive: true });
  cpSync(join(REPO, 'scripts'), join(dir, 'scripts'), { recursive: true });
  for (const edit of edits) {
    const path = join(dir, edit.file);
    const text = readFileSync(path, 'utf8');
    const found = text.split(edit.from).length - 1;
    assert.equal(found, 1, `the control's edit must match exactly once in ${edit.file}`);
    // A function, so a `$` in the new text is never read as a replacement pattern.
    writeFileSync(path, text.replace(edit.from, () => edit.to));
  }
  return {
    load: (file) => import(join(dir, file)),
    remove: () => {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  };
}

// The hooks a changed copy may call. The real source never names them (test/unit/static.test.ts checks).
const PAUSE_HOOK = '__signupSheetPause';
export const FAIL_HOOK = '__signupSheetFail';

/** An edit that makes a copy wait, right after `line` (which must occur once in `file`), until the test opens `name`. */
export function pauseAfter(file: string, line: string, name: string): Edit {
  const indent = /^\s*/.exec(line)![0];
  return { file, from: line, to: `${line}\n${indent}await (globalThis as any).${PAUSE_HOOK}?.(${JSON.stringify(name)});` };
}

/**
 * The pauses of a copy made with pauseAfter. Each holds only the first transaction that arrives, until the test opens
 * it, so a race takes the same steps every run instead of whichever the scheduler allows. `end` opens every pause.
 */
export function pauses(names: string[]): { reached(name: string): Promise<void>; open(name: string): void; end(): void } {
  const gates = new Map<string, { arrive(): void; arrived: Promise<void>; open(): void; opened: Promise<void>; used: boolean }>();
  for (const name of names) {
    let arrive!: () => void;
    let open!: () => void;
    const arrived = new Promise<void>((resolve) => (arrive = resolve));
    const opened = new Promise<void>((resolve) => (open = resolve));
    gates.set(name, { arrive, arrived, open, opened, used: false });
  }
  const hooks = globalThis as Record<string, unknown>;
  hooks[PAUSE_HOOK] = async (name: string) => {
    const gate = gates.get(name);
    if (!gate || gate.used) return;
    gate.used = true;
    gate.arrive();
    await gate.opened;
  };
  return {
    reached: async (name) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          gates.get(name)!.arrived,
          new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`nothing reached the pause ${name}`)), 20_000)))
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    open: (name) => gates.get(name)!.open(),
    end: () => {
      for (const gate of gates.values()) gate.open();
      delete hooks[PAUSE_HOOK];
    }
  };
}

/** A promise's outcome, never rejecting, so a write that fails while the test still lines others up is not unhandled. */
export function settled<T>(promise: Promise<T>): Promise<{ value: T } | { error: unknown }> {
  return promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  );
}
