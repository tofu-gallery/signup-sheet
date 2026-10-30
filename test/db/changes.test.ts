// W2 cancel, W3 move, W4 swap, W5 note, Told them and W11 remove everywhere on a real database: promotion order, each
// member reaching only their own sign-ups (G6), a sign-up moved under a write's feet, and races that must keep every
// slot's count right. Direct calls of the transaction functions, from three pools; not HTTP tests.
import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import type pg from 'pg';
import { inTransaction, isDbError } from '../../src/lib/db';
import type { MemberAuth } from '../../src/lib/identity';
import { lockSheets } from '../../src/lib/locks';
import { makeNewLink, removePersonEverywhere } from '../../src/lib/people';
import { readSettings, type Settings } from '../../src/lib/settings';
import { cancelSignup, changeNote, claim, markTold, moveSignup, swapSignups } from '../../src/lib/signups';
import { newRequestId, tokenHash } from '../../src/lib/tokens';
import { barrier, poolFor, waitFor } from '../support/fixtures';
import {
  assertCountsConsistent,
  count,
  dateWithSlots,
  dayFromToday,
  member,
  organizer,
  personWithLink,
  roster,
  sheetWithSlots
} from '../support/core';
import { removalRaceProbe } from '../support/probes';
import { type Cluster, startCluster } from '../support/postgres';

let cluster: Cluster;
let url: string;
let pools: pg.Pool[];
let pool: pg.Pool;
let settings: Settings;

before(async () => {
  cluster = await startCluster();
  url = await cluster.createDatabase({ migrated: true });
  pools = [poolFor(url), poolFor(url), poolFor(url)];
  pool = pools[0]!;
  settings = readSettings({ DATABASE_URL: url });
});

afterEach(async () => assertCountsConsistent(pool));

after(async () => {
  await Promise.all((pools ?? []).map((each) => each.end()));
  await cluster?.stop();
});

/** Signs a new person with a link up on a slot directly, in queue order. */
async function signUp(slotId: string, name: string, status: 'confirmed' | 'waiting'): Promise<{ signupId: string; auth: MemberAuth; personId: string }> {
  const person = await personWithLink(pool, name);
  const { rows } = await pool.query<{ id: string }>(
    "insert into signups (slot_id, person_id, status, added_by) values ($1, $2, $3, 'member') returning id",
    [slotId, person.id, status]
  );
  return { signupId: rows[0]!.id, auth: person.auth, personId: person.id };
}

async function signupRow(id: string) {
  const { rows } = await pool.query<{ slot_id: string; status: string; note: string; changed: boolean; told: boolean; promoted: boolean }>(
    `select slot_id, status, note, changed_at is not null as changed, told_at is not null as told, promoted_at is not null as promoted
       from signups where id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

test('a cancel moves the earliest waiting person up, marked moved up; the rest move up one', async () => {
  const { slotIds } = await sheetWithSlots(pool, { slug: 'cancel', capacities: [1] });
  const mike = await signUp(slotIds[0]!, 'Mike', 'confirmed');
  const w1 = await signUp(slotIds[0]!, 'W1', 'waiting');
  await signUp(slotIds[0]!, 'W2', 'waiting');
  await signUp(slotIds[0]!, 'W3', 'waiting');
  const result = await cancelSignup(pool, { signupId: mike.signupId, owner: mike.auth }, member());
  assert.deepEqual(result, { kind: 'cancelled', slug: 'cancel', slotId: slotIds[0], promoted: 1, askGroup: false });
  assert.deepEqual(await roster(pool, slotIds[0]!), { confirmed: ['W1'], waiting: ['W2', 'W3'] });
  assert.equal((await signupRow(w1.signupId))?.promoted, true);
  assert.deepEqual(await cancelSignup(pool, { signupId: mike.signupId, owner: mike.auth }, member()), { kind: 'missing' }, 'already cancelled');
});

test('a removal on a date that has started, or a cancelled date, moves nobody up; one in the next 7 days with nobody waiting asks the group', async () => {
  const past = await sheetWithSlots(pool, { slug: 'past-cancel', capacities: [1], onDate: dayFromToday(-1) });
  const a = await signUp(past.slotIds[0]!, 'A', 'confirmed');
  await signUp(past.slotIds[0]!, 'Waiting A', 'waiting');
  assert.equal((await cancelSignup(pool, { signupId: a.signupId, owner: null }, organizer()) as { promoted: number }).promoted, 0);
  assert.deepEqual(await roster(pool, past.slotIds[0]!), { confirmed: [], waiting: ['Waiting A'] });

  const off = await sheetWithSlots(pool, { slug: 'off-cancel', capacities: [1] });
  await pool.query('update dates set cancelled_at = now() where id = $1', [off.dateId]);
  const b = await signUp(off.slotIds[0]!, 'B', 'confirmed');
  await signUp(off.slotIds[0]!, 'Waiting B', 'waiting');
  assert.equal((await cancelSignup(pool, { signupId: b.signupId, owner: null }, organizer()) as { promoted: number }).promoted, 0);

  const soon = await sheetWithSlots(pool, { slug: 'soon-cancel', capacities: [1], onDate: dayFromToday(3) });
  const c = await signUp(soon.slotIds[0]!, 'C', 'confirmed');
  assert.equal((await cancelSignup(pool, { signupId: c.signupId, owner: c.auth }, member()) as { askGroup: boolean }).askGroup, true);
});

test('a member cancels, moves or changes a note only while the sheet is open and the date neither cancelled nor started; the organizer still can', async () => {
  const closed = await sheetWithSlots(pool, { slug: 'locked-closed', capacities: [1], status: 'closed' });
  const started = await sheetWithSlots(pool, { slug: 'locked-started', capacities: [1], onDate: dayFromToday(-1) });
  const called = await sheetWithSlots(pool, { slug: 'locked-cancelled', capacities: [1] });
  await pool.query('update dates set cancelled_at = now() where id = $1', [called.dateId]);
  for (const [what, place, reason] of [['a closed sheet', closed, 'closed'], ['a date that has started', started, 'past'], ['a cancelled date', called, 'cancelled']] as const) {
    const mine = await signUp(place.slotIds[0]!, `Locked ${what}`, 'confirmed');
    const waiting = await signUp(place.slotIds[0]!, `Waiting ${what}`, 'waiting');
    // A place with room on a later date of the same sheet, to move to.
    const later = (await dateWithSlots(pool, place.sheetId, dayFromToday(20), [1])).slotIds[0]!;
    const activity = await count(pool, 'select count(*) from activity');
    assert.deepEqual(await cancelSignup(pool, { signupId: mine.signupId, owner: mine.auth }, member()), { kind: 'locked' }, what);
    assert.deepEqual(await cancelSignup(pool, { signupId: waiting.signupId, owner: waiting.auth }, member()), { kind: 'locked' }, `${what}: the waitlist`);
    assert.deepEqual(await changeNote(pool, { signupId: mine.signupId, owner: mine.auth, note: 'Too late' }, member()), { kind: 'locked' }, what);
    assert.deepEqual(await moveSignup(pool, { signupId: mine.signupId, toSlotId: later, owner: mine.auth }, member()), { kind: 'refused', reason }, `${what}: a move`);
    assert.deepEqual(await roster(pool, place.slotIds[0]!), { confirmed: [`Locked ${what}`], waiting: [`Waiting ${what}`] }, `${what}: nobody left`);
    assert.deepEqual(await roster(pool, later), { confirmed: [], waiting: [] }, `${what}: nobody moved`);
    assert.equal((await signupRow(mine.signupId))?.note, '', `${what}: the note is as it was`);
    assert.equal(await count(pool, 'select count(*) from activity'), activity, `${what}: no activity`);
    // The organizer can still change the note, move them and remove them.
    assert.equal((await changeNote(pool, { signupId: mine.signupId, owner: null, note: 'Organizer note' }, organizer())).kind, 'saved', what);
    assert.equal((await moveSignup(pool, { signupId: mine.signupId, toSlotId: later, owner: null }, organizer())).kind, 'moved', what);
    assert.equal((await cancelSignup(pool, { signupId: mine.signupId, owner: null }, organizer())).kind, 'cancelled', what);
  }
  // Control: the same member calls on an open sheet's date ahead go through.
  const open = await sheetWithSlots(pool, { slug: 'locked-open', capacities: [1] });
  const openLater = (await dateWithSlots(pool, open.sheetId, dayFromToday(20), [1])).slotIds[0]!;
  const own = await signUp(open.slotIds[0]!, 'Open', 'confirmed');
  assert.equal((await changeNote(pool, { signupId: own.signupId, owner: own.auth, note: 'In time' }, member())).kind, 'saved');
  assert.equal((await moveSignup(pool, { signupId: own.signupId, toSlotId: openLater, owner: own.auth }, member())).kind, 'moved');
  assert.equal((await cancelSignup(pool, { signupId: own.signupId, owner: own.auth }, member())).kind, 'cancelled');
});

test("G6: a member's link reaches only their own sign-ups: another's id finds nothing and nothing changes", async () => {
  const { slotIds } = await sheetWithSlots(pool, { slug: 'owners', capacities: [2, 2] });
  const a = await signUp(slotIds[0]!, 'A', 'confirmed');
  const b = await signUp(slotIds[0]!, 'B', 'confirmed');
  assert.deepEqual(await cancelSignup(pool, { signupId: b.signupId, owner: a.auth }, member()), { kind: 'missing' });
  assert.deepEqual(await moveSignup(pool, { signupId: b.signupId, toSlotId: slotIds[1]!, owner: a.auth }, member()), { kind: 'missing' });
  assert.deepEqual(await changeNote(pool, { signupId: b.signupId, owner: a.auth, note: 'Hijacked' }, member()), { kind: 'missing' });
  assert.deepEqual(await signupRow(b.signupId), { slot_id: slotIds[0], status: 'confirmed', note: '', changed: false, told: false, promoted: false });
  // Control: the same calls on A's own sign-up work.
  assert.equal((await changeNote(pool, { signupId: a.signupId, owner: a.auth, note: 'Oranges' }, member())).kind, 'saved');
  assert.equal((await moveSignup(pool, { signupId: a.signupId, toSlotId: slotIds[1]!, owner: a.auth }, member())).kind, 'moved');
  assert.equal((await cancelSignup(pool, { signupId: a.signupId, owner: a.auth }, member())).kind, 'cancelled');
});

test('a member whose link was just replaced can change nothing, even while the new link is being made', async () => {
  const { slotIds } = await sheetWithSlots(pool, { slug: 'stale-link', capacities: [2] });
  const a = await signUp(slotIds[0]!, 'A', 'confirmed');
  const replaced = await makeNewLink(pool, { personId: a.personId }, organizer());
  assert.equal(replaced.kind, 'made');
  assert.deepEqual(await cancelSignup(pool, { signupId: a.signupId, owner: a.auth }, member()), { kind: 'missing' });
  assert.deepEqual(await makeNewLink(pool, { owner: a.auth }, member()), { kind: 'missing' }, 'an old link cannot replace the new one');

  // In flight: the cancel waits for the new link's row lock, then finds its link gone.
  const fresh: MemberAuth = { personId: a.personId, tokenHash: tokenHash((replaced as { token: string }).token) };
  const rotation = await pool.connect();
  try {
    await rotation.query('begin');
    await rotation.query("update people set token_hash = sha256('another link'::bytea) where id = $1", [a.personId]);
    const cancel = cancelSignup(pools[1]!, { signupId: a.signupId, owner: fresh }, member());
    await waitFor(async () => (await count(pool, "select count(*) from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()")) > 0, 'the cancel to wait');
    await rotation.query('commit');
    assert.deepEqual(await cancel, { kind: 'missing' });
  } finally {
    rotation.release();
  }
  assert.equal((await signupRow(a.signupId))?.status, 'confirmed');
});

test("X1: a sign-up moved to another slot while a cancel waits for its locks: the cancel starts again and frees the slot it really left", async () => {
  const { sheetId, slotIds } = await sheetWithSlots(pool, { slug: 'moved-under', capacities: [1, 1, 1] });
  const [x, y, z] = slotIds as [string, string, string];
  const a = await signUp(x, 'A', 'confirmed');
  await signUp(x, 'Waiting X', 'waiting');
  await signUp(z, 'Z', 'confirmed');
  const waitingZ = await signUp(z, 'Waiting Z', 'waiting');

  // An organizer change holds the sheet; meanwhile the cancel has read A's slot (X) and waits for the sheet.
  const structural = await pool.connect();
  try {
    await structural.query('begin');
    await lockSheets(structural, [sheetId], 'update');
    const cancel = cancelSignup(pools[1]!, { signupId: a.signupId, owner: a.auth }, member());
    await waitFor(async () => (await count(pool, "select count(*) from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()")) > 0, 'the cancel to wait');
    // A moves to Z's place and Z to Y, as an organizer's moves would; X's waiting person moves up.
    await structural.query("update signups set slot_id = $1 where slot_id = $2 and status = 'confirmed'", [y, z]);
    await structural.query("update signups set slot_id = $1 where id = $2", [z, a.signupId]);
    await structural.query("update signups set status = 'confirmed', promoted_at = now() where slot_id = $1 and status = 'waiting'", [x]);
    await structural.query('commit');
    const result = await cancel;
    assert.equal(result.kind, 'cancelled');
    assert.equal((result as { slotId: string }).slotId, z, 'the slot A was really in');
  } finally {
    structural.release();
  }
  assert.equal((await signupRow(waitingZ.signupId))?.status, 'confirmed', "Z's waiting person moved up into the place A left");
  assert.deepEqual(await roster(pool, x), { confirmed: ['Waiting X'], waiting: [] });
});

// The order a waitlist moves in, not a capacity proof: the cancel and its promotion commit together, so the claim
// always finds the place taken again. Capacity under racing claims is proven by the last-place races and their
// negative control (controls.test.ts), which removes the slot lock and the CHECK.
test('a cancel and a claim at the same instant (20 rounds): the earliest waiting moves up and the newcomer queues last', async () => {
  for (let round = 0; round < 20; round += 1) {
    const slug = `cancel-claim-${round}`;
    const { slotIds } = await sheetWithSlots(pool, { slug, capacities: [1] });
    const a = await signUp(slotIds[0]!, 'A', 'confirmed');
    await signUp(slotIds[0]!, 'W1', 'waiting');
    await signUp(slotIds[0]!, 'W2', 'waiting');
    const ready = barrier(2);
    await Promise.all([
      ready().then(() => cancelSignup(pools[0]!, { signupId: a.signupId, owner: a.auth }, member())),
      ready().then(() =>
        claim(pools[1]!, settings, { slug, slotId: slotIds[0]!, requestId: newRequestId(), who: { kind: 'new', name: 'Newcomer', contact: '' }, note: '', rules: 'member' }, member())
      )
    ]);
    assert.deepEqual(await roster(pool, slotIds[0]!), { confirmed: ['W1'], waiting: ['W2', 'Newcomer'] });
  }
});

test('a member moves into a free place; full places, places they hold and cancelled or started dates are refused, changing nothing', async () => {
  const { sheetId, slotIds } = await sheetWithSlots(pool, { slug: 'move', capacities: [1, 2, 1] });
  const [from, roomy, full] = slotIds as [string, string, string];
  const a = await signUp(from, 'A', 'confirmed');
  await signUp(from, 'Waiting', 'waiting');
  await signUp(full, 'F', 'confirmed');
  const off = await dateWithSlots(pool, sheetId, dayFromToday(12), [3]);
  await pool.query('update dates set cancelled_at = now() where id = $1', [off.dateId]);
  const past = await dateWithSlots(pool, sheetId, dayFromToday(-2), [3]);

  for (const [to, reason] of [[full, 'taken'], [off.slotIds[0]!, 'cancelled'], [past.slotIds[0]!, 'past'], [from, 'same']] as const) {
    assert.deepEqual(await moveSignup(pool, { signupId: a.signupId, toSlotId: to, owner: a.auth }, member()), { kind: 'refused', reason });
  }
  assert.deepEqual(await roster(pool, from), { confirmed: ['A'], waiting: ['Waiting'] });

  assert.deepEqual(await moveSignup(pool, { signupId: a.signupId, toSlotId: roomy, owner: a.auth }, member()), { kind: 'moved', slug: 'move', promoted: 1 });
  assert.deepEqual(await roster(pool, from), { confirmed: ['Waiting'], waiting: [] }, 'the place A left went to the waiting person');
  assert.deepEqual(await signupRow(a.signupId), { slot_id: roomy, status: 'confirmed', note: '', changed: false, told: false, promoted: false });
});

test("the organizer's move marks the person to tell, and may move people out of a cancelled date", async () => {
  const { sheetId, slotIds, dateId } = await sheetWithSlots(pool, { slug: 'org-move', capacities: [1] });
  const a = await signUp(slotIds[0]!, 'A', 'confirmed');
  await pool.query('update dates set cancelled_at = now() where id = $1', [dateId]);
  const later = await dateWithSlots(pool, sheetId, dayFromToday(17), [1]);
  assert.equal((await moveSignup(pool, { signupId: a.signupId, toSlotId: later.slotIds[0]!, owner: null }, organizer())).kind, 'moved');
  assert.deepEqual(await signupRow(a.signupId), { slot_id: later.slotIds[0], status: 'confirmed', note: '', changed: true, told: false, promoted: false });
  assert.equal((await markTold(pool, { signupId: a.signupId, told: true }, organizer())).kind, 'saved');
  assert.equal((await signupRow(a.signupId))?.told, true);
  assert.equal((await markTold(pool, { signupId: a.signupId, told: false }, organizer())).kind, 'saved');
  assert.equal((await signupRow(a.signupId))?.told, false, 'Undo puts it back in Needs attention');
});

test('two people move into the last place at once: one moves, the other is refused; both old places move their queues up', async () => {
  for (let round = 0; round < 5; round += 1) {
    const { slotIds } = await sheetWithSlots(pool, { slug: `last-place-${round}`, capacities: [1, 1, 1] });
    const [x, y, z] = slotIds as [string, string, string];
    const a = await signUp(x, 'A', 'confirmed');
    await signUp(x, 'WX', 'waiting');
    const b = await signUp(y, 'B', 'confirmed');
    await signUp(y, 'WY', 'waiting');
    const ready = barrier(2);
    const results = await Promise.all([
      ready().then(() => moveSignup(pools[0]!, { signupId: a.signupId, toSlotId: z, owner: a.auth }, member())),
      ready().then(() => moveSignup(pools[1]!, { signupId: b.signupId, toSlotId: z, owner: b.auth }, member()))
    ]);
    assert.deepEqual(results.map((result) => result.kind).sort(), ['moved', 'refused']);
    const moved = results[0]!.kind === 'moved' ? ['A', x, 'WX'] : ['B', y, 'WY'];
    assert.deepEqual(await roster(pool, z), { confirmed: [moved[0]], waiting: [] });
    assert.deepEqual((await roster(pool, moved[1]!)).confirmed, [moved[2]]);
  }
});

test('opposing moves at the same instant (20 rounds) never deadlock: slots are always locked in id order', async () => {
  const { slotIds } = await sheetWithSlots(pool, { slug: 'opposing', capacities: [2, 2] });
  const [x, y] = slotIds as [string, string];
  const a = await signUp(x, 'A', 'confirmed');
  const b = await signUp(y, 'B', 'confirmed');
  for (let round = 0; round < 20; round += 1) {
    const ready = barrier(2);
    const [aTo, bTo] = round % 2 === 0 ? [y, x] : [x, y];
    const results = await Promise.allSettled([
      ready().then(() => moveSignup(pools[0]!, { signupId: a.signupId, toSlotId: aTo, owner: a.auth }, member())),
      ready().then(() => moveSignup(pools[1]!, { signupId: b.signupId, toSlotId: bTo, owner: b.auth }, member()))
    ]);
    for (const result of results) {
      assert.equal(result.status, 'fulfilled', result.status === 'rejected' && isDbError(result.reason, '40P01') ? 'deadlock' : String((result as PromiseRejectedResult).reason));
    }
  }
});

test('W4 swap: two full capacity-1 places trade people; counts and both waitlists stay as they were', async () => {
  const { slotIds } = await sheetWithSlots(pool, { slug: 'swap', capacities: [1, 1] });
  const [x, y] = slotIds as [string, string];
  const a = await signUp(x, 'A', 'confirmed');
  await signUp(x, 'WX1', 'waiting');
  await signUp(x, 'WX2', 'waiting');
  const b = await signUp(y, 'B', 'confirmed');
  await signUp(y, 'WY1', 'waiting');
  assert.deepEqual(await swapSignups(pool, { a: a.signupId, b: b.signupId }, organizer()), { kind: 'swapped', slug: 'swap', signupIds: [a.signupId, b.signupId] });
  assert.deepEqual(await roster(pool, x), { confirmed: ['B'], waiting: ['WX1', 'WX2'] });
  assert.deepEqual(await roster(pool, y), { confirmed: ['A'], waiting: ['WY1'] });
  for (const id of [a.signupId, b.signupId]) assert.deepEqual({ ...(await signupRow(id)), slot_id: '' }, { slot_id: '', status: 'confirmed', note: '', changed: true, told: false, promoted: false });

  // Refused, changing nothing: a waiting sign-up, the same slot, and someone already holding the other place.
  const waiting = (await pool.query<{ id: string }>("select id from signups where slot_id = $1 and status = 'waiting' order by queued_at limit 1", [x])).rows[0]!.id;
  assert.deepEqual(await swapSignups(pool, { a: a.signupId, b: waiting }, organizer()), { kind: 'refused', reason: 'changed' });
  const crossing = await sheetWithSlots(pool, { slug: 'swap-cross', capacities: [1, 1] });
  const c = await signUp(crossing.slotIds[0]!, 'C', 'confirmed');
  const d = await signUp(crossing.slotIds[1]!, 'D', 'confirmed');
  await pool.query("insert into signups (slot_id, person_id, status, added_by) values ($1, $2, 'waiting', 'member')", [crossing.slotIds[1], c.personId]);
  assert.deepEqual(await swapSignups(pool, { a: c.signupId, b: d.signupId }, organizer()), { kind: 'refused', reason: 'conflict' });
});

test('a swap racing claims on both of its places (20 rounds) never overfills either', async () => {
  for (let round = 0; round < 20; round += 1) {
    const slug = `swap-race-${round}`;
    const { slotIds } = await sheetWithSlots(pool, { slug, capacities: [1, 1] });
    const [x, y] = slotIds as [string, string];
    const a = await signUp(x, 'A', 'confirmed');
    const b = await signUp(y, 'B', 'confirmed');
    const ready = barrier(3);
    const claimOn = (slotId: string, name: string, at: pg.Pool) =>
      ready().then(() => claim(at, settings, { slug, slotId, requestId: newRequestId(), who: { kind: 'new', name, contact: '' }, note: '', rules: 'member' }, member()));
    const [swap, onX, onY] = await Promise.all([
      ready().then(() => swapSignups(pools[0]!, { a: a.signupId, b: b.signupId }, organizer())),
      claimOn(x, 'NX', pools[1]!),
      claimOn(y, 'NY', pools[2]!)
    ]);
    assert.equal(swap.kind, 'swapped');
    assert.equal(onX.kind === 'signed-up' && onX.status, 'waiting');
    assert.equal(onY.kind === 'signed-up' && onY.status, 'waiting');
    assert.deepEqual(await roster(pool, x), { confirmed: ['B'], waiting: ['NX'] });
    assert.deepEqual(await roster(pool, y), { confirmed: ['A'], waiting: ['NY'] });
  }
});

test('a required note stays filled; the organizer may change any note', async () => {
  const { slotIds } = await sheetWithSlots(pool, { slug: 'potluck', capacities: [4], noteRequired: true });
  const a = await signUp(slotIds[0]!, 'A', 'confirmed');
  assert.deepEqual(await changeNote(pool, { signupId: a.signupId, owner: a.auth, note: '' }, member()), { kind: 'refused', reason: 'note' });
  assert.deepEqual(await changeNote(pool, { signupId: a.signupId, owner: a.auth, note: 'Lasagna' }, member()), { kind: 'saved', slug: 'potluck' });
  assert.deepEqual(await changeNote(pool, { signupId: a.signupId, owner: null, note: 'Salad' }, organizer()), { kind: 'saved', slug: 'potluck' });
  assert.equal((await signupRow(a.signupId))?.note, 'Salad');
});

test('W11 removes a person everywhere: their places go to the people waiting, and the person is gone', async () => {
  const { sheetId, slotIds } = await sheetWithSlots(pool, { slug: 'remove-all', capacities: [1, 1] });
  const later = await dateWithSlots(pool, sheetId, dayFromToday(20), [1]);
  const prank = await personWithLink(pool, 'Prankster');
  for (const [slotId, status] of [[slotIds[0]!, 'confirmed'], [slotIds[1]!, 'confirmed']] as const) {
    await pool.query("insert into signups (slot_id, person_id, status, added_by) values ($1, $2, $3, 'member')", [slotId, prank.id, status]);
  }
  await signUp(later.slotIds[0]!, 'L', 'confirmed');
  await pool.query("insert into signups (slot_id, person_id, status, added_by) values ($1, $2, 'waiting', 'member')", [later.slotIds[0], prank.id]);
  await signUp(slotIds[0]!, 'W0', 'waiting');
  await signUp(slotIds[1]!, 'W1', 'waiting');
  assert.deepEqual(await removePersonEverywhere(pool, prank.id, organizer()), { kind: 'removed', signups: 3, promoted: 2 });
  assert.deepEqual(await roster(pool, slotIds[0]!), { confirmed: ['W0'], waiting: [] });
  assert.deepEqual(await roster(pool, slotIds[1]!), { confirmed: ['W1'], waiting: [] });
  assert.deepEqual(await roster(pool, later.slotIds[0]!), { confirmed: ['L'], waiting: [] });
  assert.equal(await count(pool, 'select count(*) from people where id = $1', [prank.id]), 0);
  assert.deepEqual(await removePersonEverywhere(pool, prank.id, organizer()), { kind: 'missing' });
});

test('W11 racing a claim for the same person (10 rounds): never half removed, and no sign-up is left without its person', async () => {
  for (let round = 0; round < 10; round += 1) {
    const { slotIds } = await sheetWithSlots(pool, { slug: `remove-race-${round}`, capacities: [1, 2] });
    const person = await signUp(slotIds[0]!, 'Target', 'confirmed');
    await signUp(slotIds[0]!, 'Next', 'waiting');
    const ready = barrier(2);
    const [removal, added] = await Promise.all([
      ready().then(() => removePersonEverywhere(pools[0]!, person.personId, organizer())),
      ready().then(() =>
        claim(pools[1]!, settings, { slug: null, slotId: slotIds[1]!, requestId: newRequestId(), who: { kind: 'person', personId: person.personId }, note: '', rules: 'organizer' }, organizer())
      )
    ]);
    assert.equal(removal.kind, 'removed');
    assert.ok(added.kind === 'signed-up' || (added.kind === 'refused' && added.reason === 'person'), JSON.stringify(added));
    assert.equal(await count(pool, 'select count(*) from people where id = $1', [person.personId]), 0);
    assert.equal(await count(pool, 'select count(*) from signups where person_id = $1', [person.personId]), 0);
    assert.deepEqual(await roster(pool, slotIds[0]!), { confirmed: ['Next'], waiting: [] });
  }
});

test('W11 and a member write it does not hold (pauses line the steps up): no deadlock, the person and all their sign-ups go', async () => {
  for (let round = 0; round < 3; round += 1) await removalRaceProbe(url);
});

test('G4: each change writes one activity row with its actor; a refused change and a rolled-back one write none', async () => {
  const { slotIds } = await sheetWithSlots(pool, { slug: 'activity', capacities: [1], noteRequired: true });
  const a = await signUp(slotIds[0]!, 'A', 'confirmed');
  const before = await count(pool, 'select count(*) from activity');
  await changeNote(pool, { signupId: a.signupId, owner: a.auth, note: 'Hi' }, member());
  await changeNote(pool, { signupId: a.signupId, owner: a.auth, note: 'Hello' }, organizer());
  assert.deepEqual(await changeNote(pool, { signupId: a.signupId, owner: a.auth, note: '' }, member()), { kind: 'refused', reason: 'note' });
  const { rows } = await pool.query<{ actor: string; kind: string }>('select actor, kind from activity order by id desc limit 2');
  assert.deepEqual(rows, [{ actor: 'organizer', kind: 'note' }, { actor: 'member', kind: 'note' }]);
  assert.equal(await count(pool, 'select count(*) from activity'), before + 2);

  await assert.rejects(
    inTransaction(pool, async (tx) => {
      await tx.query("insert into activity (actor, kind, browser) values ('member', 'note', $1)", [member().browser]);
      await tx.query('update slots set capacity = 0 where id = $1', [slotIds[0]]);
    })
  );
  assert.equal(await count(pool, 'select count(*) from activity'), before + 2);
});
