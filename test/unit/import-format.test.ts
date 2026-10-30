// The import's file reader (import-format.ts): the strict JSON reader, the exact refusal sentences, unknown and
// ambiguous fields, what a person's id means in an ordinary file and in an export, and an export's sign-up history.
// Pure functions, no database.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseStrictJson, readImportFile, type ReadImport } from '../../src/lib/import-format';
import { words } from '../../src/words';

const NOW = new Date('2026-10-29T19:00:00Z');
const EXAMPLES = join(import.meta.dirname, '../../examples');
const example = (name: string) => readFileSync(join(EXAMPLES, `${name}.json`), 'utf8');

function read(file: unknown, now = NOW): ReadImport {
  const result = readImportFile(typeof file === 'string' ? file : JSON.stringify(file), now);
  assert.ok(result.ok, result.ok ? '' : `refused: ${result.refusal.sentence}`);
  return result.value;
}

function refusal(file: unknown, now = NOW): { sentence: string; path: string | null } {
  const result = readImportFile(typeof file === 'string' ? file : JSON.stringify(file), now);
  assert.ok(!result.ok, 'expected a refusal');
  return result.refusal;
}

/** A small valid file to change one thing in. */
function file(change: (doc: any) => void = () => {}): any {
  const doc: any = {
    format: 'signup-sheet/1',
    people: [{ key: 'mike', name: "Mike's family" }, { key: 'frank', name: "Frank's family" }],
    sheets: [
      {
        slug: 'snacks',
        title: 'Snack sign-up',
        timezone: 'America/Los_Angeles',
        everyDate: [{ label: 'Snacks', capacity: 1 }],
        dates: [
          { date: '2026-11-07', weekday: 'Sat', start: '09:00', end: '10:30' },
          { date: '2026-11-14', weekday: 'Saturday', start: '09:00' }
        ],
        signups: [{ date: '2026-11-07', slot: 'Snacks', person: 'mike' }]
      }
    ]
  };
  change(doc);
  return doc;
}

test('the three examples read as their plans: soccer (a dry run), a potluck that asks for a note, and dues only', () => {
  const soccer = read(example('soccer'));
  assert.equal(soccer.dryRun, true);
  assert.equal(soccer.exportedAt, null);
  assert.deepEqual(soccer.plan.group, {
    groupName: 'U9 Tigers',
    organizerName: 'Mike',
    organizerContact: 'hello@trytofu.ai',
    duesLabel: 'Season dues',
    duesAmountCents: 4000
  });
  assert.deepEqual(soccer.plan.people.map((person) => [person.key, person.existingId, person.paid, person.paidAmountCents]), [
    ['mike', null, true, 4000],
    ['frank', null, false, null]
  ]);
  const snacks = soccer.plan.sheets[0]!;
  assert.equal(snacks.dates.length, 7);
  assert.ok(snacks.dates.every((date) => date.slots.length === 1 && date.slots[0]!.label === 'Bring snacks'));
  assert.deepEqual(snacks.signups, [
    { date: 0, slot: 0, person: 'mike', note: 'Oranges', status: 'confirmed' },
    { date: 1, slot: 0, person: 'frank', note: '', status: 'confirmed' }
  ]);

  const potluck = read(example('potluck'));
  assert.equal(potluck.dryRun, null);
  assert.equal(potluck.plan.sheets[0]!.noteRequired, true);
  assert.equal(potluck.plan.sheets[0]!.noteLabel, "What you'll bring");
  assert.deepEqual(potluck.plan.group, { groupName: 'Maple Street neighbors', organizerName: 'Frank', organizerContact: '', duesLabel: '', duesAmountCents: null });

  const dues = read(example('dues'));
  assert.deepEqual(dues.plan.sheets, []);
  assert.equal(dues.plan.people.length, 2);
});

test('the exact refusal sentences', () => {
  const s = words.import;
  assert.equal(refusal({ format: 'signup-sheet/2' }).sentence, s.notFormat);
  assert.equal(refusal('[]').sentence, s.notFormat);
  assert.deepEqual(
    refusal(file((doc) => (doc.sheets[0].dates[0] = { date: '2026-11-08', weekday: 'Sat' }))),
    { sentence: '2026-11-08 is a Sunday, but the file says Sat.', path: 'sheets[0].dates[0].weekday' }
  );
  assert.equal(
    refusal(file((doc) => doc.sheets[0].signups.push({ date: '2026-11-07', slot: 'Snacks', person: 'frank' }))).sentence,
    'Snacks on Sat, Nov 7 has 1 place, but the file signs up 2 people there.'
  );
  assert.equal(
    refusal(file((doc) => (doc.sheets[0].signups[0].person = 'nobody'))).sentence,
    'A sign-up names the person "nobody", but no person in the file has that key.'
  );
  assert.equal(
    refusal(file((doc) => (doc.sheets[0].signups[0] = { date: '2026-11-14', slot: 'Snack', person: 'mike' }))).sentence,
    'A sign-up names Snack on Sat, Nov 14, but that date has no slot called Snack.'
  );
  assert.equal(
    refusal(file((doc) => (doc.sheets[0].timezone = 'America/LosAngeles'))).sentence,
    '"America/LosAngeles" isn\'t a time zone this app knows. Use a name like America/Los_Angeles.'
  );
  assert.equal(refusal(`{"format":"signup-sheet/1","people":[],"x":"${'a'.repeat(512 * 1024)}"}`).sentence, s.tooBig);
  assert.equal(refusal('  ').sentence, s.empty);
});

test('a field this format does not have is refused, misspellings included; `from` and the export-only fields are not', () => {
  assert.deepEqual(refusal(file((doc) => (doc.sheets[0].dates[1].wekday = 'Sat'))), {
    sentence: 'sheets[0].dates[1]: "wekday" isn\'t a field this file can have.',
    path: 'sheets[0].dates[1].wekday'
  });
  assert.equal(refusal(file((doc) => (doc.sheets[0].name = 'taken'))).sentence, 'sheets[0]: "name" isn\'t a field this file can have.');
  assert.equal(refusal(file((doc) => (doc.sheets[0].stauts = 'open'))).sentence, 'sheets[0]: "stauts" isn\'t a field this file can have.');
  assert.equal(refusal(file((doc) => (doc.dryrun = true))).sentence, 'The file: "dryrun" isn\'t a field this file can have.');
  // A misspelled value is refused too, never read as the default.
  assert.equal(refusal(file((doc) => (doc.sheets[0].names = 'Taken'))).sentence, 'sheets[0].names: must be "full" or "taken".');
  assert.equal(refusal(file((doc) => (doc.sheets[0].status = 'opened'))).sentence, 'sheets[0].status: must be "draft" or "open" or "closed".');
  assert.equal(refusal(file((doc) => (doc.sheets[0].dates[1].weekday = 'Satur'))).path, 'sheets[0].dates[1].weekday');

  const accepted = read(
    file((doc) => {
      doc.from = 'the coach\'s email';
      doc.exportedAt = '2026-10-29T19:00:00.000Z';
      doc.people[0].hasLink = true;
      doc.people[0].from = { name: 'dues list row 2' };
      doc.sheets[0].id = 4;
      Object.assign(doc.sheets[0].signups[0], { addedBy: 'member', signedUpAt: '2026-10-20T10:00:00.000Z', promotedAt: null, told: false });
    })
  );
  assert.equal(accepted.plan.sheets[0]!.signups.length, 1);
  assert.equal(refusal(file((doc) => (doc.people[0].hasLink = 'yes'))).sentence, 'people[0].hasLink: must be true or false.');
  assert.equal(refusal(file((doc) => (doc.sheets[0].signups[0].addedBy = 'robot'))).path, 'sheets[0].signups[0].addedBy');
  assert.equal(refusal(file((doc) => (doc.from = ['a']))).sentence, 'from: must be text, or an object whose values are text.');
});

test('the strict JSON reader: a field written twice, nesting too deep, broken text and __proto__ are refused, a BOM is not', () => {
  assert.equal(
    refusal('{"format":"signup-sheet/1","sheets":[],"sheets":[]}').sentence,
    'The file: "sheets" is written twice.'
  );
  assert.equal(
    refusal('{"format":"signup-sheet/1","people":[{"key":"a","name":"A","name":"B"}]}').sentence,
    'people[0]: "name" is written twice.'
  );
  assert.equal(refusal('{"format":"signup-sheet/1",}').sentence, words.import.notJson(1, 28));
  assert.equal(refusal('{"format":\n  "signup-sheet/1" "x"}').sentence, words.import.notJson(2, 20));
  assert.equal(refusal(`{"format":"signup-sheet/1","sheets":${'['.repeat(30)}${']'.repeat(30)}}`).sentence, words.import.tooDeep);
  assert.equal(refusal('{"format":"signup-sheet/1","people":[{"key":"a","name":"\\ud800"}]}').sentence, words.import.notJson(1, 56));
  assert.equal(
    refusal('{"format":"signup-sheet/1","__proto__":{"polluted":true}}').sentence,
    'The file: "__proto__" isn\'t a field this file can have.'
  );
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(read(`\uFEFF${JSON.stringify(file())}`).plan.people.length, 2);

  assert.deepEqual(parseStrictJson('{"a":[1,-2.5e3,true,null,"\\u00e9\\n"]}'), Object.assign(Object.create(null), { a: [1, -2500, true, null, '\u00e9\n'] }));
  for (const bad of ['01', '1.', '.5', '+1', 'NaN', "'a'", '{"a":1,}', '[1,]', 'tru', '"\t"', '1e999']) {
    assert.throws(() => parseStrictJson(bad), (error: Error) => error.name === 'Refusal', bad);
  }
});

test('anything that could name two things is refused: a day and time twice, a label twice, a day with two times named without one', () => {
  assert.equal(
    refusal(file((doc) => doc.sheets[0].dates.push({ date: '2026-11-07', start: '09:00' }))).sentence,
    'sheets[0].dates[2]: this sheet has another date on Sat, Nov 7, 9:00 AM.'
  );
  assert.equal(
    refusal(file((doc) => (doc.sheets[0].dates[0].slots = [{ label: 'Snacks', capacity: 1 }, { label: 'Snacks', capacity: 2 }]))).sentence,
    'sheets[0].dates[0].slots[1].label: this date has another slot called Snacks.'
  );
  const twoTimes = file((doc) => doc.sheets[0].dates.push({ date: '2026-11-07', start: '13:00' }));
  assert.equal(refusal(twoTimes).sentence, 'sheets[0].signups[0]: 2026-11-07 has more than one time on this sheet, so this needs "start".');
  twoTimes.sheets[0].signups[0].start = '13:00';
  assert.equal(read(twoTimes).plan.sheets[0]!.signups[0]!.date, 2, 'start names the date of that day and time');
  twoTimes.sheets[0].signups[0].start = null;
  assert.equal(refusal(twoTimes).sentence, 'sheets[0].signups[0].start: this sheet has no date on Sat, Nov 7.');

  assert.equal(refusal(file((doc) => doc.people.push({ key: 'mike', name: 'Another' }))).sentence, 'people[2].key: another person in this file has the key "mike".');
  assert.equal(refusal(file((doc) => doc.sheets.push({ ...doc.sheets[0] }))).sentence, 'sheets[1].slug: another sheet in this file is "snacks" too.');
  assert.equal(
    refusal(file((doc) => (doc.sheets[0].everyDate[0].capacity = 2) && doc.sheets[0].signups.push({ date: '2026-11-07', slot: 'Snacks', person: 'mike' }))).sentence,
    'sheets[0].signups[1]: "mike" is signed up for Snacks on Sat, Nov 7 more than once.'
  );
});

test('a date still ahead has nobody waiting beside a free place; a date that has started or is cancelled may', () => {
  const waiting = (date: string, cancelled = false) =>
    file((doc) => {
      doc.sheets[0].everyDate[0].capacity = 2;
      doc.sheets[0].dates = [{ date, start: '09:00', cancelled }];
      doc.sheets[0].signups = [
        { date, slot: 'Snacks', person: 'mike' },
        { date, slot: 'Snacks', person: 'frank', status: 'waiting' }
      ];
    });
  assert.deepEqual(refusal(waiting('2026-11-07')), {
    sentence: 'sheets[0].signups[1].status: is "waiting", but Snacks on Sat, Nov 7 still has a place free.',
    path: 'sheets[0].signups[1].status'
  });
  assert.equal(read(waiting('2026-10-24')).plan.sheets[0]!.signups[1]!.status, 'waiting');
  assert.equal(read(waiting('2026-11-07', true)).plan.sheets[0]!.dates[0]!.cancelled, true);
});

test("a person's id: someone already here, kept as they are (no other fields), in an ordinary file; nobody here in an export", () => {
  const named = read(file((doc) => (doc.people[0] = { key: 'mike', id: 7, name: "Mike's family" })));
  assert.equal(named.plan.people[0]!.existingId, '7');
  assert.equal(named.plan.exported, false);
  assert.equal(
    refusal(file((doc) => (doc.people[0] = { key: 'mike', id: 7, name: "Mike's family", contact: 'hello@trytofu.ai' }))).sentence,
    'people[0].contact: a person with "id" is someone already here, kept as they are, so it can\'t also give "contact".'
  );
  assert.equal(refusal(file((doc) => doc.people.push({ key: 'm2', id: '7', name: "Mike's family" }) && (doc.people[0].id = 7))).sentence, 'people[2].id: another person in this file names the same person already here.');
  assert.equal(refusal(file((doc) => (doc.people[0].id = 0))).sentence, 'people[0].id: must be the number of a person already here.');

  const exported = read(
    file((doc) => {
      doc.exportedAt = '2026-10-29T19:00:00.000Z';
      doc.people[0] = { key: 'p7', id: 7, name: "Mike's family", contact: 'hello@trytofu.ai', paid: true, hasLink: true };
      doc.sheets[0].signups[0].person = 'p7';
    })
  );
  assert.equal(exported.plan.exported, true);
  assert.equal(exported.plan.people[0]!.existingId, null, "an export's ids are the other copy's: never matched with anyone here");
  assert.equal(exported.plan.people[0]!.contact, 'hello@trytofu.ai');
  assert.deepEqual(exported.exportedAt, new Date('2026-10-29T19:00:00.000Z'));
  assert.equal(refusal(file((doc) => (doc.exportedAt = 'yesterday'))).path, 'exportedAt');
});

test("an export's sign-up history is restored with it (told at the export's own time); an ordinary file's is read and ignored", () => {
  const history = (read: ReadImport, n = 0) => {
    const { addedBy, signedUpAt, promotedAt, toldAt } = read.plan.sheets[0]!.signups[n]!;
    return { addedBy, signedUpAt, promotedAt, toldAt };
  };
  const exported = read(
    file((doc) => {
      doc.exportedAt = '2026-10-29T19:00:00.000Z';
      Object.assign(doc.sheets[0].signups[0], { addedBy: 'member', signedUpAt: '2026-10-20T10:00:00.000Z', promotedAt: '2026-10-21T08:30:00.000Z', told: true });
      doc.sheets[0].signups.push({ date: '2026-11-14', slot: 'Snacks', person: 'frank' });
    })
  );
  assert.deepEqual(history(exported), { addedBy: 'member', signedUpAt: '2026-10-20T10:00:00.000Z', promotedAt: '2026-10-21T08:30:00.000Z', toldAt: '2026-10-29T19:00:00.000Z' });
  assert.deepEqual(history(exported, 1), { addedBy: 'import', signedUpAt: null, promotedAt: null, toldAt: null }, 'left out of an export: an import made it');

  // `signedUpAt` is read by the same rules as `promotedAt`: a time as an export writes it, from 2000 on, never ahead.
  const signedUpAt = (value: unknown) => file((doc) => Object.assign(doc, { exportedAt: '2026-10-29T18:00:00.000Z' }) && (doc.sheets[0].signups[0].signedUpAt = value));
  for (const bad of ['last week', '2026-02-30T00:00:00.000Z', '1999-12-31T23:59:59.000Z', '2026-10-21T08:30:00+02:00']) {
    assert.deepEqual(refusal(signedUpAt(bad)), { sentence: 'sheets[0].signups[0].signedUpAt: must be a time written like 2026-10-29T19:00:00.000Z.', path: 'sheets[0].signups[0].signedUpAt' }, bad);
  }
  assert.deepEqual(refusal(signedUpAt('2026-10-29T19:10:00.000Z')), { sentence: "sheets[0].signups[0].signedUpAt: can't be later than now.", path: 'sheets[0].signups[0].signedUpAt' });
  assert.equal(refusal(signedUpAt(7)).path, 'sheets[0].signups[0].signedUpAt');
  // Controls: the oldest time it takes, and one a few minutes ahead (another clock; the import stores it as now).
  assert.equal(history(read(signedUpAt('2000-01-01T00:00:00.000Z'))).signedUpAt, '2000-01-01T00:00:00.000Z');
  assert.equal(history(read(signedUpAt('2026-10-29T19:03:00Z'))).signedUpAt, '2026-10-29T19:03:00.000Z');
  assert.equal(history(read(signedUpAt(null))).signedUpAt, null, 'null, as left out: made by the import');
  assert.deepEqual(
    refusal(file((doc) => Object.assign(doc, { exportedAt: '2026-10-29T19:00:00.000Z' }) && (doc.sheets[0].signups[0].promotedAt = 'last week'))),
    { sentence: 'sheets[0].signups[0].promotedAt: must be a time written like 2026-10-29T19:00:00.000Z.', path: 'sheets[0].signups[0].promotedAt' }
  );

  // Only a time as an export writes it, in UTC, that exists and is no later than now: never one the database could not
  // keep, nor one Date would quietly move.
  const promotedAt = (value: string) => file((doc) => Object.assign(doc, { exportedAt: '2026-10-29T18:00:00.000Z' }) && (doc.sheets[0].signups[0].promotedAt = value));
  for (const bad of ['9999-12-31T23:59:59.999-12:00', '0000-01-01T00:00:00.000Z', '1999-12-31T23:59:59.000Z', '2026-02-30T00:00:00.000Z', '2026-10-28T24:00:00Z', '2026-10-21T08:30', '2026-10-21T08:30:00+02:00', '2026-13-01T00:00:00Z']) {
    assert.deepEqual(refusal(promotedAt(bad)), { sentence: 'sheets[0].signups[0].promotedAt: must be a time written like 2026-10-29T19:00:00.000Z.', path: 'sheets[0].signups[0].promotedAt' }, bad);
  }
  assert.deepEqual(
    refusal(promotedAt('2100-01-01T00:00:00.000Z')),
    { sentence: "sheets[0].signups[0].promotedAt: can't be later than now.", path: 'sheets[0].signups[0].promotedAt' },
    'a time ahead would outrun every change a calendar file counts'
  );
  assert.deepEqual(refusal(file((doc) => (doc.exportedAt = '2026-10-29T19:10:00.000Z'))), { sentence: "exportedAt: can't be later than now.", path: 'exportedAt' });
  assert.equal(refusal(file((doc) => (doc.exportedAt = '2026-10-29T19:00:00.000+00:00'))).path, 'exportedAt');
  // Controls: to the second, and a few minutes of another clock ahead, are fine.
  assert.equal(history(read(promotedAt('2026-10-21T08:30:00Z'))).promotedAt, '2026-10-21T08:30:00.000Z');
  assert.deepEqual(read(file((doc) => (doc.exportedAt = '2026-10-29T19:04:00.000Z'))).exportedAt, new Date('2026-10-29T19:04:00.000Z'));

  // The same fields in a file that is not an export: accepted, and nothing of them kept.
  const ordinary = read(file((doc) => Object.assign(doc.sheets[0].signups[0], { addedBy: 'member', signedUpAt: 'whenever', promotedAt: 'whenever', told: true })));
  assert.deepEqual(history(ordinary), { addedBy: undefined, signedUpAt: undefined, promotedAt: undefined, toldAt: undefined });
});

test('texts get the forms\' checks: card and bank numbers, control characters, lengths; a phone number is a fine contact', () => {
  assert.equal(
    refusal(file((doc) => (doc.people[0].name = 'Card 4242 4242 4242 4242'))).sentence,
    'people[0].name: looks like a card or bank number, which this app never keeps.'
  );
  assert.equal(refusal(file((doc) => (doc.people[0].contact = '4242-4242-4242-4242'))).path, 'people[0].contact');
  assert.equal(read(file((doc) => (doc.people[0].contact = '+1 (415) 555-0134'))).plan.people[0]!.contact, '+1 (415) 555-0134');
  assert.equal(refusal(file((doc) => (doc.people[0].name = 'Mike\u202Eylimaf'))).sentence, "people[0].name: has characters this app can't keep.");
  assert.equal(refusal(file((doc) => (doc.people[0].name = '   '))).sentence, "people[0].name: can't be empty.");
  assert.equal(refusal(file((doc) => (doc.sheets[0].title = 'x'.repeat(121)))).sentence, 'sheets[0].title: is longer than 120 characters.');
  assert.equal(refusal(file((doc) => (doc.sheets[0].signups[0].note = 'IBAN DE89370400440532013000'))).path, 'sheets[0].signups[0].note');
  assert.equal(refusal(file((doc) => (doc.sheets[0].everyDate[0].capacity = 501))).sentence, 'sheets[0].everyDate[0].capacity: must be a whole number from 1 to 500.');
  assert.equal(refusal(file((doc) => (doc.sheets[0].dates[0].start = '9:00'))).sentence, 'sheets[0].dates[0].start: must be a 24-hour time written like 09:00.');
  assert.equal(refusal(file((doc) => (doc.sheets[0].dates[0].end = '08:00'))).sentence, 'sheets[0].dates[0].end: must be later than the start.');
  assert.equal(refusal(file((doc) => (doc.sheets[0].dates[0].date = '2026-02-30'))).sentence, 'sheets[0].dates[0].date: must be a real day written like 2026-11-07.');
});

test('a sheet that asks for a note needs one on every sign-up, except in an export (sign-ups made before it asked)', () => {
  const asks = file((doc) => Object.assign(doc.sheets[0], { noteLabel: "What you'll bring", noteRequired: true }));
  assert.equal(refusal(asks).sentence, 'sheets[0].signups[0].note: this sheet asks every sign-up for "What you\'ll bring".');
  asks.exportedAt = '2026-10-29T19:00:00.000Z';
  assert.equal(read(asks).plan.sheets[0]!.signups[0]!.note, '');
});

test('group: each of name, organizer and dues changes only when the file gives it; dues null ends them', () => {
  assert.deepEqual(read(file((doc) => (doc.group = { name: 'U9 Tigers' }))).plan.group, { groupName: 'U9 Tigers' });
  assert.deepEqual(read(file((doc) => (doc.group = { dues: null }))).plan.group, { duesLabel: '', duesAmountCents: null });
  assert.equal(read(file()).plan.group, null);
  assert.equal(refusal(file((doc) => (doc.group = { organizer: { contact: 'hello@trytofu.ai' } }))).sentence, 'group.organizer.name: is missing.');
  assert.equal(refusal(file((doc) => (doc.group = { dues: { amountCents: 4000 } }))).sentence, 'group.dues.label: is missing.');
});
