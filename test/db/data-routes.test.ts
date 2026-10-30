// The data routes, called directly (a Request in, a Response out) on a real database: the import (a stranger gets 401
// as JSON and 403 as a form, then the organizer's limit, media type and size), the export and the spreadsheet (303 for
// strangers), each person's own calendar files (only their own confirmed sign-ups: a waiting one or someone else's is
// the same 404), a SEQUENCE that grows when the event changes and only then, and the organizer's weekly reminder. NOT
// HTTP tests: Next.js's routing, its headers and its logs are checked once the pages run under next start.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import type pg from 'pg';
import { passwordCookie, type SeatTaken, takeSeat } from '../../src/lib/access';
import { IMPORT_LIMIT_BYTES } from '../../src/lib/request';
import { escapeHtml } from '../../src/lib/responses';
import { readSettings, type Settings } from '../../src/lib/settings';
import { applyImport } from '../../src/lib/importer';
import { changeNote, claim } from '../../src/lib/signups';
import { addDate, createSheet, deleteTarget, deletionPreview, editDate, editSlot, setDateCancelled, setSheetStatus } from '../../src/lib/structure';
import { addDays, civilToday } from '../../src/lib/time';
import { newRequestId, newToken, tokenHash } from '../../src/lib/tokens';
import { words } from '../../src/words';
import { poolFor } from '../support/fixtures';
import {
  assertCountsConsistent,
  count,
  dayFromToday,
  endRoutePool,
  formPost,
  get,
  jsonPost,
  member,
  organizer,
  params,
  resetThrottle,
  sheetWithSlots,
  snapshot,
  useDatabase
} from '../support/core';
import { importStrangerProbe, realRoutes as route } from '../support/probes';
import { type Cluster, REPO, startCluster } from '../support/postgres';

let cluster: Cluster;
let url: string;
let pool: pg.Pool;
let settings: Settings;
let seat: SeatTaken;
let organizerCookies: Record<string, string>;

before(async () => {
  cluster = await startCluster();
  url = await cluster.createDatabase({ migrated: true });
  pool = poolFor(url);
  settings = readSettings({ DATABASE_URL: url });
  await useDatabase(url);
  seat = (await takeSeat(pool, settings))!;
  organizerCookies = { ss_org: seat.cookieValue };
});

beforeEach(async () => resetThrottle(pool));

after(async () => {
  await endRoutePool();
  await pool?.end();
  await cluster?.stop();
});

const example = (name: string) => readFileSync(join(REPO, 'examples', `${name}.json`), 'utf8');

async function importPost(request: Request): Promise<Response> {
  const { POST } = await route('organizer/import');
  return POST!(request, params({}));
}

const STRANGERS: Record<string, string>[] = [
  {},
  { ss_org: `seat.${newToken()}` },
  { ss_org: `pw.${Math.floor(Date.now() / 1000)}.${newToken()}` }
];

test('M10b: the import refuses strangers before it reads anything: 401 JSON for a JSON body, 403 for the form, nothing counted', async () => {
  await importStrangerProbe(route, pool, seat.cookieValue);
});

test('the JSON import: a dry run, refusals with their field, the media type and the size; then it imports', async () => {
  const before = await snapshot(pool);
  const dry = await importPost(jsonPost('/organizer/import', example('soccer'), organizerCookies));
  assert.equal(dry.status, 200);
  assert.equal(dry.headers.get('cache-control'), 'private, no-store');
  const checked = (await dry.json()) as { ok: boolean; dryRun: boolean; summary: string; counts: unknown };
  assert.equal(checked.ok, true);
  assert.equal(checked.dryRun, true);
  assert.ok(checked.summary.startsWith('Would make: 1 sheet (Snack sign-up, draft) · 7 dates'), checked.summary);
  assert.deepEqual(await snapshot(pool), before, 'a dry run writes nothing');

  const wrongDay = JSON.parse(example('soccer'));
  wrongDay.sheets[0].dates[0].date = '2026-11-08';
  const refused = await importPost(jsonPost('/organizer/import', JSON.stringify(wrongDay), organizerCookies));
  assert.equal(refused.status, 400);
  assert.deepEqual(await refused.json(), {
    ok: false,
    error: '2026-11-08 is a Sunday, but the file says Sat. Nothing was imported.',
    path: 'sheets[0].dates[0].weekday'
  });
  const misspelled = JSON.parse(example('potluck'));
  misspelled.sheets[0].noteRequred = true;
  assert.deepEqual(await (await importPost(jsonPost('/organizer/import', JSON.stringify(misspelled), organizerCookies))).json(), {
    ok: false,
    error: 'sheets[0]: "noteRequred" isn\'t a field this file can have. Nothing was imported.',
    path: 'sheets[0].noteRequred'
  });
  const plain = await importPost(jsonPost('/organizer/import', example('soccer'), organizerCookies, { 'content-type': 'text/plain' }));
  assert.equal(plain.status, 415);
  assert.deepEqual(await plain.json(), { ok: false, error: words.import.formUnsupported, path: null });
  const big = await importPost(jsonPost('/organizer/import', '{}', organizerCookies, { 'content-length': String(IMPORT_LIMIT_BYTES + 1) }));
  assert.equal(big.status, 413);
  assert.deepEqual(await big.json(), { ok: false, error: 'This file is bigger than 512 KB. Nothing was imported.', path: null });
  assert.deepEqual(await snapshot(pool), before, 'no refusal wrote anything');

  const file = JSON.parse(example('soccer'));
  file.dryRun = false;
  const done = await importPost(jsonPost('/organizer/import', JSON.stringify(file), organizerCookies));
  assert.equal(done.status, 200);
  assert.ok(((await done.json()) as { summary: string }).summary.startsWith('Imported: 1 sheet'));
  const { rows } = await pool.query<{ actor: string; kind: string }>('select actor, kind from activity order by id desc limit 1');
  assert.deepEqual(rows[0], { actor: 'organizer', kind: 'import' });
});

test("the import page's form: Check this file, then Import it once; a second press of the same form imports nothing more", async () => {
  const send = (fields: Record<string, string>) => importPost(formPost('/organizer/import', fields, { cookies: organizerCookies }));
  const checked = await send({ json: example('dues'), action: 'check' });
  assert.equal(checked.status, 200);
  assert.match(checked.headers.get('content-type') ?? '', /^text\/html/);
  assert.ok((await checked.text()).includes('Would make: 2 people'));
  const noRid = await send({ json: example('dues'), action: 'import' });
  assert.equal(noRid.status, 400);
  assert.ok((await noRid.text()).includes(escapeHtml(words.formErrors.form)));

  const people = await count(pool, 'select count(*) from people');
  const rid = newRequestId();
  const first = await send({ json: example('dues'), action: 'import', rid });
  assert.equal(first.status, 200);
  assert.ok((await first.text()).includes('Imported: 2 people'));
  const second = await send({ json: example('dues'), action: 'import', rid });
  assert.equal(second.status, 409);
  assert.ok((await second.text()).includes(escapeHtml(words.import.repeated)));
  assert.equal(await count(pool, 'select count(*) from people'), people + 2, 'the roster was added once');
  // What the sentence says to do: the menu's Import and export opens the page again with a new form, which imports.
  const { GET: importPage } = await route('organizer/import');
  const reopened = await (await importPage!(get('/organizer/import', organizerCookies), params({}))).text();
  const nextRid = /name="rid" value="([0-9a-f-]{36})"/.exec(reopened)?.[1];
  assert.ok(nextRid && nextRid !== rid, 'a new request id');
  const next = await send({ json: JSON.stringify({ format: 'signup-sheet/1', people: [{ key: 'n', name: 'Next file person' }] }), action: 'import', rid: nextRid! });
  assert.equal(next.status, 200);
  assert.equal(await count(pool, "select count(*) from people where name = 'Next file person'"), 1);
  const empty = await send({ json: '', action: 'check' });
  assert.equal(empty.status, 400);
  assert.ok((await empty.text()).includes(escapeHtml(`${words.import.empty} ${words.import.nothingImported}`)));
});

test("imports are limited to 30 an hour for the copy: the 31st is refused with 429, and so is the form's", async () => {
  for (let i = 0; i < 30; i += 1) {
    assert.equal((await importPost(jsonPost('/organizer/import', '{}', organizerCookies))).status, 400);
  }
  const over = await importPost(jsonPost('/organizer/import', example('soccer'), organizerCookies));
  assert.equal(over.status, 429);
  assert.deepEqual(await over.json(), { ok: false, error: words.throttle.import, path: null });
  const form = await importPost(formPost('/organizer/import', { json: example('dues'), action: 'check' }, { cookies: organizerCookies }));
  assert.equal(form.status, 429);
});

test('organizer downloads send anyone else to /organizer (303) with nothing in the answer; the organizer gets them', async () => {
  await sheetWithSlots(pool, { slug: 'guarded', capacities: [1] });
  const downloads: [string, string, Record<string, string>][] = [
    ['organizer/export.json', '/organizer/export.json', {}],
    ['organizer/sheets/[slug]/export.csv', '/organizer/sheets/guarded/export.csv', { slug: 'guarded' }],
    ['organizer/reminder.ics', '/organizer/reminder.ics?day=thu&time=18:00', {}]
  ];
  const wrongKey = passwordCookie({ ...settings, organizerPassword: 'not the saved password at all' }).cookieValue;
  for (const [path, address, values] of downloads) {
    const { GET } = await route(path);
    for (const cookies of [...STRANGERS, { ss_org: wrongKey }]) {
      const answer = await GET!(get(address, cookies), params(values));
      assert.equal(answer.status, 303, `${path} with ${Object.values(cookies)[0]?.slice(0, 5) ?? 'no cookie'}`);
      assert.equal(answer.headers.get('location'), '/organizer');
      assert.equal(await answer.text(), '');
    }
    const control = await GET!(get(address, organizerCookies), params(values));
    assert.equal(control.status, 200, `control: the organizer gets ${path}`);
  }
});

test('the export: one attachment with contacts and paid state, never a link or a hash; the spreadsheet: BOM, CRLF, no formulas', async () => {
  const { slotIds } = await sheetWithSlots(pool, { slug: 'roster-sheet', capacities: [2] });
  const signed = await claim(
    pool,
    settings,
    { slug: 'roster-sheet', slotId: slotIds[0]!, requestId: newRequestId(), who: { kind: 'new', name: '=HYPERLINK("http://x.example","x")', contact: 'privacy-probe@example.com' }, note: '+1 note', rules: 'member' },
    member()
  );
  assert.ok(signed.kind === 'signed-up' && signed.token);
  const activity = await count(pool, 'select count(*) from activity');

  const { GET: exportGet } = await route('organizer/export.json');
  const exported = await exportGet!(get('/organizer/export.json', organizerCookies), params({}));
  assert.equal(exported.status, 200);
  assert.equal(exported.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.match(exported.headers.get('content-disposition') ?? '', /^attachment; filename="signup-sheet-\d{4}-\d{2}-\d{2}\.json"$/);
  assert.equal(exported.headers.get('cache-control'), 'private, no-store');
  const text = await exported.text();
  assert.ok(text.includes('privacy-probe@example.com'));
  assert.ok(!text.includes(signed.token!), 'no link token');
  assert.equal(JSON.parse(text).format, 'signup-sheet/1');

  const { GET: csvGet } = await route('organizer/sheets/[slug]/export.csv');
  const csv = await csvGet!(get('/organizer/sheets/roster-sheet/export.csv', organizerCookies), params({ slug: 'roster-sheet' }));
  assert.equal(csv.status, 200);
  assert.equal(csv.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.match(csv.headers.get('content-disposition') ?? '', /^attachment; filename="roster-sheet-\d{4}-\d{2}-\d{2}\.csv"$/);
  const bytes = Buffer.from(await csv.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'a byte order mark');
  const lines = bytes.subarray(3).toString('utf8').split('\r\n');
  assert.equal(lines[0], words.csv.header.map((cell) => `"${cell}"`).join(','));
  assert.ok(lines[1]!.includes(`"'=HYPERLINK(""http://x.example"",""x"")"`), lines[1]);
  assert.ok(lines[1]!.includes(`"'+1 note"`));
  assert.ok(lines[1]!.includes('"privacy-probe@example.com"'));
  assert.ok(!bytes.toString('utf8').includes(signed.token!));
  assert.equal(lines.at(-1), '', 'CRLF after the last row');
  for (const slug of ['no-such-sheet', 'Bad_Slug']) {
    assert.equal((await csvGet!(get(`/organizer/sheets/${slug}/export.csv`, organizerCookies), params({ slug }))).status, 404);
  }
  assert.equal(await count(pool, 'select count(*) from activity'), activity, 'a GET writes no activity');
});

const unfold = (text: string) => text.replace(/\r\n /g, '');

async function calendarFile(token: string, file: string): Promise<Response> {
  const { GET } = await route('me/[token]/calendar/[file]');
  return GET!(get(`/me/${token}/calendar/${file}`), params({ token, file }));
}

async function joinAs(slug: string, slotId: string, name: string) {
  const contact = `${name.split(' ')[0]!.toLowerCase()}@example.com`;
  const result = await claim(pool, settings, { slug, slotId, requestId: newRequestId(), who: { kind: 'new', name, contact }, note: '', rules: 'member' }, member());
  assert.ok(result.kind === 'signed-up' && result.token);
  return { signupId: result.signupId, token: result.token!, status: result.status, personId: result.personId };
}

test("calendar files: a person's own confirmed sign-up only; waiting, someone else's, a draft's or a bad link is the same 404", async () => {
  const { dateId, slotIds } = await sheetWithSlots(pool, { slug: 'cal', capacities: [1, 1] });
  const a = await joinAs('cal', slotIds[0]!, 'Mike Example');
  const b = await joinAs('cal', slotIds[0]!, 'Frank Example');
  const c = await joinAs('cal', slotIds[1]!, 'Frank Sample');
  assert.deepEqual([a.status, b.status, c.status], ['confirmed', 'waiting', 'confirmed']);
  const activity = await count(pool, 'select count(*) from activity');

  const own = await calendarFile(a.token, `${a.signupId}.ics`);
  assert.equal(own.status, 200);
  assert.equal(own.headers.get('content-type'), 'text/calendar; charset=utf-8');
  assert.equal(own.headers.get('content-disposition'), `attachment; filename="cal-${dayFromToday(10)}.ics"`);
  const text = unfold(await own.text());
  for (const line of [`UID:signup-${a.signupId}@127.0.0.1:3000`, 'STATUS:CONFIRMED', 'BEGIN:VALARM']) assert.ok(text.includes(`${line}\r\n`), line);
  assert.ok(text.includes(`your private link\\, keep it to yourself): http://127.0.0.1:3000/me/${a.token}`));
  assert.ok(text.includes('Sign-up sheet: http://127.0.0.1:3000/s/cal'));
  assert.ok(text.includes('You signed up as Mike Example.'));
  for (const other of [b.token, c.token, 'Frank Example', 'Frank Sample', 'frank@example.com']) assert.ok(!text.includes(other), other);

  const unknownLink = escapeHtml(words.member.unknownLink);
  for (const [token, file, what] of [
    [b.token, `${b.signupId}.ics`, 'a waiting sign-up'],
    [a.token, `${c.signupId}.ics`, "someone else's sign-up"],
    [a.token, `${b.signupId}.ics`, "someone else's waiting sign-up"],
    [newToken(), `${a.signupId}.ics`, 'a link that matches nobody'],
    ['short', `${a.signupId}.ics`, 'a malformed link'],
    [a.token, 'x.ics', 'a file name that is no sign-up'],
    [a.token, `${a.signupId}.txt`, 'another kind of file']
  ] as const) {
    const answer = await calendarFile(token, file);
    assert.equal(answer.status, 404, what);
    assert.ok((await answer.text()).includes(unknownLink), what);
  }
  assert.equal((await calendarFile(c.token, `${c.signupId}.ics`)).status, 200, "control: Frank Sample's own file");

  await pool.query("update sheets set status = 'draft' where slug = 'cal'");
  assert.equal((await calendarFile(a.token, `${a.signupId}.ics`)).status, 404, 'a draft sheet');
  await pool.query("update sheets set status = 'open' where slug = 'cal'");

  await setDateCancelled(pool, { dateId, cancelled: true }, organizer());
  const cancelled = unfold(await (await calendarFile(a.token, `${a.signupId}.ics`)).text());
  assert.ok(cancelled.includes('STATUS:CANCELLED\r\n') && !cancelled.includes('BEGIN:VALARM'));
  await setDateCancelled(pool, { dateId, cancelled: false }, organizer());

  const { GET: all } = await route('me/[token]/calendar.ics');
  const mine = await all!(get(`/me/${a.token}/calendar.ics`), params({ token: a.token }));
  assert.equal(mine.status, 200);
  assert.equal(mine.headers.get('content-disposition'), 'attachment; filename="my-sign-ups.ics"');
  assert.equal(unfold(await mine.text()).match(/BEGIN:VEVENT/g)?.length, 1);
  const waitingOnly = await all!(get(`/me/${b.token}/calendar.ics`), params({ token: b.token }));
  assert.equal(waitingOnly.status, 404);
  assert.ok((await waitingOnly.text()).includes(escapeHtml(words.ics.noneUpcoming)));
  assert.equal((await all!(get(`/me/${newToken()}/calendar.ics`), params({ token: 'x' }))).status, 404);
  assert.equal(await count(pool, "select count(*) from activity where kind not in ('date_cancel', 'date_uncancel')"), activity, 'calendar GETs write nothing');
  await assertCountsConsistent(pool);
});

/** Moves everything a calendar file's SEQUENCE reads one day into the past, keeping the differences between them. */
async function ageOneDay(): Promise<void> {
  for (const sql of [
    `update signups set created_at = created_at - interval '1 day', queued_at = queued_at - interval '1 day',
            revised_at = revised_at - interval '1 day', changed_at = changed_at - interval '1 day', promoted_at = promoted_at - interval '1 day'`,
    "update slots set revised_at = revised_at - interval '1 day'",
    "update dates set revised_at = revised_at - interval '1 day'",
    "update sheets set revised_at = revised_at - interval '1 day'",
    "update people set revised_at = revised_at - interval '1 day', link_made_at = link_made_at - interval '1 day'",
    "update app_state set revised_at = revised_at - interval '1 day'"
  ]) {
    await pool.query(sql);
  }
}

test("SEQUENCE grows when what the event shows changes (an organizer's new time, the person's own note) and never on a download", async () => {
  const { dateId, slotIds } = await sheetWithSlots(pool, { slug: 'sequence', capacities: [1] });
  const a = await joinAs('sequence', slotIds[0]!, 'Mike Example');
  const file = async () => unfold(await (await calendarFile(a.token, `${a.signupId}.ics`)).text());
  const sequence = (text: string) => Number(/\r\nSEQUENCE:(\d+)\r\n/.exec(text)![1]);

  await ageOneDay();
  const first = await file();
  assert.equal(sequence(await file()), sequence(first), 'downloading again changes nothing');
  await editSlot(pool, { slotId: slotIds[0]!, slot: { label: 'Slot 1', description: '', capacity: 2 } }, organizer());
  assert.equal(sequence(await file()), sequence(first), 'a capacity the event does not show changes nothing');

  await editDate(pool, { dateId, date: { onDate: dayFromToday(10), startsAt: '10:00', endsAt: '11:00', label: '', place: '' } }, organizer());
  const moved = await file();
  assert.ok(sequence(moved) >= sequence(first) + 86_000, `${sequence(first)} then ${sequence(moved)}`);
  assert.ok(!moved.includes(first.match(/DTSTART:\d+T\d+Z/)![0]), 'the new time');

  await ageOneDay();
  assert.equal(sequence(await file()), sequence(moved), 'aging every time it reads keeps the same SEQUENCE');
  await pool.query('update signups set told_at = now() where id = $1', [a.signupId]);
  const changedBefore = (await pool.query('select changed_at from signups where id = $1', [a.signupId])).rows[0];
  await changeNote(pool, { signupId: a.signupId, owner: { personId: a.personId, tokenHash: tokenHash(a.token) }, note: 'Bringing oranges' }, member());
  const noted = await file();
  assert.ok(sequence(noted) >= sequence(moved) + 86_000, `${sequence(moved)} then ${sequence(noted)}`);
  assert.ok(noted.includes('Your note: Bringing oranges'));
  const after = (await pool.query('select changed_at, told_at is not null as told from signups where id = $1', [a.signupId])).rows[0];
  assert.deepEqual(after, { ...changedBefore, told: true }, "the person's own note is not a change by the organizer");
});

test("the organizer's weekly reminder: until the day after the last date ahead on an open sheet; a day or time it can't use is 400", async () => {
  const { GET } = await route('organizer/reminder.ics');
  const send = (query: string) => GET!(get(`/organizer/reminder.ics${query}`, organizerCookies), params({}));
  const last = (
    await pool.query<{ last: string }>(
      `select max(d.on_date) as last from dates d join sheets h on h.id = d.sheet_id
        where h.status = 'open' and d.cancelled_at is null and d.on_date >= $1::date`,
      [civilToday('America/Los_Angeles')]
    )
  ).rows[0]!.last;
  const answer = await send('?day=sun&time=17:30');
  assert.equal(answer.status, 200);
  assert.equal(answer.headers.get('content-disposition'), 'attachment; filename="sign-up-reminder.ics"');
  const text = unfold(await answer.text());
  assert.ok(text.includes(`RRULE:FREQ=WEEKLY;BYDAY=SU;UNTIL=${addDays(last, 1).replace(/-/g, '')}T000000\r\n`), text);
  assert.ok(text.includes('UID:organizer-reminder-sun-1730@127.0.0.1:3000\r\n'));
  assert.ok(text.includes('http://127.0.0.1:3000/organizer'));
  for (const query of ['?day=xyz', '?time=25:00', '?time=6pm', '?day=thu&time=9:00']) {
    const bad = await send(query);
    assert.equal(bad.status, 400, query);
    assert.ok((await bad.text()).includes(escapeHtml(words.ics.badReminder)));
  }

  const fresh = await cluster.createDatabase({ migrated: true });
  await useDatabase(fresh);
  const local = poolFor(fresh);
  try {
    const freshSeat = (await takeSeat(local, readSettings({ DATABASE_URL: fresh })))!;
    const nothing = await GET!(get('/organizer/reminder.ics', { ss_org: freshSeat.cookieValue }), params({}));
    assert.equal(nothing.status, 404);
    assert.ok((await nothing.text()).includes(escapeHtml(words.ics.nothingToRemind)));
  } finally {
    await local.end();
    await useDatabase(url);
  }
});

test("the weekly reminder's SEQUENCE only grows: every shorter season (a date deleted, cancelled or moved, a sheet closed or deleted) replaces the longer one", async () => {
  const fresh = await cluster.createDatabase({ migrated: true });
  await useDatabase(fresh);
  const local = poolFor(fresh);
  try {
    const freshSeat = (await takeSeat(local, readSettings({ DATABASE_URL: fresh })))!;
    const { GET } = await route('organizer/reminder.ics');
    const file = async () => {
      const answer = await GET!(get('/organizer/reminder.ics?day=thu&time=18:00', { ss_org: freshSeat.cookieValue }), params({}));
      assert.equal(answer.status, 200);
      return unfold(await answer.text());
    };
    const sequence = (text: string) => Number(/\r\nSEQUENCE:(\d+)\r\n/.exec(text)![1]);
    const until = (text: string) => /;UNTIL=(\d{8})T000000\r\n/.exec(text)![1];
    const dayAfter = (days: number) => addDays(dayFromToday(days), 1).replace(/-/g, '');
    const sheet = (slug: string) =>
      createSheet(local, { slug, title: slug, description: '', timezone: 'America/Los_Angeles', place: '', names: 'full', noteLabel: '', noteRequired: false, listed: true, status: 'open' }, organizer());
    const add = async (slug: string, days: number) => {
      const added = await addDate(local, { slug, date: { onDate: dayFromToday(days), startsAt: '09:00', endsAt: null, label: '', place: '' }, withSlots: false }, organizer());
      assert.equal(added.kind, 'added');
      return (added as { dateId: string }).dateId;
    };
    const remove = async (target: { kind: 'date'; id: string } | { kind: 'sheet'; slug: string }) => {
      const preview = (await deletionPreview(local, target))!;
      assert.equal((await deleteTarget(local, { target, seen: preview.seen }, organizer())).kind, 'deleted');
    };

    await sheet('season');
    const first = await add('season', 10);
    const second = await add('season', 17);
    const third = await add('season', 24);
    const steps: { what: string; text: string }[] = [{ what: 'three dates', text: await file() }];
    assert.equal(until(steps[0]!.text), dayAfter(24));
    assert.equal(sequence(await file()), sequence(steps[0]!.text), 'downloading again changes nothing');
    const step = async (what: string, change: () => Promise<unknown>, lastDay: number) => {
      await change();
      const text = await file();
      assert.equal(until(text), dayAfter(lastDay), `${what}: the season's last day`);
      const before = steps.at(-1)!;
      assert.ok(sequence(text) > sequence(before.text), `${what}: SEQUENCE ${sequence(before.text)} then ${sequence(text)}`);
      steps.push({ what, text });
    };
    await step('the last date deleted', () => remove({ kind: 'date', id: third }), 17);
    await step('the new last date cancelled', () => setDateCancelled(local, { dateId: second, cancelled: true }, organizer()), 10);
    await step('a date moved later', () => editDate(local, { dateId: first, date: { onDate: dayFromToday(31), startsAt: '09:00', endsAt: null, label: '', place: '' } }, organizer()), 31);
    await step('a later sheet opened', async () => {
      await sheet('later');
      await add('later', 45);
    }, 45);
    await step('that sheet closed', () => setSheetStatus(local, { slug: 'later', status: 'closed' }, organizer()), 31);
    await step('an imported sheet ending later', () => applyImport(local, {
      replace: false,
      group: null,
      people: [],
      sheets: [{
        slug: 'imported', title: 'Imported', description: '', timezone: 'America/Los_Angeles', place: '', names: 'full', noteLabel: '',
        noteRequired: false, listed: true, status: 'open',
        dates: [{ onDate: dayFromToday(52), startsAt: null, endsAt: null, label: '', place: '', slots: [] }],
        signups: []
      }]
    }, organizer()), 52);
    await step('that sheet deleted', () => remove({ kind: 'sheet', slug: 'imported' }), 31);
    assert.equal(sequence(await file()), sequence(steps.at(-1)!.text), 'downloading again still changes nothing');
  } finally {
    await local.end();
    await useDatabase(url);
  }
});
