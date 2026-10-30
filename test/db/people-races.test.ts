// Removing a person (W11 everywhere, and the roster's plain delete) against the writes that sign that same person up at
// the same moment: an import that names them by id, the organizer adding them, and their own as=me claim that also
// changes their contact. Each race is lined up the same way every run by a pause in a changed copy of the source
// (test/support/core.ts): one write waits at the pause while it holds the person's row, the other is seen waiting for
// that row, then the first goes on. Whichever holds the person first, nobody is half removed, no sign-up outlives its
// person, a refused write leaves nothing behind, and neither write ends in a deadlock. Not HTTP tests.
import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import type pg from 'pg';
import { isDbError } from '../../src/lib/db';
import type { ImportPlan } from '../../src/lib/importer';
import { deletePerson, removePersonEverywhere } from '../../src/lib/people';
import { readSettings, type Settings } from '../../src/lib/settings';
import { claim, type ClaimInput } from '../../src/lib/signups';
import { newRequestId } from '../../src/lib/tokens';
import { poolFor, waitFor } from '../support/fixtures';
import {
  assertCountsConsistent,
  changedCopy,
  count,
  dayFromToday,
  organizer,
  pauseAfter,
  pauses,
  personWithLink,
  roster,
  settled,
  sheetWithSlots,
  snapshot,
  member
} from '../support/core';
import { type Cluster, startCluster } from '../support/postgres';

type Importer = typeof import('../../src/lib/importer');
type People = typeof import('../../src/lib/people');
type Signups = typeof import('../../src/lib/signups');

// Where a copy waits, each while it holds the person's row.
const IMPORT_HOLDS_PERSON = '    [named.map((person) => person.existingId)]\n  );';
const REMOVAL_HOLDS_PERSON = "      const found = await tx.query('select 1 from people where id = $1 for update', [personId]);";
const DELETE_HOLDS_PERSON = "    if (found.rows.length === 0) return { kind: 'missing' as const };";
const ADD_HOLDS_PERSON = "    const found = await tx.query('select 1 from people where id = $1 for key share', [who.personId]);";
const CLAIM_HOLDS_MEMBER = "    if (!(await memberStillValid(tx, who.auth))) return refused('who');";

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

const lockWaits = () => count(pool, "select count(*) from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()");

/** A person P confirmed in slot x of a new sheet, someone waiting behind them there, and a free slot z. */
async function scene(slug: string) {
  const { sheetId, slotIds } = await sheetWithSlots(pool, { slug, capacities: [1, 2] });
  const [x, z] = slotIds as [string, string];
  const p = await personWithLink(pool, 'P');
  const next = await personWithLink(pool, 'Next');
  await pool.query("insert into signups (slot_id, person_id, status, added_by) values ($1, $2, 'confirmed', 'member')", [x, p.id]);
  await pool.query("insert into signups (slot_id, person_id, status, added_by) values ($1, $2, 'waiting', 'member')", [x, next.id]);
  return { sheetId, x, z, p };
}

/** Runs `first` until it holds the person (its copy's pause), starts `second`, sees it wait, then lets `first` go on. */
async function race<A, B>(gate: ReturnType<typeof pauses>, name: string, first: () => Promise<A>, second: () => Promise<B>) {
  const one = settled(first());
  await gate.reached(name);
  const two = settled(second());
  await waitFor(async () => (await lockWaits()) > 0, `the second write to wait for the person the first holds (${name})`);
  gate.open(name);
  const outcomes = { first: await one, second: await two };
  for (const [which, outcome] of Object.entries(outcomes)) {
    assert.ok(!('error' in outcome && isDbError(outcome.error, '40P01')), `deadlock: the ${which} write was ended as its victim`);
    assert.ok('value' in outcome, `the ${which} write failed: ${'error' in outcome ? String(outcome.error) : ''}`);
  }
  return { first: (outcomes.first as { value: A }).value, second: (outcomes.second as { value: B }).value };
}

const addPerson = (slug: string | null, slotId: string, personId: string): ClaimInput => ({
  slug, slotId, requestId: newRequestId(), who: { kind: 'person', personId }, note: '', rules: 'organizer'
});

function importNaming(slug: string, p: { id: string }, replace: boolean): ImportPlan {
  return {
    replace,
    group: { groupName: 'Changed by the import' },
    people: [
      { key: 'p', existingId: p.id, name: 'P', contact: '', paid: false, paidAmountCents: null, paidNote: '' },
      { key: 'new', existingId: null, name: 'New person', contact: '', paid: false, paidAmountCents: null, paidNote: '' }
    ],
    sheets: [
      {
        slug, title: 'Imported', description: '', timezone: 'America/Los_Angeles', place: '', names: 'full', noteLabel: '', noteRequired: false,
        listed: true, status: 'open',
        dates: [{ onDate: dayFromToday(12), startsAt: null, endsAt: null, label: '', place: '', slots: [{ label: 'Snacks', description: '', capacity: 2 }] }],
        signups: [
          { date: 0, slot: 0, person: 'p', note: '', status: 'confirmed' },
          { date: 0, slot: 0, person: 'new', note: '', status: 'confirmed' }
        ]
      }
    ]
  };
}

test('W11 and an import that names the person by id, the import first: the removal starts again and takes the new sign-up too', async () => {
  const copy = changedCopy([pauseAfter('src/lib/importer.ts', IMPORT_HOLDS_PERSON, 'import')]);
  const gate = pauses(['import']);
  try {
    const { applyImport } = await copy.load<Importer>('src/lib/importer.ts');
    const { x, p } = await scene('import-first');
    const { first: imported, second: removed } = await race(
      gate,
      'import',
      () => applyImport(pools[1]!, importNaming('import-first-new', p, false), organizer()),
      () => removePersonEverywhere(pools[2]!, p.id, organizer())
    );
    assert.equal(imported.kind, 'imported');
    assert.deepEqual(removed, { kind: 'removed', signups: 2, promoted: 1 });
    assert.equal(await count(pool, 'select count(*) from people where id = $1', [p.id]), 0);
    assert.equal(await count(pool, 'select count(*) from signups where person_id = $1', [p.id]), 0);
    assert.deepEqual(await roster(pool, x), { confirmed: ['Next'], waiting: [] });
    const made = (await pool.query<{ id: string }>("select s.id from slots s join sheets h on h.id = s.sheet_id where h.slug = 'import-first-new'")).rows[0]!.id;
    assert.deepEqual(await roster(pool, made), { confirmed: ['New person'], waiting: [] });
  } finally {
    gate.end();
    copy.remove();
  }
});

test('W11 and a replacing import that names the person, the removal first: the import is refused and its replace undone', async () => {
  const copy = changedCopy([pauseAfter('src/lib/people.ts', REMOVAL_HOLDS_PERSON, 'removal')]);
  const gate = pauses(['removal']);
  try {
    const { removePersonEverywhere: removeInCopy } = await copy.load<People>('src/lib/people.ts');
    const { p } = await scene('removal-first');
    // The sheet the import would replace, made by an earlier import.
    const { applyImport } = await import('../../src/lib/importer');
    const earlier = importNaming('to-replace', { id: (await personWithLink(pool, 'P')).id }, false);
    assert.equal((await applyImport(pool, { ...earlier, group: null }, organizer())).kind, 'imported');
    const kept = await snapshot(pool);
    const keptOf = (rows: Record<string, unknown[]>) => ({
      group: rows.group,
      sheets: rows.sheets,
      dates: rows.dates,
      slots: rows.slots,
      people: (rows.people as { id: string }[]).filter((row) => row.id !== p.id)
    });

    const { first: removed, second: imported } = await race(
      gate,
      'removal',
      () => removeInCopy(pools[1]!, p.id, organizer()),
      () => applyImport(pools[2]!, importNaming('to-replace', p, true), organizer())
    );
    assert.deepEqual(removed, { kind: 'removed', signups: 1, promoted: 1 });
    assert.deepEqual(imported, { kind: 'refused', reason: 'person', key: 'p' });
    const now = await snapshot(pool);
    assert.deepEqual(keptOf(now), keptOf(kept), 'the sheet to replace, the group and everyone else are as they were');
    assert.deepEqual(
      (now.activity as { kind: string }[]).slice(kept.activity!.length).map((row) => row.kind),
      ['remove_person'],
      'only the removal wrote'
    );
  } finally {
    gate.end();
    copy.remove();
  }
});

test('W11 and the organizer adding the person, the add first: the removal starts again and takes the new sign-up too', async () => {
  const copy = changedCopy([pauseAfter('src/lib/signups.ts', ADD_HOLDS_PERSON, 'add')]);
  const gate = pauses(['add']);
  try {
    const { claim: claimInCopy } = await copy.load<Signups>('src/lib/signups.ts');
    const { x, z, p } = await scene('add-first');
    const { first: added, second: removed } = await race(
      gate,
      'add',
      () => claimInCopy(pools[1]!, settings, addPerson(null, z, p.id), organizer()),
      () => removePersonEverywhere(pools[2]!, p.id, organizer())
    );
    assert.equal(added.kind, 'signed-up');
    assert.deepEqual(removed, { kind: 'removed', signups: 2, promoted: 1 });
    assert.equal(await count(pool, 'select count(*) from signups where person_id = $1', [p.id]), 0);
    assert.deepEqual(await roster(pool, x), { confirmed: ['Next'], waiting: [] });
    assert.deepEqual(await roster(pool, z), { confirmed: [], waiting: [] });
  } finally {
    gate.end();
    copy.remove();
  }
});

test('W11 and the organizer adding the person, the removal first: the add is refused, and the person and their places are gone', async () => {
  const copy = changedCopy([pauseAfter('src/lib/people.ts', REMOVAL_HOLDS_PERSON, 'removal')]);
  const gate = pauses(['removal']);
  try {
    const { removePersonEverywhere: removeInCopy } = await copy.load<People>('src/lib/people.ts');
    const { z, p } = await scene('removal-before-add');
    const { first: removed, second: added } = await race(
      gate,
      'removal',
      () => removeInCopy(pools[1]!, p.id, organizer()),
      () => claim(pools[2]!, settings, addPerson(null, z, p.id), organizer())
    );
    assert.deepEqual(removed, { kind: 'removed', signups: 1, promoted: 1 });
    assert.deepEqual(added, { kind: 'refused', reason: 'person', slug: 'removal-before-add' });
    assert.deepEqual(await roster(pool, z), { confirmed: [], waiting: [] });
  } finally {
    gate.end();
    copy.remove();
  }
});

test("W11 and the person's own as=me claim that also changes their contact, the claim first: no deadlock; the removal takes it all", async () => {
  const copy = changedCopy([pauseAfter('src/lib/signups.ts', CLAIM_HOLDS_MEMBER, 'claim')]);
  const gate = pauses(['claim']);
  try {
    const { claim: claimInCopy } = await copy.load<Signups>('src/lib/signups.ts');
    const { x, z, p } = await scene('me-first');
    const { first: claimed, second: removed } = await race(
      gate,
      'claim',
      () =>
        claimInCopy(
          pools[1]!,
          settings,
          { slug: 'me-first', slotId: z, requestId: newRequestId(), who: { kind: 'me', auth: p.auth, contact: '+1 415 555 0134' }, note: '', rules: 'member' },
          member()
        ),
      () => removePersonEverywhere(pools[2]!, p.id, organizer())
    );
    assert.equal(claimed.kind, 'signed-up');
    assert.deepEqual(removed, { kind: 'removed', signups: 2, promoted: 1 });
    assert.equal(await count(pool, 'select count(*) from people where id = $1', [p.id]), 0);
    assert.deepEqual(await roster(pool, x), { confirmed: ['Next'], waiting: [] });
    assert.deepEqual(await roster(pool, z), { confirmed: [], waiting: [] });
  } finally {
    gate.end();
    copy.remove();
  }
});

test("the roster's plain delete and the organizer adding the same person, each first: the delete refuses, or the add does", async () => {
  const addFirst = changedCopy([pauseAfter('src/lib/signups.ts', ADD_HOLDS_PERSON, 'add')]);
  const deleteFirst = changedCopy([pauseAfter('src/lib/people.ts', DELETE_HOLDS_PERSON, 'delete')]);
  const gate = pauses(['add', 'delete']);
  try {
    const { claim: claimInCopy } = await addFirst.load<Signups>('src/lib/signups.ts');
    const { deletePerson: deleteInCopy } = await deleteFirst.load<People>('src/lib/people.ts');
    const { slotIds } = await sheetWithSlots(pool, { slug: 'plain-delete', capacities: [2] });
    const rosterOnly = async () =>
      (await pool.query<{ id: string }>("insert into people (name, added_by) values ('Roster only', 'organizer') returning id")).rows[0]!.id;

    const kept = await rosterOnly();
    const one = await race(
      gate,
      'add',
      () => claimInCopy(pools[1]!, settings, addPerson(null, slotIds[0]!, kept), organizer()),
      () => deletePerson(pools[2]!, kept, organizer())
    );
    assert.equal(one.first.kind, 'signed-up');
    assert.deepEqual(one.second, { kind: 'refused', reason: 'has-signups' });
    assert.equal(await count(pool, 'select count(*) from signups where person_id = $1', [kept]), 1);

    const gone = await rosterOnly();
    const two = await race(
      gate,
      'delete',
      () => deleteInCopy(pools[1]!, gone, organizer()),
      () => claim(pools[2]!, settings, addPerson(null, slotIds[0]!, gone), organizer())
    );
    assert.deepEqual(two.first, { kind: 'deleted' });
    assert.deepEqual(two.second, { kind: 'refused', reason: 'person', slug: 'plain-delete' });
    assert.equal(await count(pool, 'select count(*) from people where id = $1', [gone]), 0);
    assert.equal(await count(pool, 'select count(*) from signups where person_id = $1', [gone]), 0);
  } finally {
    gate.end();
    addFirst.remove();
    deleteFirst.remove();
  }
});
