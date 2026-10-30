// The organizer state machine on a real database: the setup seat, its 24-hour window and 7-day life, and how a saved
// ORGANIZER_PASSWORD retires it for good. Each test starts from a freshly migrated database.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import type pg from 'pg';
import {
  giveUpSeat,
  organizerAccess,
  organizerFromCookie,
  passwordCookie,
  passwordMatches,
  requireOrganizer,
  takeSeat
} from '../../src/lib/access';
import { readSettings, type Settings } from '../../src/lib/settings';
import { poolFor } from '../support/fixtures';
import { seatRaceProbe } from '../support/probes';
import { type Cluster, startCluster } from '../support/postgres';

let cluster: Cluster;
const pools: pg.Pool[] = [];

before(async () => {
  cluster = await startCluster();
});

after(async () => {
  await Promise.all(pools.map((pool) => pool.end()));
  await cluster?.stop();
});

async function freshCopy(): Promise<{ pool: pg.Pool; url: string; blank: Settings }> {
  const url = await cluster.createDatabase({ migrated: true });
  const pool = poolFor(url);
  pools.push(pool);
  return { pool, url, blank: readSettings({ DATABASE_URL: url }) };
}

async function seatRow(pool: pg.Pool) {
  const { rows } = await pool.query('select seat_state, seat_hash, seat_until, retired_at from app_state');
  return rows[0];
}

// Synthetic, test-only passwords.
const LONG_PASSWORD = 'correct horse battery staple';
const OTHER_LONG_PASSWORD = 'another long test password';

test('a fresh copy is setup-open, and reading the state never takes the seat', async () => {
  const { pool, blank } = await freshCopy();
  const before = await seatRow(pool);
  for (let i = 0; i < 3; i += 1) assert.equal((await organizerAccess(pool, blank)).state, 'setup-open');
  assert.deepEqual(await seatRow(pool), before);
  assert.equal(before?.seat_state, 'open');
});

test('five browsers press Set up at once, from five app processes: exactly one holds the seat', async () => {
  const { url, blank } = await freshCopy();
  const processes = Array.from({ length: 5 }, () => poolFor(url));
  pools.push(...processes);
  const winner = await seatRaceProbe(takeSeat, processes, blank);
  assert.match(winner.cookieValue, /^seat\.[A-Za-z0-9_-]{43}$/);
  assert.equal(winner.maxAgeSeconds, 7 * 24 * 60 * 60);

  const access = await organizerAccess(processes[0]!, blank);
  assert.equal(access.state, 'held');
  assert.deepEqual(organizerFromCookie(winner.cookieValue, access, blank), { via: 'seat' });
  const forged = `seat.${randomBytes(32).toString('base64url')}`;
  assert.equal(organizerFromCookie(forged, access, blank), null);
  assert.equal(await takeSeat(processes[1]!, blank), null, 'a later press loses too');
});

// Its negative control, the same probe on a copy of takeSeat without the open-seat condition, is in controls.test.ts.

test('after 7 days the seat is locked-expired: its cookie stops working and setup stays closed', async () => {
  const { pool, blank } = await freshCopy();
  const seat = (await takeSeat(pool, blank))!;
  await pool.query("update app_state set seat_until = now() - interval '1 second'");
  const access = await organizerAccess(pool, blank);
  assert.equal(access.state, 'locked-expired');
  assert.equal(organizerFromCookie(seat.cookieValue, access, blank), null);
  assert.equal(await takeSeat(pool, blank), null);
});

test('Give up setup ends the seat at once; only the holder can', async () => {
  const { pool, blank } = await freshCopy();
  const seat = (await takeSeat(pool, blank))!;
  assert.equal(await giveUpSeat(pool, `seat.${randomBytes(32).toString('base64url')}`), false);
  assert.equal((await organizerAccess(pool, blank)).state, 'held');
  assert.equal(await giveUpSeat(pool, seat.cookieValue), true);
  assert.equal((await organizerAccess(pool, blank)).state, 'locked-expired');
  assert.equal(await takeSeat(pool, blank), null);
});

test('a seat nobody took in the first 24 hours: locked-unclaimed, and setup is refused', async () => {
  const { pool, blank } = await freshCopy();
  await pool.query("update app_state set created_at = now() - interval '25 hours'");
  assert.equal((await organizerAccess(pool, blank)).state, 'locked-unclaimed');
  assert.equal(await takeSeat(pool, blank), null);
  assert.equal((await seatRow(pool))?.seat_state, 'open');
});

test('a short password retires the seat for good; removing it leaves the page locked; a long one signs in', async () => {
  const { pool, blank } = await freshCopy();
  const seat = (await takeSeat(pool, blank))!;

  const short = { ...blank, organizerPassword: 'short' };
  const lockedShort = await organizerAccess(pool, short);
  assert.equal(lockedShort.state, 'locked-short');
  const retired = await seatRow(pool);
  assert.equal(retired?.seat_state, 'retired');
  assert.equal(retired?.seat_hash, null);
  assert.ok(retired?.retired_at instanceof Date);
  assert.equal(organizerFromCookie(seat.cookieValue, lockedShort, short), null);
  assert.equal(passwordMatches('short', short), false);
  assert.equal(await takeSeat(pool, short), null);

  // The password removed again: the seat never reopens.
  const removed = await organizerAccess(pool, blank);
  assert.equal(removed.state, 'locked-removed');
  assert.equal(await takeSeat(pool, blank), null);
  assert.equal(organizerFromCookie(seat.cookieValue, removed, blank), null);

  const long = { ...blank, organizerPassword: LONG_PASSWORD };
  const password = await organizerAccess(pool, long);
  assert.equal(password.state, 'password');
  assert.equal(organizerFromCookie(seat.cookieValue, password, long), null, 'the old seat cookie is dead');
  assert.equal(passwordMatches(LONG_PASSWORD, long), true);
  const cookie = passwordCookie(long).cookieValue;
  assert.deepEqual(organizerFromCookie(cookie, password, long), { via: 'password' });
  // The retirement time stays the first one: the handover time the usage count starts from.
  assert.deepEqual((await seatRow(pool))?.retired_at, retired?.retired_at);
});

test('a saved password retires a seat that a stranger took', async () => {
  const { pool, blank } = await freshCopy();
  const stranger = (await takeSeat(pool, blank))!;
  const long = { ...blank, organizerPassword: LONG_PASSWORD };
  const access = await organizerAccess(pool, long);
  assert.equal(access.state, 'password');
  assert.equal(organizerFromCookie(stranger.cookieValue, access, long), null);
});

test('a new password signs every organizer browser out (the identity behind a cookie changes)', async () => {
  const { pool, url, blank } = await freshCopy();
  const first = { ...blank, organizerPassword: LONG_PASSWORD };
  await organizerAccess(pool, first);
  const cookie = passwordCookie(first).cookieValue;
  const headers = (value: string) =>
    new Headers({ host: 'copy.example.test', 'x-forwarded-proto': 'https', cookie: `__Host-ss_org=${value}; ss_org=${value}` });

  assert.deepEqual((await requireOrganizer(pool, headers(cookie), first))?.organizer, { via: 'password' });
  const rotated = { ...blank, organizerPassword: OTHER_LONG_PASSWORD };
  assert.equal(await requireOrganizer(pool, headers(cookie), rotated), null);
  const movedDatabase = readSettings({ DATABASE_URL: `${url}?application_name=moved`, ORGANIZER_PASSWORD: LONG_PASSWORD });
  assert.equal(await requireOrganizer(pool, headers(cookie), movedDatabase), null);
  // Over https only the __Host- name counts.
  const unprefixed = new Headers({ host: 'copy.example.test', 'x-forwarded-proto': 'https', cookie: `ss_org=${cookie}` });
  assert.equal(await requireOrganizer(pool, unprefixed, first), null);
});
