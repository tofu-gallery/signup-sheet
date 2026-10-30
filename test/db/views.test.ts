// The three audience queries on a real database. Each one's whole answer is searched for seeded probe values, as a
// page's HTML is: the public view never carries a contact, paid state, token, person id, sign-up time
// or (on a 'taken' sheet) a name; the person's own view carries their contact and no one else's.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import type pg from 'pg';
import { meView, mySignup, organizerView, publicSheetView } from '../../src/lib/views';
import { poolFor } from '../support/fixtures';
import { personWithLink, sheetWithSlots } from '../support/core';
import { type Cluster, startCluster } from '../support/postgres';

let cluster: Cluster;
let pool: pg.Pool;

before(async () => {
  cluster = await startCluster();
  pool = poolFor(await cluster.createDatabase({ migrated: true }));
});

after(async () => {
  await pool?.end();
  await cluster?.stop();
});

const probe = (label: string) => `${label}${randomBytes(6).toString('hex')}`;

/** A sheet with a confirmed and a waiting person, each with probe values in every private column. */
async function seeded(slug: string, names: 'full' | 'taken', status = 'open') {
  const { slotIds } = await sheetWithSlots(pool, { slug, capacities: [1], names, status });
  const probes = { name: probe('NAMEPROBE'), waitingName: probe('WAITPROBE'), contact: `${probe('privacy-probe-')}@example.com`, paid: probe('PAIDPROBE'), note: probe('NOTEPROBE') };
  await pool.query("update app_state set dues_label = 'Season dues', dues_amount_cents = 4000, organizer_contact = $1, organizer_name = 'Mike'", [`org-${probes.contact}`]);
  const a = await personWithLink(pool, probes.name, probes.contact);
  const b = await personWithLink(pool, probes.waitingName, `b-${probes.contact}`);
  await pool.query('update people set paid = true, paid_note = $1 where id = any($2::bigint[])', [probes.paid, [a.id, b.id]]);
  const confirmed = await pool.query<{ id: string }>(
    "insert into signups (slot_id, person_id, status, note, added_by) values ($1, $2, 'confirmed', $3, 'member') returning id",
    [slotIds[0], a.id, probes.note]
  );
  const waiting = await pool.query<{ id: string }>(
    "insert into signups (slot_id, person_id, status, added_by) values ($1, $2, 'waiting', 'member') returning id",
    [slotIds[0], b.id]
  );
  return { probes, a, b, slotId: slotIds[0]!, confirmedId: confirmed.rows[0]!.id, waitingId: waiting.rows[0]!.id };
}

function assertAbsent(text: string, values: string[]) {
  for (const value of values) assert.ok(!text.includes(value), `must not contain ${value.slice(0, 12)}…`);
}

test('the public view of a full sheet: names and notes of confirmed people, a waiting count, nothing private', async () => {
  const { probes, a, b, slotId } = await seeded('public-full', 'full');
  const view = await publicSheetView(pool, 'public-full', { draft: false });
  assert.ok(view);
  const slot = view.dates[0]!.slots[0]!;
  assert.equal(slot.id, slotId);
  assert.deepEqual(slot.entries, [{ name: probes.name, note: probes.note }]);
  assert.deepEqual([slot.capacity, slot.confirmed, slot.waiting], [1, 1, 1]);
  assert.equal(view.organizerName, 'Mike');
  const text = JSON.stringify(view);
  // No person id under any key (ids of dates and slots are public), no link, no paid or contact column.
  assertAbsent(text, [probes.contact, probes.paid, probes.waitingName, 'paid', 'contact', 'token', 'person', a.token, b.token]);
  assert.ok(!/"id":"?\d+"?,"name"/.test(text), 'entries carry no id');
});

test("the public view of a 'taken' sheet selects no names at all, and still shows notes", async () => {
  const { probes } = await seeded('public-taken', 'taken');
  const view = await publicSheetView(pool, 'public-taken', { draft: false });
  const text = JSON.stringify(view);
  assertAbsent(text, [probes.name, probes.waitingName, probes.contact, probes.paid]);
  assert.deepEqual(view?.dates[0]?.slots[0]?.entries, [{ name: null, note: probes.note }]);
});

test('a draft is public to nobody; the organizer may preview it', async () => {
  await seeded('public-draft', 'full', 'draft');
  assert.equal(await publicSheetView(pool, 'public-draft', { draft: false }), null);
  assert.equal((await publicSheetView(pool, 'public-draft', { draft: true }))?.status, 'draft');
  assert.equal(await publicSheetView(pool, 'no-such-sheet', { draft: true }), null);
});

test("a person's own view: their contact, their sign-ups with their waitlist number, and nobody else's private data", async () => {
  const { probes, a, b, confirmedId, waitingId } = await seeded('mine', 'full');
  const mine = await meView(pool, b.id);
  assert.equal(mine?.contact, `b-${probes.contact}`);
  assert.equal(mine?.organizerContact, `org-${probes.contact}`, 'the organizer contact is allowed on /me');
  assert.deepEqual(mine?.signups.map((signup) => [signup.id, signup.status, signup.position]), [[waitingId, 'waiting', 1]]);
  const text = JSON.stringify(mine);
  assertAbsent(text, [probes.name, probes.paid, `"${probes.contact}"`, a.token, b.token]);
  assert.equal((await mySignup(pool, a.id, confirmedId))?.note, probes.note);
  assert.equal(await mySignup(pool, b.id, confirmedId), null, "another person's sign-up id finds nothing");
  await pool.query("update sheets set status = 'draft' where slug = 'mine'");
  assert.deepEqual((await meView(pool, a.id))?.signups, [], 'a draft is not shown on /me either');
});

test('the organizer view has contacts and paid (with dues), whether a link exists, and never a link', async () => {
  const { probes, a, b } = await seeded('organized', 'taken');
  const view = await organizerView(pool, 'organized');
  const signups = view!.dates[0]!.slots[0]!.signups;
  assert.deepEqual(signups.map((signup) => [signup.name, signup.contact, signup.paid, signup.hasLink, signup.position, signup.placesOnSheet]), [
    [probes.name, probes.contact, true, true, null, 1],
    [probes.waitingName, `b-${probes.contact}`, true, true, 1, 1]
  ]);
  const text = JSON.stringify(view);
  assertAbsent(text, [a.token, b.token, a.auth.tokenHash.toString('hex'), a.auth.tokenHash.toString('base64')]);
  await pool.query("update app_state set dues_label = ''");
  assert.equal((await organizerView(pool, 'organized'))!.dates[0]!.slots[0]!.signups[0]!.paid, null, 'no dues, no paid column');
});
