// The pages, called directly (a Request in, a whole HTML document out) on a real database. This proves what the route
// handlers answer and what their HTML holds; it is NOT an HTTP or browser test: next.config.ts headers, Next.js's own
// routing, the CSS and the script are checked over HTTP and in a browser on a next start server (docs/verification.md).
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import type pg from 'pg';
import { type SeatTaken, takeSeat } from '../../src/lib/access';
import { escapeHtml } from '../../src/lib/responses';
import { readSettings } from '../../src/lib/settings';
import { formatDate, formatMoment } from '../../src/lib/time';
import { newRequestId, newToken } from '../../src/lib/tokens';
import { words } from '../../src/words';
import { poolFor } from '../support/fixtures';
import {
  assertCountsConsistent,
  changedCopy,
  cookieSet,
  count,
  dayFromToday,
  endRoutePool,
  FAIL_HOOK,
  formPost,
  get,
  jsonPost,
  params,
  personWithLink,
  resetThrottle,
  roster,
  sheetWithSlots,
  snapshot,
  useDatabase
} from '../support/core';
import { copyRoutes, organizerPagesProbe, pageFixture, realRoutes as route } from '../support/probes';
import { type Cluster, startCluster } from '../support/postgres';

let cluster: Cluster;
let url: string;
let pool: pg.Pool;
let seat: SeatTaken;
let org: Record<string, string>;

before(async () => {
  cluster = await startCluster();
  url = await cluster.createDatabase({ migrated: true });
  pool = poolFor(url);
  await useDatabase(url);
  seat = (await takeSeat(pool, readSettings({ DATABASE_URL: url })))!;
  org = { ss_org: seat.cookieValue };
});

beforeEach(async () => resetThrottle(pool));

after(async () => {
  await endRoutePool();
  await pool?.end();
  await cluster?.stop();
});

async function open(path: string, address: string, values: Record<string, string> = {}, cookies: Record<string, string> = {}): Promise<Response> {
  const { GET } = await route(path);
  assert.ok(GET, `${path} has a GET`);
  return GET(get(address, cookies), params(values));
}

async function send(path: string, address: string, fields: Record<string, string>, values: Record<string, string> = {}, cookies: Record<string, string> = {}): Promise<Response> {
  const { POST } = await route(path);
  assert.ok(POST, `${path} has a POST`);
  return POST(formPost(address, fields, { cookies }), params(values));
}

async function signup(slotId: string, personId: string, status: 'confirmed' | 'waiting', note = ''): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    "insert into signups (slot_id, person_id, status, note, added_by) values ($1, $2, $3, $4, 'member') returning id",
    [slotId, personId, status, note]
  );
  return rows[0]!.id;
}

const NASTY = '<script>alert("x")</script>';

test('T33: / answers 200 in every healthy state and never redirects: setup, held (none, one, several), password, short, expired, unclaimed', async () => {
  try {
    await rootStates();
  } finally {
    process.env.ORGANIZER_PASSWORD = '';
    await useDatabase(url);
  }
});

async function rootStates(): Promise<void> {
  const fresh = await cluster.createDatabase({ migrated: true });
  const local = poolFor(fresh);
  await useDatabase(fresh);
  const root = async () => {
    const answer = await open('', '/');
    assert.equal(answer.status, 200);
    assert.equal(answer.headers.get('location'), null);
    assert.equal(answer.headers.get('cache-control'), 'private, no-store');
    assert.match(answer.headers.get('content-type') ?? '', /^text\/html; charset=utf-8$/);
    return answer.text();
  };
  try {
    assert.ok((await root()).includes(escapeHtml(words.organizer.setupOpen.heading)), 'setup-open: the setup page');
    assert.equal((await local.query<{ seat_state: string }>('select seat_state from app_state')).rows[0]!.seat_state, 'open', 'a GET never takes the seat');

    await takeSeat(local, readSettings({ DATABASE_URL: fresh }));
    assert.ok((await root()).includes(escapeHtml(words.home.nothingOpen)), 'held, no sheet');

    await sheetWithSlots(local, { slug: 'only', capacities: [1] });
    await sheetWithSlots(local, { slug: 'hidden', capacities: [1] });
    await local.query("update sheets set listed = false where slug = 'hidden'");
    await sheetWithSlots(local, { slug: 'drafted', capacities: [1], status: 'draft' });
    let body = await root();
    assert.ok(body.includes('<link rel="canonical" href="http://127.0.0.1:3000/s/only">'), 'one listed open sheet, in place');
    assert.ok(body.includes(escapeHtml(words.sheet.takeIt)));

    await sheetWithSlots(local, { slug: 'second', capacities: [1] });
    body = await root();
    assert.ok(body.includes('href="/s/only"') && body.includes('href="/s/second"'), 'several: a list');
    assert.ok(!body.includes('/s/hidden') && !body.includes('/s/drafted'), 'an unlisted or draft sheet is not listed');

    process.env.ORGANIZER_PASSWORD = 'correct horse battery staple';
    assert.ok((await root()).includes('href="/s/second"'), 'password, several');
    await local.query("update sheets set status = 'closed' where slug = 'second'");
    assert.ok((await root()).includes('/s/only">'), 'password, one');
    process.env.ORGANIZER_PASSWORD = 'short';
    await root();
  } finally {
    process.env.ORGANIZER_PASSWORD = '';
    await local.end();
  }

  // A seat that ran out, and a copy nobody set up in its first day: still 200, the plain page.
  for (const state of ['expired', 'unclaimed'] as const) {
    const other = await cluster.createDatabase({ migrated: true });
    const db = poolFor(other);
    await useDatabase(other);
    try {
      if (state === 'expired') {
        await takeSeat(db, readSettings({ DATABASE_URL: other }));
        await db.query("update app_state set seat_until = now() - interval '1 minute'");
      } else {
        await db.query("update app_state set created_at = now() - interval '2 days'");
      }
      const body = await root();
      assert.ok(body.includes(escapeHtml(words.home.nothingOpen)), state);
      assert.ok(!body.includes(escapeHtml(words.organizer.setupOpen.button)), `${state}: no setup button`);
    } finally {
      await db.end();
    }
  }
}

test('a database that cannot be reached: the pages answer 503 with the waking sentence, never details or the address', async () => {
  await useDatabase('postgresql://app_probe:secret-probe@127.0.0.1:1/nothing');
  try {
    const pages: [string, string, Record<string, string>, Record<string, string>][] = [
      ['', '/', {}, {}],
      ['s/[slug]', '/s/snacks', { slug: 'snacks' }, {}],
      ['s/[slug]/slots/[id]', '/s/snacks/slots/1', { slug: 'snacks', id: '1' }, {}],
      ['me', '/me', {}, { ss_me: newToken() }],
      // Without a cookie too: its footer reads the organizer's name.
      ['me', '/me', {}, {}],
      ['organizer', '/organizer', {}, {}]
    ];
    for (const [path, address, values, cookies] of pages) {
      const answer = await open(path, address, values, cookies);
      assert.equal(answer.status, 503, `${path || '/'}${Object.keys(cookies).length > 0 ? ' with a cookie' : ''}`);
      assert.equal(answer.headers.get('retry-after'), '30');
      const body = await answer.text();
      assert.ok(body.includes(escapeHtml(words.waking)), path);
      for (const detail of ['secret-probe', '127.0.0.1:1', 'ECONNREFUSED', 'app_probe']) assert.ok(!body.includes(detail), `${path || '/'}: ${detail}`);
    }
  } finally {
    await useDatabase(url);
  }
});

test('T22 on the pages: names (or "Taken") and notes, never a contact, a token, a paid state or dues; every value is escaped', async () => {
  const { sheetId, slotIds } = await sheetWithSlots(pool, { slug: 'escape-full', capacities: [2, 1] });
  await pool.query('update sheets set title = $2, description = $3, place = $4 where id = $1', [sheetId, `Snacks ${NASTY}`, `Bring "fruit" & water\n\n${NASTY}`, 'Field <3>']);
  await pool.query('update slots set label = $2, description = $3 where id = $1', [slotIds[0], '<img src=x onerror=alert(1)>', `"desc" ${NASTY}`]);
  await pool.query("update app_state set group_name = $1, organizer_name = $2, organizer_contact = 'organizer-probe@example.test', dues_label = 'DUESPROBE'", [
    "Mike's <b>group</b>",
    'Frank "the organizer"'
  ]);
  const mike = await personWithLink(pool, "Mike's <b>family</b>", 'privacy-probe-mike@example.test');
  await pool.query("update people set paid = true, paid_note = 'PAIDPROBE' where id = $1", [mike.id]);
  await signup(slotIds[0]!, mike.id, 'confirmed', `"Oranges" & ${NASTY}`);

  const body = await (await open('s/[slug]', '/s/escape-full', { slug: 'escape-full' })).text();
  for (const raw of ['<script>alert', '<img src=x', '<b>family', '<b>group', 'onerror=alert(1)>', '"Oranges"']) assert.ok(!body.includes(raw), raw);
  for (const shown of ["Mike's <b>family</b>", `"Oranges" & ${NASTY}`, `Snacks ${NASTY}`, 'Frank "the organizer"', 'Field <3>']) assert.ok(body.includes(escapeHtml(shown)), shown);
  for (const hidden of ['privacy-probe-mike', 'organizer-probe', 'PAIDPROBE', 'DUESPROBE', mike.token]) assert.ok(!body.includes(hidden), hidden);

  const { slotIds: takenSlots } = await sheetWithSlots(pool, { slug: 'escape-taken', capacities: [1], names: 'taken' });
  const frank = await personWithLink(pool, 'NAMEPROBE Frank', 'privacy-probe-frank@example.test');
  await signup(takenSlots[0]!, frank.id, 'confirmed', 'Visible note');
  const taken = await (await open('s/[slug]', '/s/escape-taken', { slug: 'escape-taken' })).text();
  assert.ok(!taken.includes('NAMEPROBE') && !taken.includes('privacy-probe-frank'), 'a Taken sheet shows no name');
  assert.ok(taken.includes(`<li>${words.sheet.taken} <span class="note">Visible note</span></li>`), 'Taken, with the public note');

  // The claim form of the person this phone remembers: their name, never their contact; one request id per form.
  const claim = await (await open('s/[slug]/slots/[id]', `/s/escape-full/slots/${slotIds[1]}`, { slug: 'escape-full', id: slotIds[1]! }, { ss_me: mike.token })).text();
  assert.ok(claim.includes(escapeHtml(words.claim.signingUpAs("Mike's <b>family</b>"))));
  assert.ok(!claim.includes('privacy-probe-mike') && !claim.includes(mike.token));
  const rids = [...claim.matchAll(/name="rid" value="([0-9a-f-]{36})"/g)].map((match) => match[1]);
  assert.equal(rids.length, 2);
  assert.notEqual(rids[0], rids[1]);
  assert.ok(claim.includes('name="ss_hp"') && claim.includes('tabindex="-1"') && claim.includes('aria-hidden="true"'), 'the honeypot');
  // The place they already hold says so instead of a second sign-up.
  const held = await (await open('s/[slug]/slots/[id]', `/s/escape-full/slots/${slotIds[0]}`, { slug: 'escape-full', id: slotIds[0]! }, { ss_me: mike.token })).text();
  assert.ok(held.includes(escapeHtml(words.claim.already)));
});

test('the claim form shown again keeps what was typed and its request id; a closed sheet or a past date shows why, with no form', async () => {
  const { slotIds } = await sheetWithSlots(pool, { slug: 'again', capacities: [1] });
  const before = await snapshot(pool);
  const rid = newRequestId();
  const answer = await send('s/[slug]/slots/[id]/claim', `/s/again/slots/${slotIds[0]}/claim`, { rid, name: '', contact: 'frank@example.test', note: `Bringing <oranges> & "juice"` }, { slug: 'again', id: slotIds[0]! });
  assert.equal(answer.status, 400);
  const page = await answer.text();
  assert.ok(page.includes('role="alert"') && page.includes(escapeHtml(`${words.fields.name}: ${words.text.required}`)));
  assert.ok(page.includes(`name="rid" value="${rid}"`), 'the same request id');
  assert.ok(page.includes('value="frank@example.test"') && page.includes(escapeHtml('Bringing <oranges> & "juice"')), 'what was typed');
  assert.ok(page.includes('aria-invalid="true"'));
  assert.deepEqual(await snapshot(pool), before, 'nothing written');
  const fixed = await send('s/[slug]/slots/[id]/claim', `/s/again/slots/${slotIds[0]}/claim`, { rid, name: "Frank's family", contact: 'frank@example.test', note: '' }, { slug: 'again', id: slotIds[0]! });
  assert.equal(fixed.status, 303, 'the same form, fixed, signs up');
  assert.deepEqual(await roster(pool, slotIds[0]!), { confirmed: ["Frank's family"], waiting: [] });

  await pool.query("update sheets set status = 'closed' where slug = 'again'");
  const closed = await (await open('s/[slug]/slots/[id]', `/s/again/slots/${slotIds[0]}`, { slug: 'again', id: slotIds[0]! })).text();
  assert.ok(closed.includes(escapeHtml(words.formErrors.closed)) && !closed.includes('name="rid"'));
  const { slotIds: past } = await sheetWithSlots(pool, { slug: 'gone-by', capacities: [1], onDate: dayFromToday(-2) });
  const passed = await (await open('s/[slug]/slots/[id]', `/s/gone-by/slots/${past[0]}`, { slug: 'gone-by', id: past[0]! })).text();
  assert.ok(passed.includes(escapeHtml(words.formErrors.past)) && !passed.includes('name="rid"'));
  const draft = await sheetWithSlots(pool, { slug: 'not-yet', capacities: [1], status: 'draft' });
  assert.equal((await open('s/[slug]/slots/[id]', `/s/not-yet/slots/${draft.slotIds[0]}`, { slug: 'not-yet', id: draft.slotIds[0]! })).status, 404);
  assert.equal((await open('s/[slug]', '/s/not-yet', { slug: 'not-yet' })).status, 404, 'a draft is not public');
  const preview = await open('s/[slug]', '/s/not-yet', { slug: 'not-yet' }, org);
  assert.equal(preview.status, 200, "the organizer's preview of a draft");
  assert.ok(!(await preview.text()).includes(escapeHtml(words.sheet.takeIt)), 'no Take it on a draft');
});

test('/me: no cookie 200 with how to get in; a stale cookie 404, cleared; the own page with own contact and link, generic titles, nobody else', async () => {
  await pool.query("update app_state set organizer_name = 'Mike', organizer_contact = 'organizer-me-probe@example.test'");
  const none = await open('me', '/me');
  assert.equal(none.status, 200);
  const noneBody = await none.text();
  assert.ok(noneBody.includes(escapeHtml(words.member.noCookie)));
  assert.ok(noneBody.includes(escapeHtml(words.sheet.organizedBy('Mike'))) && !noneBody.includes('organizer-me-probe'), "the public footer: the organizer's name, never a contact");
  const stale = await open('me', '/me', {}, { ss_me: newToken() });
  assert.equal(stale.status, 404);
  assert.equal(cookieSet(stale, 'ss_me'), '', 'cleared');

  const { slotIds } = await sheetWithSlots(pool, { slug: 'mine', capacities: [1, 1] });
  const frank = await personWithLink(pool, "Frank's family", 'frank-own@example.test');
  const mike = await personWithLink(pool, "Mike's family", 'mike-other@example.test');
  const confirmed = await signup(slotIds[0]!, frank.id, 'confirmed', 'Oranges');
  const theirs = await signup(slotIds[1]!, mike.id, 'confirmed');
  const waiting = await signup(slotIds[1]!, frank.id, 'waiting');
  const activity = await count(pool, 'select count(*) from activity');

  const answer = await open('me', `/me?new=${confirmed}`, {}, { ss_me: frank.token });
  assert.equal(answer.status, 200);
  const body = await answer.text();
  assert.ok(body.includes('<title>Your sign-ups</title>') && body.includes(`content="${escapeHtml(words.me.previewTitle)}"`));
  assert.ok(!/<title>[^<]*Frank/.test(body), 'the title names nobody');
  assert.ok(body.includes('frank-own@example.test'), 'their own contact, on their own page');
  assert.ok(body.includes(`value="http://127.0.0.1:3000/me/${frank.token}"`), 'their own link, in its box');
  assert.ok(body.includes(`You&#39;re in: Slot 1, `), 'the after-claim panel');
  assert.ok(body.includes(`href="/me/${frank.token}/calendar/${confirmed}.ics"`), 'a calendar button for the confirmed one');
  assert.ok(!body.includes(`/calendar/${waiting}.ics`), 'none for the waiting one');
  assert.ok(body.includes(escapeHtml(words.me.waiting(1))));
  assert.ok(body.includes(escapeHtml(words.me.googleHint)) && body.includes('https://calendar.google.com/calendar/render?action=TEMPLATE'));
  for (const other of ['mike-other@example.test', mike.token, "Mike&#39;s family"]) assert.ok(!body.includes(other), other);
  // "Send it to myself": mail to the address they saved (their own page shows it already); never the share sheet.
  const start = body.indexOf('<label for="to-myself">');
  const toMyself = body.slice(start, body.indexOf('</details>', start));
  assert.ok(start > 0 && toMyself.includes('href="mailto:frank-own@example.test?subject='), 'Email, to their own address');
  assert.ok(!toMyself.includes('sms:') && !toMyself.includes('mailto:?') && !toMyself.includes('wa.me'), 'nothing addressed to nobody, no chat list');
  assert.ok(!toMyself.includes('data-share') && toMyself.includes('data-copy="to-myself"'), 'Copy, and no Share: it offers the group chat first');

  // Their own cancel and move pages; another person's sign-up is the unknown-link 404 (G6).
  const own = await open('me/signups/[id]/cancel', `/me/signups/${confirmed}/cancel`, { id: confirmed }, { ss_me: frank.token });
  assert.equal(own.status, 200);
  assert.ok((await own.text()).includes(escapeHtml(words.me.yesCancel)));
  for (const action of ['cancel', 'move'] as const) {
    const other = await open(`me/signups/[id]/${action}`, `/me/signups/${theirs}/${action}`, { id: theirs }, { ss_me: frank.token });
    assert.equal(other.status, 404, `${action} page for another person's sign-up`);
    assert.ok(!(await other.text()).includes('Mike'), action);
  }
  const move = await (await open('me/signups/[id]/move', `/me/signups/${confirmed}/move`, { id: confirmed }, { ss_me: frank.token })).text();
  assert.ok(move.includes(escapeHtml(words.me.noRoom)), 'the other place is full (and Frank waits on it)');
  assert.ok((await (await open('me/new-link', '/me/new-link', {}, { ss_me: frank.token })).text()).includes(escapeHtml(words.member.newLinkConfirm)));
  assert.equal(await count(pool, 'select count(*) from activity'), activity, 'a GET writes no activity');
});

test("a member's new link is shown once (200, never in an address); the old link stops working", async () => {
  const frank = await personWithLink(pool, "Frank's family", '');
  const answer = await send('me/new-link', '/me/new-link', {}, {}, { ss_me: frank.token });
  assert.equal(answer.status, 200);
  assert.equal(answer.headers.get('location'), null);
  const token = cookieSet(answer, 'ss_me')!;
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(token, frank.token);
  const page = await answer.text();
  assert.ok(page.includes(`value="http://127.0.0.1:3000/me/${token}"`));
  assert.ok(page.includes(`<h1>${escapeHtml(words.member.yourLink)}</h1>`) && page.includes('<nav class="top"'), 'a heading and the menu');
  assert.ok(page.includes(`class="button secondary" href="/me"`), 'a way back to their page, not only Back onto the form that made it');
  assert.ok(!page.includes('data-share'), 'no share sheet for the link, nor for the message that sends it (it would offer the group chat first)');
  // No contact saved: Messages and Mail addressed to nobody, for them to type their own; never WhatsApp's chat list.
  assert.ok(page.includes('href="sms:?&#38;body=') && page.includes('href="mailto:?subject=') && !page.includes('wa.me'), 'Send it to myself, to nobody yet');
  assert.equal((await open('me', '/me', {}, { ss_me: frank.token })).status, 404, 'the old link');

  // A number saved with its country code: a text and WhatsApp to that number, their own (their page shows it); nothing
  // to nobody.
  const mike = await personWithLink(pool, "Mike's family", '+1 415 555 0134');
  const own = await (await send('me/new-link', '/me/new-link', {}, {}, { ss_me: mike.token })).text();
  assert.ok(own.includes('href="sms:+14155550134?&#38;body=') && own.includes('href="https://wa.me/14155550134?text='), 'to their own number');
  assert.ok(!own.includes('sms:?') && !own.includes('mailto:') && !own.includes('wa.me/?') && !own.includes('data-share'), 'never to nobody, never a group');

  // A number without it may be another country's: 155 1234 5678 (a mobile number in China) reads as a US number in
  // area code 551, a stranger's. Such a number is addressed to nobody, as no contact is, and so is a US one.
  for (const contact of ['155 1234 5678', '(415) 555-0134']) {
    const someone = await personWithLink(pool, "Frank's family", contact);
    const sent = await (await send('me/new-link', '/me/new-link', {}, {}, { ss_me: someone.token })).text();
    assert.ok(sent.includes('href="sms:?&#38;body=') && sent.includes('href="mailto:?subject=') && !sent.includes('wa.me'), `${contact}: to nobody`);
    assert.ok(!sent.includes('sms:+'), `${contact}: never a guess at the number`);
  }
  const abroad = await personWithLink(pool, "Frank's family", '155 1234 5678');
  const mine = await (await open('me', '/me', {}, { ss_me: abroad.token })).text();
  assert.ok(mine.includes('155 1234 5678') && !mine.includes('sms:+') && !mine.includes('wa.me/1'), "/me's own box: never a guess at the number either");
});

test("a member's new link survives a failure reading their contact once it is made: the link, its cookie, the box to nobody", async () => {
  // A copy whose meView first runs the statement the test gives it: a real server error, after the new link is made.
  const start = 'export async function meView(db: Db, personId: string): Promise<MeView | null> {';
  const copy = changedCopy([{ file: 'src/lib/views.ts', from: start, to: `${start}\n  await (globalThis as any).${FAIL_HOOK}?.(db);` }]);
  const hooks = globalThis as Record<string, unknown>;
  const original = console.error;
  const lines: string[] = [];
  try {
    const { POST } = await copyRoutes(copy)('me/new-link');
    assert.ok(POST);
    const mike = await personWithLink(pool, "Mike's family", 'mike-own@example.test');
    hooks[FAIL_HOOK] = (db: pg.Pool) => db.query("do $$ begin raise exception 'forced by the test' using errcode = '57014'; end $$");
    console.error = (line: string) => lines.push(line);
    const answer = await POST(formPost('/me/new-link', {}, { cookies: { ss_me: mike.token } }), params({}));
    console.error = original;
    delete hooks[FAIL_HOOK];
    assert.equal(answer.status, 200, 'the answer the new link was made for');
    const token = cookieSet(answer, 'ss_me')!;
    assert.match(token, /^[A-Za-z0-9_-]{43}$/, 'this browser moves to the new link');
    const page = await answer.text();
    assert.ok(page.includes(`value="http://127.0.0.1:3000/me/${token}"`), 'the new link, shown once');
    assert.ok(page.includes('href="sms:?&#38;body=') && page.includes('href="mailto:?subject=') && !page.includes('mike-own'), 'Send it to myself, to nobody');
    assert.deepEqual(lines, ['[signup-sheet] new link contact: database error 57014'], 'one line, with no link in it');
    assert.equal((await open('me', '/me', {}, { ss_me: token })).status, 200, 'the new link works');
    assert.equal((await open('me', '/me', {}, { ss_me: mike.token })).status, 404, 'the old one does not');
  } finally {
    console.error = original;
    delete hooks[FAIL_HOOK];
    copy.remove();
  }
});

test("a note refused on a sheet that names its note: the alert at the top and the field both use that name (/me, Add someone)", async () => {
  const { sheetId, slotIds } = await sheetWithSlots(pool, { slug: 'named-note', capacities: [2], noteRequired: true });
  await pool.query('update sheets set note_label = $2 where id = $1', [sheetId, "What you'll bring"]);
  const frank = await personWithLink(pool, "Frank's family", '');
  const mine = await signup(slotIds[0]!, frank.id, 'confirmed', 'Oranges');
  const named = escapeHtml(words.formErrors.noteLabelled("What you'll bring"));
  const alertOf = (page: string) => /<div class="notice error" role="alert">([^<]*)<\/div>/.exec(page)?.[1];
  const me = await (await open('me', `/me?e=note&s=${mine}`, {}, { ss_me: frank.token })).text();
  assert.equal(alertOf(me), named, 'the alert at the top of /me');
  assert.equal(me.split(named).length - 1, 2, 'the alert and the field say the same');
  assert.ok(!me.includes(escapeHtml(words.formErrors.note)), 'never the sentence for a note with no name');
  const long = await (await open('me', `/me?e=note-too_long&s=${mine}`, {}, { ss_me: frank.token })).text();
  assert.ok(alertOf(long)?.startsWith(escapeHtml("What you'll bring: ")), 'a note too long is named the same way');
  const add = await (await open('organizer/slots/[id]/add', `/organizer/slots/${slotIds[0]}/add?e=note`, { id: slotIds[0]! }, org)).text();
  assert.equal(alertOf(add), named, 'the alert at the top of Add someone');
  assert.equal(add.split(named).length - 1, 2, 'the alert and the field say the same');
});

test('T36 for the pages: every organizer GET sends strangers to /organizer with nothing in the answer; the organizer gets the page', async () => {
  const checked = await organizerPagesProbe(route, pool, seat.cookieValue, await pageFixture(pool, 'organizer-pages'));
  assert.ok(checked >= 25, `${checked} organizer GET routes`);
  const stranger = await (await open('organizer', '/organizer')).text();
  assert.ok(stranger.includes(escapeHtml(words.organizer.heldElsewhere.heading)), 'held elsewhere: no sign-in form');
  assert.ok(!stranger.includes(escapeHtml(words.org.attention)) && !stranger.includes('name="password"'));
});

test("the organizer's sheet page: contacts and notes escaped; a moved-up person in Needs attention with Told them and Undo", async () => {
  const { slotIds } = await sheetWithSlots(pool, { slug: 'attention', capacities: [1] });
  const first = await personWithLink(pool, `Mike's <i>family</i>`, '"mike"@example.test');
  const second = await personWithLink(pool, 'Frank "F" family', '+1 415 555 0134');
  const gone = await signup(slotIds[0]!, first.id, 'confirmed', '<b>note</b>');
  await signup(slotIds[0]!, second.id, 'waiting');
  const sheetPage = await (await open('organizer/sheets/[slug]', '/organizer/sheets/attention', { slug: 'attention' }, org)).text();
  assert.ok(sheetPage.includes(escapeHtml('"mike"@example.test')) && !sheetPage.includes('<i>family') && !sheetPage.includes('<b>note'));

  const removed = await send('organizer/signups/[id]/remove', `/organizer/signups/${gone}/remove`, {}, { id: gone }, org);
  assert.equal(removed.status, 303);
  const home = await (await open('organizer', '/organizer', {}, org)).text();
  assert.ok(home.includes(escapeHtml(words.org.movedUp('Frank "F" family'))), 'moved up: tell them');
  assert.ok(home.includes('sms:+14155550134?&#38;body=Good%20news%2C%20Frank%20%22F%22%20family'), 'the message to their own number, encoded');
  assert.ok(!home.includes('body=Good news'), 'never a raw or + encoded space');
  const promoted = (await pool.query<{ id: string }>('select id from signups where person_id = $1', [second.id])).rows[0]!.id;
  const told = await send('organizer/signups/[id]/told', `/organizer/signups/${promoted}/told`, {}, { id: promoted }, org);
  assert.equal(told.headers.get('location'), `/organizer?told=${promoted}`);
  const after = await (await open('organizer', `/organizer?told=${promoted}`, {}, org)).text();
  assert.ok(after.includes(escapeHtml(words.org.toldDone('Frank "F" family'))) && after.includes(`/organizer/signups/${promoted}/untold`));
  assert.ok(!after.includes(escapeHtml(words.org.movedUp('Frank "F" family'))));
  await send('organizer/signups/[id]/untold', `/organizer/signups/${promoted}/untold`, {}, { id: promoted }, org);
  assert.ok((await (await open('organizer', '/organizer', {}, org)).text()).includes(escapeHtml(words.org.movedUp('Frank "F" family'))), 'Undo: back in Needs attention');
  await assertCountsConsistent(pool);
});

test('W7 from the pages: the confirmation lists who to tell; a sign-up made since it was shown deletes nothing and shows the new list', async () => {
  const { slotIds } = await sheetWithSlots(pool, { slug: 'to-delete', capacities: [3] });
  const frank = await personWithLink(pool, "Frank's family", 'frank-delete@example.test');
  await signup(slotIds[0]!, frank.id, 'confirmed');
  const confirm = await (await open('organizer/slots/[id]/delete', `/organizer/slots/${slotIds[0]}/delete`, { id: slotIds[0]! }, org)).text();
  assert.ok(confirm.includes("Frank&#39;s family") && confirm.includes('frank-delete@example.test'));
  const seen = /name="seen" value="([0-9a-f]{64})"/.exec(confirm)?.[1];
  assert.ok(seen, 'the confirmation carries what it showed');
  const mike = await personWithLink(pool, "Mike's family", '');
  await signup(slotIds[0]!, mike.id, 'confirmed');
  const refused = await send('organizer/slots/[id]/delete', `/organizer/slots/${slotIds[0]}/delete`, { confirm: 'yes', seen }, { id: slotIds[0]! }, org);
  assert.equal(refused.headers.get('location'), `/organizer/slots/${slotIds[0]}/delete?changed=1`);
  assert.equal(await count(pool, 'select count(*) from slots where id = $1', [slotIds[0]]), 1, 'nothing deleted');
  const again = await (await open('organizer/slots/[id]/delete', `/organizer/slots/${slotIds[0]}/delete?changed=1`, { id: slotIds[0]! }, org)).text();
  assert.ok(again.includes(escapeHtml(words.formErrors.deletionChanged)) && again.includes("Mike&#39;s family"));
  const fresh = /name="seen" value="([0-9a-f]{64})"/.exec(again)![1]!;
  const deleted = await send('organizer/slots/[id]/delete', `/organizer/slots/${slotIds[0]}/delete`, { confirm: 'yes', seen: fresh }, { id: slotIds[0]! }, org);
  assert.equal(deleted.headers.get('location'), '/organizer/sheets/to-delete?deleted=1');
  assert.equal(await count(pool, 'select count(*) from slots where id = $1', [slotIds[0]]), 0);
});

test("the organizer's new link for someone: shown once, labelled theirs, sent only to their own contact (no share sheet)", async () => {
  const frank = await personWithLink(pool, "Frank's family", 'frank-link@example.test');
  const question = await (await open('organizer/people/[id]/new-link', `/organizer/people/${frank.id}/new-link`, { id: frank.id }, org)).text();
  assert.ok(question.includes(escapeHtml(words.org.newLinkQuestion("Frank's family"))));
  const made = await send('organizer/people/[id]/new-link', `/organizer/people/${frank.id}/new-link`, {}, { id: frank.id }, org);
  assert.equal(made.status, 200);
  assert.equal(cookieSet(made, 'ss_me'), null, "the organizer's own cookies do not change");
  assert.equal(cookieSet(made, 'ss_org'), null);
  const page = await made.text();
  const token = /value="http:\/\/127\.0\.0\.1:3000\/me\/([A-Za-z0-9_-]{43})"/.exec(page)?.[1];
  assert.ok(token, 'the new link, once');
  assert.ok(page.includes('href="mailto:frank-link@example.test?subject='), 'to their own address');
  assert.ok(!page.includes('data-share'), 'no share sheet: it cannot go to a group by mistake');
  assert.ok(page.includes(`<h1>${escapeHtml(words.org.linkFor("Frank's family"))}</h1>`) && page.includes('<nav class="top organizer"'), 'whose link it is, and the organizer menu');
  assert.ok(page.includes(`<title>${escapeHtml(words.org.linkHeading)} · ${escapeHtml(words.org.title)}</title>`), 'a title that names nobody');
  assert.ok(page.includes(`href="/organizer/people/${frank.id}"`), 'a way back to the person, not only Back onto the form that made it');
  const person = await (await open('organizer/people/[id]', `/organizer/people/${frank.id}`, { id: frank.id }, org)).text();
  assert.ok(!person.includes(token!), 'never shown again');
  assert.equal((await open('me', '/me', {}, { ss_me: frank.token })).status, 404, 'the old link stopped working');

  // Someone who never had a link (added by the organizer): the first one speaks of no old link.
  const added = (await pool.query<{ id: string }>("insert into people (name, contact, added_by) values ('Mike''s family', '', 'organizer') returning id")).rows[0]!.id;
  const first = await (await open('organizer/people/[id]/new-link', `/organizer/people/${added}/new-link`, { id: added }, org)).text();
  assert.ok(first.includes(escapeHtml(words.org.firstLinkQuestion("Mike's family"))) && !first.includes(escapeHtml(words.org.newLinkQuestion("Mike's family"))));
  const made2 = await (await send('organizer/people/[id]/new-link', `/organizer/people/${added}/new-link`, {}, { id: added }, org)).text();
  assert.ok(made2.includes(escapeHtml(words.organizer.firstLinkShown)) && !made2.includes(escapeHtml(words.organizer.newLinkShown)));
  assert.ok(made2.includes('Here&#39;s your private link for') && !made2.includes('The old one no longer works'), 'the message to copy, with no old link in it');
});

test('one tap never removes: the sheet page links the question; Yes, remove answers how many moved up', async () => {
  const { slotIds } = await sheetWithSlots(pool, { slug: 'remove-asks', capacities: [1] });
  const frank = await personWithLink(pool, "Frank's family", '');
  const mike = await personWithLink(pool, "Mike's family", '');
  const gone = await signup(slotIds[0]!, frank.id, 'confirmed');
  await signup(slotIds[0]!, mike.id, 'waiting');
  const sheetPage = await (await open('organizer/sheets/[slug]', '/organizer/sheets/remove-asks', { slug: 'remove-asks' }, org)).text();
  assert.ok(sheetPage.includes(`href="/organizer/signups/${gone}/remove"`), 'Remove is a link to its question');
  assert.ok(!sheetPage.includes(`action="/organizer/signups/${gone}/remove"`), 'no form on the sheet page that removes in one tap');
  const question = await open('organizer/signups/[id]/remove', `/organizer/signups/${gone}/remove`, { id: gone }, org);
  assert.equal(question.status, 200);
  const asked = await question.text();
  assert.ok(asked.includes(escapeHtml(words.org.removeOneQuestion("Frank's family", 'Slot 1', formatDate(dayFromToday(10))))));
  assert.ok(asked.includes(`action="/organizer/signups/${gone}/remove"`) && asked.includes(escapeHtml(words.org.removeYes)));
  assert.deepEqual(await roster(pool, slotIds[0]!), { confirmed: ["Frank's family"], waiting: ["Mike's family"] }, 'the question changed nothing');
  const removed = await send('organizer/signups/[id]/remove', `/organizer/signups/${gone}/remove`, {}, { id: gone }, org);
  assert.equal(removed.headers.get('location'), `/organizer/sheets/remove-asks?removed=1#p${slotIds[0]}`);
  const after = await (await open('organizer/sheets/[slug]', '/organizer/sheets/remove-asks?removed=1', { slug: 'remove-asks' }, org)).text();
  assert.ok(after.includes(escapeHtml(words.org.removedUp(1))));
  assert.deepEqual(await roster(pool, slotIds[0]!), { confirmed: ["Mike's family"], waiting: [] });
});

test('the Remove question promises a move-up only where one happens: never on a cancelled date or one that has started', async () => {
  const line = escapeHtml(words.org.removeOneLine);
  const removeFirst = async (slug: string, onDate: string, cancelled: boolean) => {
    const { dateId, slotIds } = await sheetWithSlots(pool, { slug, capacities: [1], onDate });
    if (cancelled) await pool.query('update dates set cancelled_at = now() where id = $1', [dateId]);
    const gone = await signup(slotIds[0]!, (await personWithLink(pool, "Frank's family", '')).id, 'confirmed');
    await signup(slotIds[0]!, (await personWithLink(pool, "Mike's family", '')).id, 'waiting');
    const asked = await (await open('organizer/signups/[id]/remove', `/organizer/signups/${gone}/remove`, { id: gone }, org)).text();
    const removed = await send('organizer/signups/[id]/remove', `/organizer/signups/${gone}/remove`, {}, { id: gone }, org);
    return { promised: asked.includes(line), location: removed.headers.get('location'), roster: await roster(pool, slotIds[0]!) };
  };
  const ahead = await removeFirst('remove-ahead', dayFromToday(10), false);
  assert.ok(ahead.promised, 'control: a date still ahead');
  assert.match(ahead.location ?? '', /\?removed=1#/);
  assert.deepEqual(ahead.roster, { confirmed: ["Mike's family"], waiting: [] });
  for (const [slug, onDate, cancelled] of [['remove-cancelled', dayFromToday(10), true], ['remove-started', dayFromToday(-1), false]] as const) {
    const done = await removeFirst(slug, onDate, cancelled);
    assert.ok(!done.promised, `${slug}: no promise that someone moves up`);
    assert.match(done.location ?? '', /\?removed=0#/, slug);
    assert.deepEqual(done.roster, { confirmed: [], waiting: ["Mike's family"] }, `${slug}: nobody moved up, as the page said`);
  }
});

test('a cancelled date on the public sheet: who was on it, but no count, no "You\'re in" and no Take it', async () => {
  const { dateId, slotIds } = await sheetWithSlots(pool, { slug: 'rained-out', capacities: [1, 2] });
  const frank = await personWithLink(pool, "Frank's family", '');
  await signup(slotIds[0]!, frank.id, 'confirmed', 'Oranges');
  await pool.query('update dates set cancelled_at = now() where id = $1', [dateId]);
  const body = await (await open('s/[slug]', '/s/rained-out', { slug: 'rained-out' }, { ss_me: frank.token })).text();
  assert.ok(body.includes(`<span class="count">${escapeHtml(words.sheet.cancelled)}</span>`), 'the count says Cancelled');
  assert.ok(!body.includes(escapeHtml(words.sheet.countTaken(1, 1))) && !body.includes(escapeHtml(words.sheet.countLeft(2))), 'no count');
  assert.ok(!body.includes(escapeHtml(words.sheet.youreIn)) && !body.includes(`/s/rained-out/slots/${slotIds[1]}"`), "no You're in, no Take it");
  assert.ok(body.includes(`(<strong>${escapeHtml(words.sheet.mineCancelled)}</strong>)`), "the first box marks the phone's own place cancelled");
  assert.ok(body.includes("Frank&#39;s family"), 'who was on it still shows');
});

test("Mark paid from the unpaid list: one tap, the amount and note kept, the list again with Undo", async () => {
  await pool.query("update app_state set dues_label = 'Season dues', dues_amount_cents = 4000");
  try {
    const frank = await personWithLink(pool, "Frank's family paid-list", '');
    await pool.query("update people set paid = false, paid_amount_cents = 2000, paid_note = 'half in cash' where id = $1", [frank.id]);
    const list = await (await open('organizer/people', '/organizer/people?unpaid=1', {}, org)).text();
    assert.ok(list.includes(`action="/organizer/people/${frank.id}/paid"`) && list.includes(escapeHtml(words.org.markPaid)));
    const marked = await send('organizer/people/[id]/paid', `/organizer/people/${frank.id}/paid`, { paid: '1', back: 'unpaid' }, { id: frank.id }, org);
    assert.equal(marked.headers.get('location'), `/organizer/people?unpaid=1&paid=${frank.id}`);
    assert.deepEqual((await pool.query('select paid, paid_amount_cents, paid_note from people where id = $1', [frank.id])).rows, [
      { paid: true, paid_amount_cents: 2000, paid_note: 'half in cash' }
    ]);
    const again = await (await open('organizer/people', `/organizer/people?unpaid=1&paid=${frank.id}`, {}, org)).text();
    assert.ok(again.includes(escapeHtml(words.org.markedPaid("Frank's family paid-list"))) && again.includes(escapeHtml(words.org.undo)));
    assert.ok(!again.includes(`href="/organizer/people/${frank.id}"`), 'no longer on the unpaid list');
    // Control: the person page's own form still sets the amount and the note it sends.
    const full = await send('organizer/people/[id]/paid', `/organizer/people/${frank.id}/paid`, { paid: '1', amount: '40', note: '' }, { id: frank.id }, org);
    assert.equal(full.headers.get('location'), `/organizer/people/${frank.id}?saved=1`);
    assert.deepEqual((await pool.query('select paid_amount_cents, paid_note from people where id = $1', [frank.id])).rows, [{ paid_amount_cents: 4000, paid_note: '' }]);
  } finally {
    await pool.query("update app_state set dues_label = '', dues_amount_cents = null");
  }
});

test('"Marked … paid." only for someone paid now: after Undo, Back to the old address shows them unpaid, with no such line', async () => {
  await pool.query("update app_state set dues_label = 'Season dues', dues_amount_cents = 4000");
  try {
    const frank = await personWithLink(pool, "Frank's family undone", '');
    const marked = await send('organizer/people/[id]/paid', `/organizer/people/${frank.id}/paid`, { paid: '1', back: 'unpaid' }, { id: frank.id }, org);
    const address = marked.headers.get('location')!;
    assert.equal(address, `/organizer/people?unpaid=1&paid=${frank.id}`);
    const undo = await send('organizer/people/[id]/paid', `/organizer/people/${frank.id}/paid`, { paid: '0', back: 'unpaid' }, { id: frank.id }, org);
    assert.equal(undo.headers.get('location'), '/organizer/people?unpaid=1');
    const back = await (await open('organizer/people', address, {}, org)).text();
    assert.ok(!back.includes(escapeHtml(words.org.markedPaid("Frank's family undone"))), 'no "Marked … paid." for someone unpaid');
    assert.ok(back.includes(`action="/organizer/people/${frank.id}/paid"`), 'on the unpaid list again, with Mark paid');
  } finally {
    await pool.query("update app_state set dues_label = '', dues_amount_cents = null");
  }
});

test("the dashboard's \"Send this week's reminder\" counts only coming dates with places, as the sheet page does", async () => {
  const { sheetId, dateId } = await sheetWithSlots(pool, { slug: 'empty-week', capacities: [], onDate: dayFromToday(2) });
  const week = 'href="/organizer/sheets/empty-week/share/week"';
  const home = await (await open('organizer', '/organizer', {}, org)).text();
  assert.ok(!home.includes(week), 'a coming date with no places: nothing to send');
  const sheetPage = await (await open('organizer/sheets/[slug]', '/organizer/sheets/empty-week', { slug: 'empty-week' }, org)).text();
  assert.ok(!sheetPage.includes(week), 'the sheet page agrees');
  // Control: once the date has a place, both link this week's reminder, and its page has the message.
  await pool.query("insert into slots (sheet_id, date_id, label, capacity) values ($1, $2, 'Snacks', 1)", [sheetId, dateId]);
  assert.ok((await (await open('organizer', '/organizer', {}, org)).text()).includes(week));
  assert.ok((await (await open('organizer/sheets/[slug]', '/organizer/sheets/empty-week', { slug: 'empty-week' }, org)).text()).includes(week));
  const shared = await (await open('organizer/sheets/[slug]/share/week', '/organizer/sheets/empty-week/share/week', { slug: 'empty-week' }, org)).text();
  assert.ok(shared.includes('<textarea id="week"') && !shared.includes(escapeHtml(words.org.nothingThisWeek)));
});

test("the seat notice says when the seat ends: in UTC before there is a sheet, then in the first sheet's time zone, by name", async () => {
  const fresh = await cluster.createDatabase({ migrated: true });
  const local = poolFor(fresh);
  await useDatabase(fresh);
  try {
    const own = { ss_org: (await takeSeat(local, readSettings({ DATABASE_URL: fresh })))!.cookieValue };
    const until = (await local.query<{ until: Date }>('select seat_until as until from app_state')).rows[0]!.until;
    const notice = (zone: string, name: string | null) => escapeHtml(words.organizer.seatBanner(words.access.seatUntil(formatMoment(until, zone), name)));
    assert.ok((await (await open('organizer', '/organizer', {}, own)).text()).includes(notice('UTC', null)), 'UTC, before any sheet');
    const { sheetId } = await sheetWithSlots(local, { slug: 'zoned', capacities: [1] });
    await local.query("update sheets set timezone = 'America/Phoenix' where id = $1", [sheetId]);
    assert.ok((await (await open('organizer', '/organizer', {}, own)).text()).includes(notice('America/Phoenix', 'Arizona')), "the first sheet's zone");
  } finally {
    await local.end();
    await useDatabase(url);
  }
});

test('"Add a date every week": the preview lists the dates, the POST adds them with the latest places, a second press adds nothing', async () => {
  const { slotIds } = await sheetWithSlots(pool, { slug: 'weekly', capacities: [1, 2], onDate: dayFromToday(3) });
  void slotIds;
  const from = dayFromToday(10);
  const until = dayFromToday(10 + 7 * 4);
  const preview = await (await open('organizer/sheets/[slug]/dates/weekly', `/organizer/sheets/weekly/dates/weekly?from=${from}&until=${until}&start=09:00&end=10:30&withSlots=1`, { slug: 'weekly' }, org)).text();
  assert.ok(preview.includes(escapeHtml(words.org.bulkAdd(5))), 'five weeks');
  const fields = { from, until, start: '09:00', end: '10:30', place: '', withSlots: '1' };
  const added = await send('organizer/sheets/[slug]/dates/weekly', '/organizer/sheets/weekly/dates/weekly', fields, { slug: 'weekly' }, org);
  assert.equal(added.headers.get('location'), '/organizer/sheets/weekly?weekly=5');
  const again = await send('organizer/sheets/[slug]/dates/weekly', '/organizer/sheets/weekly/dates/weekly', fields, { slug: 'weekly' }, org);
  assert.equal(again.headers.get('location'), '/organizer/sheets/weekly?weekly=0', 'a second press adds nothing');
  assert.equal(await count(pool, "select count(*) from dates d join sheets h on h.id = d.sheet_id where h.slug = 'weekly'"), 6);
  assert.equal(await count(pool, "select count(*) from slots s join sheets h on h.id = s.sheet_id where h.slug = 'weekly'"), 12, 'each new date has the two places');
  const tooMany = await send('organizer/sheets/[slug]/dates/weekly', '/organizer/sheets/weekly/dates/weekly', { ...fields, until: dayFromToday(10 + 7 * 70) }, { slug: 'weekly' }, org);
  assert.match(tooMany.headers.get('location') ?? '', /e=tooMany/);
});

test('a sheet cannot be called "new" (its page is the new-sheet form): refused in the form, keeping what was typed, and in an import', async () => {
  const before = await count(pool, 'select count(*) from sheets');
  const form = await send('organizer/sheets', '/organizer/sheets', { title: 'Snacks <b>', slug: 'new', timezone: 'America/Los_Angeles', names: 'full', status: 'draft', listed: '1' }, {}, org);
  assert.equal(form.status, 400);
  const page = await form.text();
  assert.ok(page.includes(escapeHtml(words.fieldErrors.slugReserved)) && page.includes(escapeHtml('Snacks <b>')));
  const { POST } = await route('organizer/import');
  const file = JSON.stringify({ format: 'signup-sheet/1', dryRun: true, sheets: [{ slug: 'new', title: 'New', timezone: 'America/Los_Angeles', dates: [] }] });
  const imported = await POST!(jsonPost('/organizer/import', file, org), params({}));
  assert.equal(imported.status, 400);
  assert.equal(((await imported.json()) as { path: string }).path, 'sheets[0].slug');
  assert.equal(await count(pool, 'select count(*) from sheets'), before);
});

test('the share pages: links encoded with %20, one number per text, bcc for several emails, no contact in the group text', async () => {
  const { slotIds } = await sheetWithSlots(pool, { slug: 'share-me', capacities: [1], onDate: dayFromToday(2) });
  const mike = await personWithLink(pool, 'Mike "M" <family>', 'mike-share@example.test');
  const frank = await personWithLink(pool, "Frank's family", 'frank-share@example.test');
  await signup(slotIds[0]!, mike.id, 'confirmed');
  await signup(slotIds[0]!, frank.id, 'waiting');
  const week = await (await open('organizer/sheets/[slug]/share/week', '/organizer/sheets/share-me/share/week', { slug: 'share-me' }, org)).text();
  assert.ok(week.includes('https://wa.me/?text=') && !/wa\.me\/\?text=[^"]*\+/.test(week), 'no + for a space');
  assert.ok(week.includes('mailto:?bcc=mike-share@example.test&#38;subject='), 'bcc for the emails');
  const text = /<textarea id="week"[^>]*>([^<]*)<\/textarea>/.exec(week)?.[1] ?? '';
  assert.ok(text.includes(escapeHtml('Mike "M" <family>')) && !text.includes('mike-share'), 'names, never contacts, in the text');
  const waitlist = await (await open('organizer/sheets/[slug]/share/waitlist', '/organizer/sheets/share-me/share/waitlist', { slug: 'share-me' }, org)).text();
  assert.ok(waitlist.includes('href="mailto:frank-share@example.test?subject='));
  assert.ok(!waitlist.includes('<family>'), 'escaped');
});

test('the import page: the form keeps the file in its box after a check, with the summary or the refusal and its field', async () => {
  const fresh = await (await open('organizer/import', '/organizer/import', {}, org)).text();
  const rid = /name="rid" value="([0-9a-f-]{36})"/.exec(fresh)?.[1];
  assert.ok(rid);
  const file = JSON.stringify({ format: 'signup-sheet/1', people: [{ key: 'f', name: 'Frank <family>' }] });
  const checked = await send('organizer/import', '/organizer/import', { json: file, action: 'check', rid: rid! }, {}, org);
  assert.equal(checked.status, 200);
  const page = await checked.text();
  assert.ok(page.includes('Would make: 1 person') && page.includes(escapeHtml(file)) && page.includes(`value="${rid}"`));
  const wrong = await send('organizer/import', '/organizer/import', { json: '{"format":"signup-sheet/1","peeple":[]}', action: 'check', rid: rid! }, {}, org);
  assert.equal(wrong.status, 400);
  assert.ok((await wrong.text()).includes(escapeHtml('The file: "peeple" isn\'t a field this file can have. Nothing was imported.')));
});

test("a closed sheet: the member's cancel and note forms change nothing and /me says why, as the confirmation page does", async () => {
  const { slotIds } = await sheetWithSlots(pool, { slug: 'closed-mine', capacities: [1], status: 'closed' });
  const frank = await personWithLink(pool, "Frank's family", '');
  const mine = await signup(slotIds[0]!, frank.id, 'confirmed', 'Oranges');
  const me = { ss_me: frank.token };
  const confirm = await (await open('me/signups/[id]/cancel', `/me/signups/${mine}/cancel`, { id: mine }, me)).text();
  assert.ok(confirm.includes(escapeHtml(words.me.lockedClosed)) && !confirm.includes(escapeHtml(words.me.yesCancel)), 'the confirmation says why: the sheet is closed');
  const activity = await count(pool, 'select count(*) from activity');

  const cancel = await send('me/signups/[id]/cancel', `/me/signups/${mine}/cancel`, {}, { id: mine }, me);
  assert.equal(cancel.status, 303);
  assert.equal(cancel.headers.get('location'), '/me?e=locked');
  const note = await send('me/signups/[id]/note', `/me/signups/${mine}/note`, { note: 'Changed' }, { id: mine }, me);
  assert.equal(note.headers.get('location'), '/me?e=locked');
  assert.deepEqual((await pool.query('select note from signups where id = $1', [mine])).rows, [{ note: 'Oranges' }], 'still signed up, note as it was');
  assert.equal(await count(pool, 'select count(*) from activity'), activity, 'no activity');
  assert.ok((await (await open('me', '/me?e=locked', {}, me)).text()).includes(escapeHtml(words.formErrors.locked)));

  // Control: the sheet open again, the same form cancels.
  await pool.query("update sheets set status = 'open' where slug = 'closed-mine'");
  const control = await send('me/signups/[id]/cancel', `/me/signups/${mine}/cancel`, {}, { id: mine }, me);
  assert.equal(control.headers.get('location'), '/me?cancelled=1&sheet=closed-mine');
  assert.equal(await count(pool, 'select count(*) from signups where id = $1', [mine]), 0);
});

test("the organizer's move and swap pages: the document's title names nobody, the heading names the person", async () => {
  const { slotIds } = await sheetWithSlots(pool, { slug: 'titles', capacities: [1, 1] });
  const frank = await personWithLink(pool, "Frank's family", '');
  const mike = await personWithLink(pool, "Mike's family", '');
  const frankOn = await signup(slotIds[0]!, frank.id, 'confirmed');
  await signup(slotIds[1]!, mike.id, 'confirmed');
  for (const [action, title] of [['move', words.org.moveTitle], ['swap', words.org.swapTitle]] as const) {
    const page = await (await open(`organizer/signups/[id]/${action}`, `/organizer/signups/${frankOn}/${action}`, { id: frankOn }, org)).text();
    assert.ok(page.includes(`<title>${escapeHtml(title)} · ${escapeHtml(words.org.title)}</title>`), action);
    assert.ok(!/<title>[^<]*(Frank|Mike)/.test(page), `${action}: the title names nobody`);
    assert.ok(/<h1>[^<]*Frank&#39;s family/.test(page), `${action}: the heading names them`);
  }
});

test('a sheet that hides names: a message naming someone with no phone or email is for the organizer to send them, never offered for the group', async () => {
  const sheets = {
    'hidden-names': await sheetWithSlots(pool, { slug: 'hidden-names', capacities: [1], names: 'taken' }),
    'shown-names': await sheetWithSlots(pool, { slug: 'shown-names', capacities: [1] })
  };
  for (const [slug, place] of Object.entries(sheets)) {
    const first = await personWithLink(pool, `First ${slug}`, '');
    const next = await personWithLink(pool, `Next ${slug}`, '');
    const third = await personWithLink(pool, `Third ${slug}`, '');
    const gone = await signup(place.slotIds[0]!, first.id, 'confirmed');
    await signup(place.slotIds[0]!, next.id, 'waiting');
    await signup(place.slotIds[0]!, third.id, 'waiting');
    assert.equal((await send('organizer/signups/[id]/remove', `/organizer/signups/${gone}/remove`, {}, { id: gone }, org)).status, 303);
  }
  const home = await (await open('organizer', '/organizer', {}, org)).text();
  assert.ok(home.includes(escapeHtml(words.org.movedUp('Next hidden-names'))) && home.includes(escapeHtml(words.org.movedUp('Next shown-names'))));
  assert.ok(home.includes(escapeHtml(words.share.noContactNamesHidden)), 'the hidden sheet: send it to them, not in the group');
  assert.ok(home.includes('Good news, Next hidden-names: a place opened up'), 'their own message');
  assert.ok(!home.includes('Next hidden-names, a place opened for you'), 'never the group message with their name');
  assert.ok(home.includes(escapeHtml(words.share.noContact)) && home.includes('Next shown-names, a place opened for you'), 'control: the sheet that shows names');

  const hidden = await (await open('organizer/sheets/[slug]/share/waitlist', '/organizer/sheets/hidden-names/share/waitlist', { slug: 'hidden-names' }, org)).text();
  assert.ok(hidden.includes(escapeHtml(words.share.noContactNamesHidden)) && !hidden.includes(escapeHtml(words.share.noContact)));
  const shown = await (await open('organizer/sheets/[slug]/share/waitlist', '/organizer/sheets/shown-names/share/waitlist', { slug: 'shown-names' }, org)).text();
  assert.ok(shown.includes(escapeHtml(words.share.noContact)), 'control: the waitlist of the sheet that shows names');
  await assertCountsConsistent(pool);
});
