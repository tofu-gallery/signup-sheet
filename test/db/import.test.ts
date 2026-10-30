// W10, the import, and the export on a real database: every refusal leaves every row as it was (also after the plan
// named a sheet to replace), a dry run writes nothing at all, a sheet made while an import waits is decided on again,
// and an export restores into a fresh copy, cancelled dates, waitlists, paid state, notes and each sign-up's time and
// history included, without taking any person id in it for someone already there (a restored sign-up a member made
// still refuses a replace); at the import's own limits, the export route's bytes go through the import route whole.
// Direct calls of the functions and route handlers; not HTTP tests.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, afterEach, before, test } from 'node:test';
import type pg from 'pg';
import { takeSeat } from '../../src/lib/access';
import { checkCaps } from '../../src/lib/caps';
import { type ExportFile, exportCopy } from '../../src/lib/exporter';
import { FILE_LIMITS } from '../../src/lib/import-format';
import { applyImport, type ImportPlan, previewImport, runImport } from '../../src/lib/importer';
import { addPerson, editPerson, setPaid } from '../../src/lib/people';
import { IMPORT_LIMIT_BYTES } from '../../src/lib/request';
import { readSettings, type Settings } from '../../src/lib/settings';
import { cancelSignup, claim, markTold } from '../../src/lib/signups';
import { createSheet, saveSettings, setDateCancelled } from '../../src/lib/structure';
import { newRequestId, sha256 } from '../../src/lib/tokens';
import { myCalendarEntry } from '../../src/lib/views';
import { poolFor, waitFor } from '../support/fixtures';
import {
  assertCountsConsistent,
  count,
  dateWithSlots,
  dayFromToday,
  endRoutePool,
  get,
  jsonPost,
  member,
  organizer,
  params,
  roster,
  sheetWithSlots,
  snapshot,
  useDatabase
} from '../support/core';
import { realRoutes } from '../support/probes';
import { type Cluster, REPO, startCluster } from '../support/postgres';

let cluster: Cluster;
let url: string;
let pool: pg.Pool;
let other: pg.Pool;
let settings: Settings;
const extra: pg.Pool[] = [];

before(async () => {
  cluster = await startCluster();
  url = await cluster.createDatabase({ migrated: true });
  pool = poolFor(url);
  other = poolFor(url);
  settings = readSettings({ DATABASE_URL: url });
});

afterEach(async () => assertCountsConsistent(pool));

after(async () => {
  await endRoutePool();
  await Promise.all([pool, other, ...extra].filter(Boolean).map((each) => each.end()));
  await cluster?.stop();
});

async function freshPool(): Promise<pg.Pool> {
  const fresh = poolFor(await cluster.createDatabase({ migrated: true }));
  extra.push(fresh);
  return fresh;
}

const example = (name: string) => readFileSync(join(REPO, 'examples', `${name}.json`), 'utf8');

function snacks(slug: string, people: ImportPlan['people'], replace = false): ImportPlan {
  return {
    replace,
    group: { groupName: 'U9 Tigers', organizerName: 'Mike', organizerContact: '', duesLabel: 'Season dues', duesAmountCents: 4000 },
    people,
    sheets: [
      {
        slug, title: 'Snack sign-up', description: '', timezone: 'America/Los_Angeles', place: '', names: 'full', noteLabel: '',
        noteRequired: false, listed: true, status: 'open',
        dates: [{ onDate: dayFromToday(10), startsAt: '09:00', endsAt: '10:30', label: '', place: '', slots: [{ label: 'Snacks', description: '', capacity: 1 }] }],
        signups: people.length > 0 ? [{ date: 0, slot: 0, person: people[0]!.key, note: '', status: 'confirmed' }] : []
      }
    ]
  };
}

const mikeFamily = (existingId: string | null = null, name = 'The Mike family'): ImportPlan['people'][number] => ({
  key: 'mike-family', existingId, name, contact: '', paid: false, paidAmountCents: null, paidNote: ''
});

const sequences = async (db: pg.Pool) =>
  (
    await db.query(
      `select (select last_value from people_id_seq) as people, (select last_value from sheets_id_seq) as sheets,
              (select last_value from dates_id_seq) as dates, (select last_value from slots_id_seq) as slots,
              (select last_value from signups_id_seq) as signups, (select last_value from activity_id_seq) as activity`
    )
  ).rows[0];

test('a replacing import refused for a person it names by id changes nothing: the old sheet, people, sign-ups, group and activity stay', async () => {
  assert.equal((await applyImport(pool, snacks('atomic', [mikeFamily()]), organizer())).kind, 'imported');
  const mikeFamilyId = (await pool.query<{ id: string }>("select id from people where name = 'The Mike family'")).rows[0]!.id;
  await pool.query("update app_state set group_name = 'Before'");
  const before = await snapshot(pool);

  const missing = { ...snacks('atomic', [mikeFamily('999999999')], true), group: { ...snacks('x', []).group!, groupName: 'After' } };
  assert.deepEqual(await applyImport(pool, missing, organizer()), { kind: 'refused', reason: 'person', key: 'mike-family' });
  assert.deepEqual(await snapshot(pool), before, 'a person id that names nobody: nothing changed');

  const renamed = { ...snacks('atomic', [mikeFamily(mikeFamilyId, 'Someone else')], true), group: { ...snacks('x', []).group!, groupName: 'After' } };
  assert.deepEqual(await applyImport(pool, renamed, organizer()), { kind: 'refused', reason: 'person', key: 'mike-family' });
  assert.deepEqual(await snapshot(pool), before, 'a person id whose name differs: nothing changed');
  assert.deepEqual(await previewImport(pool, renamed), { kind: 'refused', reason: 'person', key: 'mike-family' }, 'the dry run finds the same');
});

test('every other refusal found in the database leaves everything as it was too: an existing sheet, sign-ups people made, a form used twice', async () => {
  await applyImport(pool, snacks('kept', []), organizer());
  const before = await snapshot(pool);
  assert.deepEqual(await applyImport(pool, snacks('kept', [mikeFamily()]), organizer()), { kind: 'refused', reason: 'exists', slug: 'kept' });
  assert.deepEqual(await snapshot(pool), before);

  const slot = (await pool.query<{ id: string }>("select s.id from slots s join sheets h on h.id = s.sheet_id where h.slug = 'kept'")).rows[0]!.id;
  await claim(pool, settings, { slug: 'kept', slotId: slot, requestId: newRequestId(), who: { kind: 'new', name: 'Self-made', contact: '' }, note: '', rules: 'member' }, member());
  const withClaim = await snapshot(pool);
  assert.deepEqual(await applyImport(pool, snacks('kept', [mikeFamily()], true), organizer()), { kind: 'refused', reason: 'member-signups', slug: 'kept' });
  assert.deepEqual(await snapshot(pool), withClaim);

  const requestHash = sha256(newRequestId());
  assert.equal((await applyImport(pool, { replace: false, group: null, people: [mikeFamily()], sheets: [] }, organizer(), { requestHash })).kind, 'imported');
  const once = await snapshot(pool);
  assert.deepEqual(await applyImport(pool, { replace: false, group: null, people: [mikeFamily()], sheets: [] }, organizer(), { requestHash }), { kind: 'refused', reason: 'repeated' });
  assert.deepEqual(await snapshot(pool), once, 'the same form again added nobody');
});

test("the row caps: an import that would pass one is refused whole; one that replaces enough rows fits, and the dry run counts the same", async () => {
  const full = await freshPool();
  await full.query("insert into sheets (slug, title) select 'sheet-' || n, 'Sheet ' || n from generate_series(1, 50) n");
  const before = await snapshot(full);
  const one = snacks('fifty-first', [mikeFamily()]);
  assert.deepEqual(await previewImport(full, one), { kind: 'refused', reason: 'cap', table: 'sheets' });
  assert.deepEqual(await applyImport(full, one, organizer()), { kind: 'refused', reason: 'cap', table: 'sheets' });
  assert.deepEqual(await snapshot(full), before);
  const outcome = await runImport(full, JSON.stringify({ format: 'signup-sheet/1', sheets: [{ slug: 'fifty-first', title: 'X', timezone: 'America/New_York', dates: [] }] }), { dryRun: true, ctx: organizer() });
  assert.deepEqual(outcome, { ok: false, error: 'This app can hold at most 50 sheets, and this file would take it past that. Nothing was imported.', path: null });

  const replacing = snacks('sheet-1', [mikeFamily()], true);
  assert.deepEqual(await previewImport(full, replacing), { kind: 'checked', counts: { people: 1, sheets: 1, dates: 1, slots: 1, signups: 1 }, replaced: ['sheet-1'], removing: 0, kept: [] });
  assert.equal((await applyImport(full, replacing, organizer())).kind, 'imported');
  assert.equal(await count(full, 'select count(*) from sheets'), 50);
});

test('a dry run writes nothing at all: no row, no activity, not even an identity value used up', async () => {
  const before = await snapshot(pool);
  const used = await sequences(pool);
  const outcome = await runImport(pool, example('soccer'), { dryRun: null, ctx: organizer() });
  assert.deepEqual(outcome, {
    ok: true,
    dryRun: true,
    summary:
      "Would make: 1 sheet (Snack sign-up, draft) · 7 dates: Sat, Nov 14 … Sat, Dec 26 · 7 places · 2 people · 2 sign-ups: Mike's family Sat, Nov 14; Frank's family Sat, Nov 21 · group name: U9 Tigers · organizer: Mike · dues: Season dues $40.00 · imported people have no private link until you make one",
    counts: { people: 2, sheets: 1, dates: 7, slots: 7, signups: 2 }
  });
  assert.deepEqual(await snapshot(pool), before);
  assert.deepEqual(await sequences(pool), used);
});

test('a refused file says what is wrong in one sentence ending "Nothing was imported.", names the field, and writes nothing', async () => {
  const before = await snapshot(pool);
  const file = JSON.parse(example('soccer'));
  file.sheets[0].dates[1] = { date: '2026-11-08', weekday: 'Sat' };
  assert.deepEqual(await runImport(pool, JSON.stringify(file), { dryRun: false, ctx: organizer() }), {
    ok: false,
    error: '2026-11-08 is a Sunday, but the file says Sat. Nothing was imported.',
    path: 'sheets[0].dates[1].weekday'
  });
  assert.deepEqual(await snapshot(pool), before);
});

test('the examples import: soccer with its roster and dues, the potluck that asks what you bring, and a dues-only roster', async () => {
  const fresh = await freshPool();
  const soccer = await runImport(fresh, example('soccer'), { dryRun: false, ctx: organizer() });
  assert.ok(soccer.ok && soccer.summary.startsWith('Imported: 1 sheet (Snack sign-up, draft)'), JSON.stringify(soccer));
  const potluck = await runImport(fresh, example('potluck'), { dryRun: null, ctx: organizer() });
  assert.ok(potluck.ok && !potluck.dryRun, JSON.stringify(potluck));
  // A second file into a copy in use: the group settings it changes read as changes, not as the new sheet's own. Its
  // organizer has no contact, so the one saved goes, and the summary says so (without writing the contact out).
  assert.ok(
    potluck.summary.endsWith(
      " · changes the group name from U9 Tigers to Maple Street neighbors on every sheet · changes the organizer from Mike to Frank on every sheet · removes the organizer's email or phone · turns off the dues (Season dues $40.00): the paid list is hidden"
    ),
    potluck.summary
  );
  assert.deepEqual((await fresh.query('select organizer_name, organizer_contact from app_state')).rows[0], { organizer_name: 'Frank', organizer_contact: '' });
  const dues = await runImport(fresh, example('dues'), { dryRun: null, ctx: organizer() });
  assert.deepEqual(dues.ok && dues.counts, { people: 2, sheets: 0, dates: 0, slots: 0, signups: 0 });
  assert.ok(dues.ok && !dues.summary.includes("organizer's email or phone"), 'a contact given where there was none is no change');
  const otherContact = JSON.stringify({ format: 'signup-sheet/1', group: { organizer: { name: 'Mike', contact: 'frank@example.test' } } });
  const changed = await runImport(fresh, otherContact, { dryRun: true, ctx: organizer() });
  assert.ok(changed.ok && changed.summary.includes(" · changes the organizer's email or phone") && !/example\.test|trytofu/.test(changed.summary), JSON.stringify(changed));
  assert.deepEqual((await fresh.query('select group_name, dues_label, dues_amount_cents from app_state')).rows[0], {
    group_name: 'Thursday chess club',
    dues_label: 'Season dues',
    dues_amount_cents: 4000
  });
  assert.equal(await count(fresh, "select count(*) from people where name = 'Mike''s family' and paid and paid_amount_cents = 4000"), 2);
  assert.equal(await count(fresh, 'select count(*) from people where token_hash is not null'), 0, 'imported people have no link');
  assert.deepEqual((await fresh.query("select note_label, note_required from sheets where slug = 'potluck'")).rows[0], { note_label: "What you'll bring", note_required: true });
  assert.equal(await count(fresh, "select count(*) from activity where kind = 'import' and actor = 'organizer'"), 3);
  await assertCountsConsistent(fresh);
});

test("a sheet with the file's slug made while the import waits for the row caps' lock: the import starts again and decides on it", async () => {
  const lockWaits = () => count(pool, "select count(*) from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()");
  const madeMeanwhile = async (slug: string, plan: ImportPlan) => {
    const holder = await pool.connect();
    try {
      await holder.query('begin');
      await checkCaps(holder, { sheets: 1 });
      await holder.query("insert into sheets (slug, title) values ($1, 'Made meanwhile')", [slug]);
      const importing = applyImport(other, plan, organizer());
      await waitFor(async () => (await lockWaits()) > 0, 'the import to wait for the row caps');
      await holder.query('commit');
      return await importing;
    } finally {
      holder.release();
    }
  };
  // Not replacing: refused as for a sheet already here, and nothing of the file is written.
  const people = await count(pool, 'select count(*) from people');
  assert.deepEqual(await madeMeanwhile('appears', snacks('appears', [mikeFamily()])), { kind: 'refused', reason: 'exists', slug: 'appears' });
  assert.deepEqual((await pool.query("select title from sheets where slug = 'appears'")).rows, [{ title: 'Made meanwhile' }]);
  assert.equal(await count(pool, 'select count(*) from people'), people);
  // Replacing: the sheet made meanwhile is replaced, as one already here would have been.
  assert.deepEqual(await madeMeanwhile('appears-replaced', snacks('appears-replaced', [], true)), {
    kind: 'imported',
    counts: { people: 0, sheets: 1, dates: 1, slots: 1, signups: 0 },
    replaced: ['appears-replaced'],
    removing: 0,
    kept: []
  });
  assert.deepEqual((await pool.query("select title from sheets where slug = 'appears-replaced'")).rows, [{ title: 'Snack sign-up' }]);
});

/**
 * An export without what only says where it came from: ids, keys (people by name) and link flags. Each sign-up's time,
 * who added it, when it moved up and whether its person was told are compared: an import of an export restores them.
 */
function restorable(file: ExportFile, leaveOut: string[] = []) {
  const names = new Map(file.people.map((person) => [person.key, person.name]));
  return {
    format: file.format,
    group: file.group,
    people: file.people.filter((person) => !leaveOut.includes(person.name)).map(({ key: _key, id: _id, hasLink: _link, ...person }) => person),
    sheets: file.sheets.map(({ id: _id, signups, ...sheet }) => ({
      ...sheet,
      signups: signups.map(({ person, ...signup }) => ({ ...signup, person: names.get(person) }))
    }))
  };
}

test('T25: an export restores into a fresh copy (cancelled dates, waitlists in order, paid state, notes, settings), and its ids match nobody there', async () => {
  const sourceUrl = await cluster.createDatabase({ migrated: true });
  const source = poolFor(sourceUrl);
  extra.push(source);
  const sourceSettings = readSettings({ DATABASE_URL: sourceUrl });
  await saveSettings(source, { groupName: 'U9 Tigers', organizerName: 'Mike', organizerContact: 'hello@trytofu.ai', duesLabel: 'Season dues', duesAmountCents: 4000 }, organizer());

  const a = await sheetWithSlots(source, { slug: 'snacks', capacities: [1, 2] });
  await source.query("update sheets set note_label = 'What you''ll bring', place = 'Lincoln Park, Field 3', description = 'Fruit and water,\nfor 12' where id = $1", [a.sheetId]);
  const later = await dateWithSlots(source, a.sheetId, dayFromToday(17), [1]);
  await source.query("update dates set starts_at = null, ends_at = null, label = 'Tournament', place = 'Field 9' where id = $1", [later.dateId]);
  const rained = await dateWithSlots(source, a.sheetId, dayFromToday(24), [1]);

  const join = (slotId: string, name: string, contact: string, note = '') =>
    claim(source, sourceSettings, { slug: 'snacks', slotId, requestId: newRequestId(), who: { kind: 'new', name, contact }, note, rules: 'member' }, member());
  const add = (slotId: string, personId: string, note = '') =>
    claim(source, sourceSettings, { slug: null, slotId, requestId: newRequestId(), who: { kind: 'person', personId }, note, rules: 'organizer' }, organizer());
  const mike = await join(a.slotIds[0]!, "Mike's family", 'hello@trytofu.ai', 'Oranges');
  const frank = await join(a.slotIds[0]!, "Frank's family", '(415) 555-0134');
  const third = await join(a.slotIds[0]!, 'Third family', '');
  assert.ok(mike.kind === 'signed-up' && frank.kind === 'signed-up' && third.kind === 'signed-up');
  assert.deepEqual([mike.status, frank.status, third.status], ['confirmed', 'waiting', 'waiting']);
  await add(a.slotIds[1]!, frank.personId, 'Van, 6 seats');
  const mikeLater = await add(later.slotIds[0]!, mike.personId);
  await add(rained.slotIds[0]!, mike.personId, 'Rain plan');
  await setDateCancelled(source, { dateId: rained.dateId, cancelled: true }, organizer());
  // Sign-up history: on `later`, Third family waits behind Mike's family and moves up when the organizer removes Mike's
  // family (not told yet); on a fourth date, Frank's family waits behind Mike's family, moves up the same way, and is
  // marked told.
  const thirdLater = await add(later.slotIds[0]!, third.personId);
  assert.ok(mikeLater.kind === 'signed-up' && thirdLater.kind === 'signed-up' && thirdLater.status === 'waiting');
  assert.equal((await cancelSignup(source, { signupId: mikeLater.signupId, owner: null }, organizer())).kind, 'cancelled');
  const fourth = await dateWithSlots(source, a.sheetId, dayFromToday(31), [1]);
  const mikeFourth = await add(fourth.slotIds[0]!, mike.personId);
  const frankFourth = await add(fourth.slotIds[0]!, frank.personId);
  assert.ok(mikeFourth.kind === 'signed-up' && frankFourth.kind === 'signed-up' && frankFourth.status === 'waiting');
  assert.equal((await cancelSignup(source, { signupId: mikeFourth.signupId, owner: null }, organizer())).kind, 'cancelled');
  assert.equal((await markTold(source, { signupId: frankFourth.signupId, told: true }, organizer())).kind, 'saved');
  const rosterOnly = await addPerson(source, { name: 'Roster only', contact: 'roster@example.com' }, organizer());
  await setPaid(source, { personId: rosterOnly.personId, paid: true, amountCents: 4000, note: 'cash Oct 30' }, organizer());
  await setPaid(source, { personId: frank.personId, paid: false, amountCents: null, note: 'owes' }, organizer());

  // A closed, unlisted sheet that hides names and asks for a note, on a date that has started: someone waits beside a
  // free place (a cancel after the start moves nobody up), and the organizer added someone without a note.
  const b = await sheetWithSlots(source, { slug: 'pantry', capacities: [2], onDate: dayFromToday(-3), names: 'taken', noteRequired: true });
  await source.query("update sheets set status = 'closed', listed = false, timezone = 'America/New_York', note_label = 'Shift' where id = $1", [b.sheetId]);
  await source.query("insert into signups (slot_id, person_id, status, note, added_by) values ($1, $2, 'confirmed', '', 'organizer')", [b.slotIds[0], mike.personId]);
  await source.query("insert into signups (slot_id, person_id, status, note, added_by) values ($1, $2, 'waiting', 'If needed', 'member')", [b.slotIds[0], third.personId]);
  await createSheet(source, { slug: 'next-season', title: 'Next season', description: '', timezone: 'America/Chicago', place: '', names: 'full', noteLabel: '', noteRequired: false, listed: true, status: 'draft' }, organizer());

  const first = await exportCopy(source);
  const text = JSON.stringify(first);
  assert.ok(mike.token && !text.includes(mike.token), 'no link token');
  for (const hash of (await source.query<{ hash: Buffer }>('select token_hash as hash from people where token_hash is not null')).rows) {
    assert.ok(!text.includes(hash.hash.toString('hex')) && !text.includes(hash.hash.toString('base64')) && !text.includes(hash.hash.toString('base64url')), 'no hash');
  }
  assert.deepEqual(first.people.map((person) => [person.name, person.hasLink]), [["Mike's family", true], ["Frank's family", true], ['Third family', true], ['Roster only', false]]);
  assert.equal(first.sheets[0]!.dates[2]!.cancelled, true);

  // The fresh copy already has a person with id 1, the id Mike's family has in the file.
  const fresh = await freshPool();
  await fresh.query("insert into people (name, contact, added_by) values ('Someone else', 'someone@example.com', 'organizer')");
  const someone = (await fresh.query('select * from people')).rows;
  assert.equal(String(first.people[0]!.id), String(someone[0].id));
  const outcome = await runImport(fresh, text, { dryRun: null, ctx: organizer() });
  assert.ok(outcome.ok && !outcome.dryRun, JSON.stringify(outcome));
  assert.ok(outcome.summary.includes('from an export of'), outcome.summary);
  assert.deepEqual((await fresh.query("select * from people where name = 'Someone else'")).rows, someone, 'the person already there is untouched');
  assert.equal(await count(fresh, "select count(*) from people where name = 'Mike''s family' and id <> $1", [someone[0].id]), 1, 'a new person');
  assert.equal(await count(fresh, 'select count(*) from people where token_hash is not null'), 0);

  const second = await exportCopy(fresh);
  assert.deepEqual(restorable(second, ['Someone else']), restorable(first));
  const slot = (await fresh.query<{ id: string }>("select s.id from slots s join dates d on d.id = s.date_id join sheets h on h.id = s.sheet_id where h.slug = 'snacks' order by d.on_date, s.position limit 1")).rows[0]!.id;
  assert.deepEqual(await roster(fresh, slot), { confirmed: ["Mike's family"], waiting: ["Frank's family", 'Third family'] });
  await assertCountsConsistent(fresh);

  // The history came back: who added each sign-up, the person moved up (and not told) back in Needs attention, the one
  // told not; told at the export's own time.
  assert.deepEqual(
    (await fresh.query("select added_by, count(*)::int as n from signups group by added_by order by added_by")).rows,
    (await source.query("select added_by, count(*)::int as n from signups group by added_by order by added_by")).rows
  );
  assert.deepEqual(
    (await fresh.query<{ name: string }>('select p.name from signups g join people p on p.id = g.person_id where g.promoted_at is not null and g.told_at is null')).rows,
    [{ name: 'Third family' }]
  );
  assert.deepEqual(
    (await fresh.query('select told_at from signups where told_at is not null')).rows,
    [{ told_at: new Date(first.exportedAt) }]
  );

  // Importing it once more is refused (its sheets are there now), and nothing changes.
  const restored = await snapshot(fresh);
  const again = await runImport(fresh, text, { dryRun: null, ctx: organizer() });
  assert.equal(again.ok, false);
  assert.deepEqual(await snapshot(fresh), restored);
});

test("an export's signedUpAt comes back as the sign-up's time, and its move up and told with it, none later than the import; the calendar file's SEQUENCE counts from it and only grows", async () => {
  const fresh = await freshPool();
  const day = dayFromToday(12);
  const ahead = new Date(Date.now() + 3 * 60_000).toISOString();
  const file = {
    format: 'signup-sheet/1',
    // Another copy's clock, a few minutes ahead of this one: a sign-up it lists as told is told at this time.
    exportedAt: ahead,
    people: [{ key: 'p1', id: 1, name: "Mike's family" }, { key: 'p2', id: 2, name: "Frank's family" }],
    sheets: [
      {
        slug: 'restored-times',
        title: 'Snack sign-up',
        timezone: 'America/Los_Angeles',
        status: 'open',
        dates: [{ date: day, start: '09:00', slots: [{ label: 'Snacks', capacity: 2 }] }],
        signups: [
          // The oldest time a file may give, and one a few minutes ahead of this clock (another copy's), moved up and
          // told by then too.
          { date: day, slot: 'Snacks', person: 'p1', addedBy: 'member', signedUpAt: '2000-01-01T00:00:00.000Z', promotedAt: null, told: false },
          { date: day, slot: 'Snacks', person: 'p2', addedBy: 'member', signedUpAt: ahead, promotedAt: ahead, told: true }
        ]
      }
    ]
  };
  const outcome = await runImport(fresh, JSON.stringify(file), { dryRun: false, ctx: organizer() });
  assert.ok(outcome.ok, JSON.stringify(outcome));
  const times = async () =>
    new Map(
      (await fresh.query<{ name: string; id: string; personId: string; createdAt: Date; promotedAt: Date | null; toldAt: Date | null }>(
        `select p.name, g.id, p.id as "personId", g.created_at as "createdAt", g.promoted_at as "promotedAt", g.told_at as "toldAt"
           from signups g join people p on p.id = g.person_id`
      )).rows.map((row) => [row.name, row])
    );
  const restored = await times();
  const mike = restored.get("Mike's family")!;
  assert.equal(mike.createdAt.toISOString(), '2000-01-01T00:00:00.000Z', 'the time it was first made');
  assert.deepEqual([mike.promotedAt, mike.toldAt], [null, null], 'never moved up and not told: still neither');
  // A move up later than the import would hold SEQUENCE still through a change made before that moment (views.ts).
  const frank = restored.get("Frank's family")!;
  for (const [what, at] of [['made', frank.createdAt], ['moved up', frank.promotedAt], ['told', frank.toldAt]] as const) {
    assert.ok(at && at.getTime() <= Date.now() && at.toISOString() < ahead, `${what}: ${at?.toISOString()} is no later than the import`);
  }

  // SEQUENCE: whole seconds from that time, never negative, within an int (the query casts it), and it grows when what
  // the event shows changes. Everything the event reads but the sign-up's own time moves a day back first, so a change
  // now is a day later than any of it.
  const sequence = async (name: string) => {
    const row = restored.get(name)!;
    const entry = await myCalendarEntry(fresh, row.personId, row.id);
    assert.ok(entry && Number.isInteger(entry.sequence) && entry.sequence >= 0 && entry.sequence < 2 ** 31, `${name}: ${entry?.sequence}`);
    return entry.sequence;
  };
  await sequence("Frank's family");
  for (const sql of [
    "update signups set queued_at = queued_at - interval '1 day', revised_at = revised_at - interval '1 day'",
    "update slots set revised_at = revised_at - interval '1 day'",
    "update dates set revised_at = revised_at - interval '1 day'",
    "update sheets set revised_at = revised_at - interval '1 day'",
    "update people set revised_at = revised_at - interval '1 day'",
    "update app_state set revised_at = revised_at - interval '1 day'"
  ]) {
    await fresh.query(sql);
  }
  const before = await sequence("Mike's family");
  assert.ok(before > 26 * 365 * 86_400, `counted from 2000: ${before}`);
  await editPerson(fresh, { personId: restored.get("Mike's family")!.personId, name: "Mike's family (Oranges)", contact: '' }, organizer());
  const after = await sequence("Mike's family");
  assert.ok(after >= before + 86_000, `${before} then ${after}`);
  assert.equal((await times()).get("Mike's family (Oranges)")!.createdAt.toISOString(), '2000-01-01T00:00:00.000Z', 'the time itself never changes');
});

test('a restored sign-up a member made keeps the replace protection; the same file imported as an ordinary one (no exportedAt) does not', async () => {
  const sourceUrl = await cluster.createDatabase({ migrated: true });
  const source = poolFor(sourceUrl);
  extra.push(source);
  const { slotIds } = await sheetWithSlots(source, { slug: 'kept', capacities: [2] });
  const made = await claim(
    source,
    readSettings({ DATABASE_URL: sourceUrl }),
    { slug: 'kept', slotId: slotIds[0]!, requestId: newRequestId(), who: { kind: 'new', name: "Mike's family", contact: '' }, note: '', rules: 'member' },
    member()
  );
  assert.equal(made.kind, 'signed-up');
  const text = JSON.stringify(await exportCopy(source));
  const replacing = JSON.stringify({ format: 'signup-sheet/1', replace: true, sheets: [{ slug: 'kept', title: 'Replaced', timezone: 'America/Los_Angeles', dates: [] }] });

  // Restored, the sign-up is still one a member made: replacing its sheet is refused, as it is in the copy it came from,
  // and nothing changes.
  const fresh = await freshPool();
  assert.equal((await runImport(fresh, text, { dryRun: false, ctx: organizer() })).ok, true);
  assert.equal(await count(fresh, "select count(*) from signups where added_by = 'member'"), 1);
  const before = await snapshot(fresh);
  assert.deepEqual(await runImport(fresh, replacing, { dryRun: false, ctx: organizer() }), {
    ok: false,
    error: 'The sheet "kept" has sign-ups people made themselves, so it can\'t be replaced. Nothing was imported.',
    path: 'sheets[0]'
  });
  assert.deepEqual(await snapshot(fresh), before);

  // The control: the same file without `exportedAt` (and without the person ids, which an ordinary file would take for
  // people already here) is an ordinary import. Its history fields are read and ignored, the sign-up counts as
  // imported, and the replace goes ahead.
  const ordinary = JSON.parse(text) as { exportedAt?: string; people: { id?: unknown }[] };
  delete ordinary.exportedAt;
  for (const person of ordinary.people) delete person.id;
  const other = await freshPool();
  assert.equal((await runImport(other, JSON.stringify(ordinary), { dryRun: false, ctx: organizer() })).ok, true);
  assert.deepEqual((await other.query('select added_by, promoted_at, told_at from signups')).rows, [{ added_by: 'import', promoted_at: null, told_at: null }]);
  assert.equal((await runImport(other, replacing, { dryRun: false, ctx: organizer() })).ok, true);
  assert.equal(await count(other, 'select count(*) from signups'), 0);
});

test("a replace's summary says how many sign-ups go with the sheets it replaces, in the dry run and once imported", async () => {
  const day = dayFromToday(12);
  const file = (replace: boolean) =>
    JSON.stringify({
      format: 'signup-sheet/1',
      replace,
      people: [{ key: 'mike-family', name: 'The Mike family' }, { key: 'frank-family', name: 'The Frank family' }],
      sheets: [
        {
          slug: 'counted',
          title: 'Counted',
          timezone: 'America/Los_Angeles',
          dates: [{ date: day, slots: [{ label: 'Snacks', capacity: 2 }] }],
          signups: [{ date: day, slot: 'Snacks', person: 'mike-family' }, { date: day, slot: 'Snacks', person: 'frank-family' }]
        }
      ]
    });
  assert.equal((await runImport(pool, file(false), { dryRun: false, ctx: organizer() })).ok, true);
  const before = await snapshot(pool);
  const checked = await runImport(pool, file(true), { dryRun: true, ctx: organizer() });
  assert.ok(checked.ok && checked.summary.startsWith('Would make:') && checked.summary.includes(' · replaces: counted and its 2 sign-ups'), JSON.stringify(checked));
  assert.deepEqual(await snapshot(pool), before, 'the dry run removed nothing');
  const done = await runImport(pool, file(true), { dryRun: false, ctx: organizer() });
  assert.ok(done.ok && done.summary.startsWith('Imported:') && done.summary.includes(' · replaces: counted and its 2 sign-ups'), JSON.stringify(done));
});

/**
 * A copy at the import's own limits for people and sign-ups (FILE_LIMITS: 500 and 2,000), with ordinary names,
 * contacts, paid state and notes: two sheets of 25 weekly dates with 8 places each, every place full, one of them with
 * someone waiting.
 */
function atTheLimits(): ImportPlan {
  const people: ImportPlan['people'] = Array.from({ length: FILE_LIMITS.people }, (_, i) => ({
    key: `p${i}`,
    existingId: null,
    name: `Family ${String(i + 1).padStart(3, '0')}`,
    contact: `family${i + 1}@example.com`,
    paid: i % 2 === 0,
    paidAmountCents: i % 2 === 0 ? 4000 : null,
    paidNote: i % 10 === 0 ? 'cash at practice' : ''
  }));
  let next = 0;
  const sheets: ImportPlan['sheets'] = [0, 1].map((s) => {
    const dates = Array.from({ length: 25 }, (_, d) => ({
      onDate: dayFromToday(7 + s + 7 * d),
      startsAt: '09:00',
      endsAt: '10:30',
      label: '',
      place: '',
      slots: Array.from({ length: 8 }, (_, t) => ({ label: `Slot ${t + 1}`, description: '', capacity: t === 7 ? 4 : 5 }))
    }));
    const signups: ImportPlan['sheets'][number]['signups'] = [];
    for (const [d] of dates.entries()) {
      for (let t = 0; t < 8; t += 1) {
        for (let c = 0; c < 5; c += 1) {
          signups.push({ date: d, slot: t, person: `p${next % FILE_LIMITS.people}`, note: next % 3 === 0 ? 'Bringing oranges' : '', status: t === 7 && c === 4 ? 'waiting' : 'confirmed' });
          next += 1;
        }
      }
    }
    return {
      slug: `limits-${s + 1}`, title: `Season ${s + 1}`, description: '', timezone: 'America/Los_Angeles', place: '',
      names: s === 0 ? 'full' : 'taken', noteLabel: s === 0 ? '' : "What you'll bring", noteRequired: false, listed: true, status: 'open',
      dates, signups
    };
  });
  return {
    replace: false,
    group: { groupName: 'U9 Tigers', organizerName: 'Mike', organizerContact: 'hello@trytofu.ai', duesLabel: 'Season dues', duesAmountCents: 4000 },
    people,
    sheets
  };
}

test("T25 through the routes at the import's own limits: the export's bytes (500 people, 2,000 sign-ups) import into a fresh copy whole", async (t) => {
  const sourceUrl = await cluster.createDatabase({ migrated: true });
  const freshUrl = await cluster.createDatabase({ migrated: true });
  const source = poolFor(sourceUrl);
  const fresh = poolFor(freshUrl);
  extra.push(source, fresh);
  const plan = atTheLimits();
  assert.equal(plan.sheets.reduce((n, sheet) => n + sheet.signups.length, 0), FILE_LIMITS.signups);
  assert.equal((await applyImport(source, plan, organizer())).kind, 'imported');
  try {
    await useDatabase(sourceUrl);
    const sourceSeat = (await takeSeat(source, readSettings({ DATABASE_URL: sourceUrl })))!;
    const { GET } = await realRoutes('organizer/export.json');
    const exported = await GET!(get('/organizer/export.json', { ss_org: sourceSeat.cookieValue }), params({}));
    assert.equal(exported.status, 200);
    const text = await exported.text();
    const size = Buffer.byteLength(text);
    const indented = Buffer.byteLength(`${JSON.stringify(JSON.parse(text), null, 2)}\n`);
    t.diagnostic(`the export: ${size} bytes; indented it would be ${indented}; the import takes ${IMPORT_LIMIT_BYTES}`);
    assert.ok(size <= IMPORT_LIMIT_BYTES, `the export is ${size} bytes`);
    assert.ok(indented > IMPORT_LIMIT_BYTES, 'indented, the same file would be refused');

    await useDatabase(freshUrl);
    const freshSeat = (await takeSeat(fresh, readSettings({ DATABASE_URL: freshUrl })))!;
    const { POST } = await realRoutes('organizer/import');
    const imported = await POST!(jsonPost('/organizer/import', text, { ss_org: freshSeat.cookieValue }), params({}));
    const answer = (await imported.json()) as { ok: boolean; dryRun: boolean; summary: string; counts: unknown };
    assert.equal(imported.status, 200, JSON.stringify(answer));
    assert.equal(answer.ok, true);
    assert.equal(answer.dryRun, false);
    assert.ok(answer.summary.includes('from an export of'), answer.summary);
    assert.deepEqual(answer.counts, { people: 500, sheets: 2, dates: 50, slots: 400, signups: 2000 });
    assert.deepEqual(restorable(await exportCopy(fresh)), restorable(JSON.parse(text) as ExportFile));
    await assertCountsConsistent(fresh);
  } finally {
    await endRoutePool();
  }
});
