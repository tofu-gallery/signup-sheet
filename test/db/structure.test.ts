// The organizer's structural changes on a real database: W6 capacity, W7 deletes and their `seen` check, cancelling and
// editing dates, sheets and their time zone, adding dates and slots, and W10's import transaction, each against claims
// in flight. Direct calls of the transaction functions, from three pools; not HTTP tests.
import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import type pg from 'pg';
import { inTransaction, isDbError } from '../../src/lib/db';
import { applyImport, type ImportPlan } from '../../src/lib/importer';
import { lockSheetsOfSlots, lockSlots } from '../../src/lib/locks';
import { removePersonEverywhere } from '../../src/lib/people';
import { readSettings, type Settings } from '../../src/lib/settings';
import { claim, type ClaimInput, moveSignup } from '../../src/lib/signups';
import {
  addDate,
  addSlotEveryDate,
  createSheet,
  deleteTarget,
  deletionPreview,
  editDate,
  editSheet,
  editSlot,
  seenDigest,
  setDateCancelled,
  setSheetStatus,
  type SheetFields
} from '../../src/lib/structure';
import { newRequestId } from '../../src/lib/tokens';
import { barrier, poolFor, waitFor } from '../support/fixtures';
import { assertCountsConsistent, count, dateWithSlots, dayFromToday, member, organizer, personWithLink, roster, sheetWithSlots } from '../support/core';
import { type Cluster, startCluster } from '../support/postgres';

let cluster: Cluster;
let pools: pg.Pool[];
let pool: pg.Pool;
let settings: Settings;

before(async () => {
  cluster = await startCluster();
  const url = await cluster.createDatabase({ migrated: true });
  pools = [poolFor(url), poolFor(url), poolFor(url)];
  pool = pools[0]!;
  settings = readSettings({ DATABASE_URL: url });
});

afterEach(async () => assertCountsConsistent(pool));

after(async () => {
  await Promise.all((pools ?? []).map((each) => each.end()));
  await cluster?.stop();
});

const claimFor = (slug: string | null, slotId: string, name: string): ClaimInput => ({
  slug,
  slotId,
  requestId: newRequestId(),
  who: { kind: 'new', name, contact: '' },
  note: '',
  rules: 'member'
});

async function signUp(slotId: string, name: string, status: 'confirmed' | 'waiting'): Promise<string> {
  const person = await personWithLink(pool, name);
  const { rows } = await pool.query<{ id: string }>(
    "insert into signups (slot_id, person_id, status, added_by) values ($1, $2, $3, 'member') returning id",
    [slotId, person.id, status]
  );
  return rows[0]!.id;
}

const lockWaits = () => count(pool, "select count(*) from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()");

test('W6: raising a capacity from 1 to 3 with 4 waiting moves the first 2 up in order; lowering below the confirmed is refused', async () => {
  const { slotIds } = await sheetWithSlots(pool, { slug: 'capacity', capacities: [1] });
  const slotId = slotIds[0]!;
  await signUp(slotId, 'C', 'confirmed');
  for (const name of ['W1', 'W2', 'W3', 'W4']) await signUp(slotId, name, 'waiting');
  const raised = await editSlot(pool, { slotId, slot: { label: 'Snacks', description: '', capacity: 3 } }, organizer());
  assert.deepEqual(raised, { kind: 'saved', slug: 'capacity', promoted: 2 });
  assert.deepEqual(await roster(pool, slotId), { confirmed: ['C', 'W1', 'W2'], waiting: ['W3', 'W4'] });

  assert.deepEqual(await editSlot(pool, { slotId, slot: { label: 'Snacks', description: '', capacity: 2 } }, organizer()), {
    kind: 'refused',
    reason: 'capacity',
    slug: 'capacity',
    confirmed: 3
  });
  const direct = await pool.query('update slots set capacity = 2 where id = $1', [slotId]).catch((error: unknown) => error);
  assert.ok(isDbError(direct, '23514', 'slots_within_capacity'), 'the CHECK refuses a direct update too');
  const extra = await personWithLink(pool, 'Overfill');
  const insert = await pool
    .query("insert into signups (slot_id, person_id, status, added_by) values ($1, $2, 'confirmed', 'member')", [slotId, extra.id])
    .catch((error: unknown) => error);
  assert.ok(isDbError(insert, '23514', 'slots_within_capacity'), 'the backstop refuses a direct confirmed insert into a full slot');
});

test("W7: the confirmation's list and seen; a claim since then refuses the delete; with the new seen it deletes", async () => {
  const { slotIds } = await sheetWithSlots(pool, { slug: 'doomed', capacities: [2] });
  await signUp(slotIds[0]!, 'Mike', 'confirmed');
  const preview = await deletionPreview(pool, { kind: 'slot', id: slotIds[0]! });
  assert.deepEqual(preview?.people.map((person) => person.name), ['Mike']);
  assert.equal(preview?.seen, seenDigest(preview!.people.map((person) => person.signupId)));

  const frank = await claim(pool, settings, claimFor('doomed', slotIds[0]!, 'Frank'), member());
  assert.equal(frank.kind, 'signed-up');
  const refused = await deleteTarget(pool, { target: { kind: 'slot', id: slotIds[0]! }, seen: preview!.seen }, organizer());
  assert.equal(refused.kind, 'changed');
  assert.deepEqual((refused as { preview: { people: { name: string }[] } }).preview.people.map((person) => person.name), ['Mike', 'Frank']);
  assert.equal(await count(pool, 'select count(*) from slots where id = $1', [slotIds[0]]), 1, 'nothing deleted');

  const fresh = (refused as { preview: { seen: string } }).preview.seen;
  assert.deepEqual(await deleteTarget(pool, { target: { kind: 'slot', id: slotIds[0]! }, seen: fresh }, organizer()), { kind: 'deleted', slug: 'doomed' });
  assert.equal(await count(pool, 'select count(*) from signups where slot_id = $1', [slotIds[0]]), 0);
});

test('W7: a claim in flight when the delete starts: the delete waits for it, sees it, and deletes nothing', async () => {
  const { sheetId, slotIds } = await sheetWithSlots(pool, { slug: 'in-flight', capacities: [3] });
  const preview = (await deletionPreview(pool, { kind: 'sheet', slug: 'in-flight' }))!;
  const person = await personWithLink(pool, 'Late');
  const inFlight = await pool.connect();
  try {
    await inFlight.query('begin');
    await lockSheetsOfSlots(inFlight, [slotIds[0]!], 'share');
    await lockSlots(inFlight, [slotIds[0]!]);
    await inFlight.query("insert into signups (slot_id, person_id, status, added_by) values ($1, $2, 'confirmed', 'member')", [slotIds[0], person.id]);
    const deletion = deleteTarget(pools[1]!, { target: { kind: 'sheet', slug: 'in-flight' }, seen: preview.seen }, organizer());
    await waitFor(async () => (await lockWaits()) > 0, 'the delete to wait for the claim');
    await inFlight.query('commit');
    assert.equal((await deletion).kind, 'changed');
  } finally {
    inFlight.release();
  }
  assert.equal(await count(pool, 'select count(*) from sheets where id = $1', [sheetId]), 1);
  // A new slot with people in it, added after the confirmation, changes the list as well.
  const date = await dateWithSlots(pool, sheetId, dayFromToday(30), [1]);
  const before = (await deletionPreview(pool, { kind: 'sheet', slug: 'in-flight' }))!;
  await signUp(date.slotIds[0]!, 'Newer', 'confirmed');
  assert.equal((await deleteTarget(pool, { target: { kind: 'sheet', slug: 'in-flight' }, seen: before.seen }, organizer())).kind, 'changed');
});

test('a cancelled date keeps its people, refuses claims and moves in, and moves nobody up; undoing it does', async () => {
  const { sheetId, dateId, slotIds } = await sheetWithSlots(pool, { slug: 'rain', capacities: [1] });
  const kept = await signUp(slotIds[0]!, 'Kept', 'confirmed');
  await signUp(slotIds[0]!, 'Waiting', 'waiting');
  assert.deepEqual(await setDateCancelled(pool, { dateId, cancelled: true }, organizer()), { kind: 'saved', slug: 'rain', promoted: 0 });
  const refused = await claim(pool, settings, claimFor('rain', slotIds[0]!, 'New'), member());
  assert.deepEqual(refused, { kind: 'refused', reason: 'cancelled', slug: 'rain' });
  const other = await dateWithSlots(pool, sheetId, dayFromToday(14), [2]);
  const mover = await signUp(other.slotIds[0]!, 'Mover', 'confirmed');
  assert.deepEqual(await moveSignup(pool, { signupId: mover, toSlotId: slotIds[0]!, owner: null }, organizer()), { kind: 'refused', reason: 'cancelled' });

  await pool.query('delete from signups where id = $1', [kept]);
  assert.deepEqual(await roster(pool, slotIds[0]!), { confirmed: [], waiting: ['Waiting'] });
  assert.deepEqual(await setDateCancelled(pool, { dateId, cancelled: false }, organizer()), { kind: 'saved', slug: 'rain', promoted: 1 });
  assert.deepEqual(await roster(pool, slotIds[0]!), { confirmed: ['Waiting'], waiting: [] });
});

test('a new day, time or place marks everyone on the date to tell; a new label alone does not', async () => {
  const { dateId, slotIds } = await sheetWithSlots(pool, { slug: 'moved-date', capacities: [2] });
  const a = await signUp(slotIds[0]!, 'A', 'confirmed');
  await pool.query('update signups set told_at = now() where id = $1', [a]);
  const same = { onDate: dayFromToday(10), startsAt: '09:00', endsAt: '10:30', place: '' };
  assert.deepEqual(await editDate(pool, { dateId, date: { ...same, label: 'vs Eagles' } }, organizer()), { kind: 'saved', slug: 'moved-date', changed: 0 });
  assert.deepEqual(await editDate(pool, { dateId, date: { ...same, label: 'vs Eagles', startsAt: '10:00' } }, organizer()), {
    kind: 'saved',
    slug: 'moved-date',
    changed: 1
  });
  const { rows } = await pool.query<{ changed: boolean; told: boolean }>(
    'select changed_at is not null as changed, told_at is not null as told from signups where id = $1',
    [a]
  );
  assert.deepEqual(rows[0], { changed: true, told: false });
});

test("a sheet's time zone cannot change once anyone signed up; its other words can", async () => {
  const fields: SheetFields = { title: 'Snacks', description: '', timezone: 'America/Los_Angeles', place: '', names: 'full', noteLabel: '', noteRequired: false, listed: true };
  assert.deepEqual(await createSheet(pool, { ...fields, slug: 'tz', status: 'open' }, organizer()), { kind: 'created', slug: 'tz' });
  assert.deepEqual(await createSheet(pool, { ...fields, slug: 'tz', status: 'open' }, organizer()), { kind: 'refused', reason: 'slug' });
  assert.deepEqual(await editSheet(pool, { ...fields, slug: 'tz', timezone: 'America/Chicago' }, organizer()), { kind: 'saved' });
  const added = await addDate(pool, { slug: 'tz', date: { onDate: dayFromToday(9), startsAt: null, endsAt: null, label: '', place: '' }, withSlots: false }, organizer());
  assert.equal(added.kind, 'added');
  const slot = await pool.query<{ id: string }>("insert into slots (sheet_id, date_id, label, capacity) values ((select id from sheets where slug = 'tz'), $1, 'Snacks', 2) returning id", [
    (added as { dateId: string }).dateId
  ]);
  await signUp(slot.rows[0]!.id, 'A', 'confirmed');
  assert.deepEqual(await editSheet(pool, { ...fields, slug: 'tz', timezone: 'America/New_York' }, organizer()), { kind: 'refused', reason: 'timezone' });
  assert.deepEqual(await editSheet(pool, { ...fields, slug: 'tz', timezone: 'America/Chicago', title: 'Snack rota' }, organizer()), { kind: 'saved' });
  assert.deepEqual(await setSheetStatus(pool, { slug: 'tz', status: 'closed' }, organizer()), { kind: 'saved' });
});

test('"Add a date" copies the latest date\'s slots; "Add a slot to every date" fills only dates from today on that lack it', async () => {
  const { sheetId, slotIds } = await sheetWithSlots(pool, { slug: 'adds', capacities: [1, 2] });
  await pool.query("update slots set label = 'Drivers' where id = $1", [slotIds[1]]);
  const copied = await addDate(pool, { slug: 'adds', date: { onDate: dayFromToday(17), startsAt: '09:00', endsAt: null, label: '', place: '' }, withSlots: true }, organizer());
  assert.deepEqual({ ...copied, dateId: '' }, { kind: 'added', slug: 'adds', dateId: '', slots: 2 });
  await dateWithSlots(pool, sheetId, dayFromToday(-7), []);
  const every = await addSlotEveryDate(pool, { slug: 'adds', slot: { label: 'drivers', description: '', capacity: 2 } }, organizer());
  assert.deepEqual(every, { kind: 'added', slug: 'adds', slots: 0 }, 'both upcoming dates have Drivers already (any case); the past one is skipped');
  const water = await addSlotEveryDate(pool, { slug: 'adds', slot: { label: 'Water', description: '', capacity: 1 } }, organizer());
  assert.deepEqual(water, { kind: 'added', slug: 'adds', slots: 2 });
});

test('claims, moves and structural changes on one sheet all at once (10 rounds): no deadlock, no overfill', async () => {
  for (let round = 0; round < 10; round += 1) {
    const slug = `mixed-${round}`;
    const { sheetId, dateId, slotIds } = await sheetWithSlots(pool, { slug, capacities: [1, 2] });
    const other = await dateWithSlots(pool, sheetId, dayFromToday(11), [1]);
    const mover = await signUp(slotIds[1]!, 'Mover', 'confirmed');
    const ready = barrier(6);
    const results = await Promise.allSettled([
      ready().then(() => claim(pools[0]!, settings, claimFor(slug, slotIds[0]!, 'C1'), member())),
      ready().then(() => claim(pools[1]!, settings, claimFor(slug, slotIds[0]!, 'C2'), member())),
      ready().then(() => moveSignup(pools[2]!, { signupId: mover, toSlotId: other.slotIds[0]!, owner: null }, organizer())),
      ready().then(() => editSlot(pools[0]!, { slotId: slotIds[0]!, slot: { label: 'Snacks', description: '', capacity: 2 } }, organizer())),
      ready().then(() => editDate(pools[1]!, { dateId, date: { onDate: dayFromToday(10), startsAt: '08:00', endsAt: null, label: '', place: '' } }, organizer())),
      ready().then(() => addSlotEveryDate(pools[2]!, { slug, slot: { label: 'Water', description: '', capacity: 1 } }, organizer()))
    ]);
    for (const result of results) assert.equal(result.status, 'fulfilled', String((result as PromiseRejectedResult).reason));
    assert.equal((await roster(pool, slotIds[0]!)).confirmed.length, 2, 'both claimers end up confirmed once capacity is 2');
  }
});

test('W10: the import holds app_state, replaces only sheets nobody signed up on themselves, and keeps the waiting order', async () => {
  const plan: ImportPlan = {
    replace: false,
    group: { groupName: 'U9 Tigers', organizerName: 'Mike', organizerContact: '', duesLabel: 'Season dues', duesAmountCents: 4000 },
    people: [
      { key: 'mike-family', existingId: null, name: 'The Mike family', contact: '', paid: true, paidAmountCents: 4000, paidNote: 'cash', },
      { key: 'crew', existingId: null, name: "Frank's crew", contact: '', paid: false, paidAmountCents: null, paidNote: '' },
      { key: 'frank-family', existingId: null, name: 'The Frank family', contact: '', paid: false, paidAmountCents: null, paidNote: '' }
    ],
    sheets: [
      {
        slug: 'imported', title: 'Snack sign-up', description: '', timezone: 'America/Los_Angeles', place: '', names: 'full', noteLabel: '',
        noteRequired: false, listed: true, status: 'open',
        dates: [{ onDate: dayFromToday(10), startsAt: '09:00', endsAt: '10:30', label: '', place: '', slots: [{ label: 'Snacks', description: '', capacity: 1 }] }],
        signups: [
          { date: 0, slot: 0, person: 'frank-family', note: '', status: 'waiting' },
          { date: 0, slot: 0, person: 'crew', note: '', status: 'waiting' },
          { date: 0, slot: 0, person: 'mike-family', note: 'Oranges', status: 'confirmed' }
        ]
      }
    ]
  };
  const done = await applyImport(pool, plan, organizer());
  assert.deepEqual(done, { kind: 'imported', counts: { people: 3, sheets: 1, dates: 1, slots: 1, signups: 3 }, replaced: [], removing: 0, kept: [] });
  const slot = (await pool.query<{ id: string }>("select s.id from slots s join sheets h on h.id = s.sheet_id where h.slug = 'imported'")).rows[0]!.id;
  assert.deepEqual(await roster(pool, slot), { confirmed: ['The Mike family'], waiting: ['The Frank family', "Frank's crew"] });
  assert.equal(await count(pool, "select count(*) from people where added_by = 'import' and token_hash is null"), 3, 'imported people have no link');

  assert.deepEqual(await applyImport(pool, plan, organizer()), { kind: 'refused', reason: 'exists', slug: 'imported' });
  await claim(pool, settings, claimFor('imported', slot, 'Self-made'), member());
  assert.deepEqual(await applyImport(pool, { ...plan, replace: true }, organizer()), { kind: 'refused', reason: 'member-signups', slug: 'imported' });
  const mikeFamily = (await pool.query<{ id: string }>("select id from people where name = 'The Mike family'")).rows[0]!.id;
  const renamed = { ...plan, sheets: [], people: [{ ...plan.people[0]!, existingId: mikeFamily, name: 'Someone else' }] };
  assert.deepEqual(await applyImport(pool, renamed, organizer()), { kind: 'refused', reason: 'person', key: 'mike-family' });
});

test('W10 against claims, a removal and a second import at once (5 rounds): no deadlock, imports one at a time', async () => {
  for (let round = 0; round < 5; round += 1) {
    const slug = `busy-${round}`;
    const { slotIds } = await sheetWithSlots(pool, { slug, capacities: [2] });
    const target = await personWithLink(pool, `Target ${round}`);
    await pool.query("insert into signups (slot_id, person_id, status, added_by) values ($1, $2, 'confirmed', 'member')", [slotIds[0], target.id]);
    const plan = (n: number): ImportPlan => ({
      replace: true,
      group: null,
      people: [{ key: 'target', existingId: target.id, name: `Target ${round}`, contact: '', paid: false, paidAmountCents: null, paidNote: '' }],
      sheets: [
        {
          slug: `import-${round}-${n}`, title: 'Imported', description: '', timezone: 'America/Los_Angeles', place: '', names: 'full', noteLabel: '',
          noteRequired: false, listed: false, status: 'open',
          dates: [{ onDate: dayFromToday(12), startsAt: null, endsAt: null, label: '', place: '', slots: [{ label: 'Snacks', description: '', capacity: 1 }] }],
          signups: [{ date: 0, slot: 0, person: 'target', note: '', status: 'confirmed' }]
        }
      ]
    });
    const ready = barrier(4);
    const results = await Promise.allSettled([
      ready().then(() => applyImport(pools[0]!, plan(1), organizer())),
      ready().then(() => applyImport(pools[1]!, plan(2), organizer())),
      ready().then(() => claim(pools[2]!, settings, claimFor(slug, slotIds[0]!, 'Claimer'), member())),
      ready().then(() => removePersonEverywhere(pools[2]!, target.id, organizer()))
    ]);
    for (const result of results) {
      if (result.status === 'rejected') assert.ok(isDbError(result.reason, '23503'), `only a missing person may stop an import: ${String(result.reason)}`);
    }
    assert.ok(!results.some((result) => result.status === 'rejected' && isDbError(result.reason, '40P01')));
  }
});

test('a structural change holds new claims off until it commits, and the claim then decides on what it committed', async () => {
  const { dateId, slotIds } = await sheetWithSlots(pool, { slug: 'held-off', capacities: [1] });
  const change = await pool.connect();
  try {
    await change.query('begin');
    await change.query("select id from sheets where slug = 'held-off' for update");
    await change.query('update dates set cancelled_at = now() where id = $1', [dateId]);
    const waiting = claim(pools[1]!, settings, claimFor('held-off', slotIds[0]!, 'Hopeful'), member());
    await waitFor(async () => (await lockWaits()) > 0, 'the claim to wait for the sheet');
    await change.query('commit');
    assert.deepEqual(await waiting, { kind: 'refused', reason: 'cancelled', slug: 'held-off' });
  } finally {
    change.release();
  }
  await inTransaction(pool, async (tx) => {
    await tx.query('update dates set cancelled_at = null where id = $1', [dateId]);
  });
});
