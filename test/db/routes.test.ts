// The route handlers, called directly (a Request in, a Response out) on a real database. This proves what the handlers
// answer; it is NOT an HTTP test: next.config.ts headers, Next.js's own routing and logs, and several processes behind
// a real server are checked over HTTP by the local suites, the live check and the browser check (docs/verification.md:
// T01, T21's HTTP probes, T22, T30-T32, T39).
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import type pg from 'pg';
import { passwordCookie, takeSeat } from '../../src/lib/access';
import { escapeHtml } from '../../src/lib/responses';
import { readSettings } from '../../src/lib/settings';
import { newRequestId, newToken } from '../../src/lib/tokens';
import { words } from '../../src/words';
import { poolFor } from '../support/fixtures';
import {
  assertCountsConsistent,
  cookieSet,
  count,
  endRoutePool,
  formPost,
  get,
  params,
  personWithLink,
  resetThrottle,
  roster,
  sheetWithSlots,
  useDatabase
} from '../support/core';
import { originProbe, ownershipProbe, pathParams, realRoutes, replayWithCookieProbe, routePaths } from '../support/probes';
import { type Cluster, startCluster } from '../support/postgres';

let cluster: Cluster;
let pool: pg.Pool;
let url: string;

before(async () => {
  cluster = await startCluster();
  url = await cluster.createDatabase({ migrated: true });
  pool = poolFor(url);
  await useDatabase(url);
});

beforeEach(async () => {
  await resetThrottle(pool);
});

after(async () => {
  await endRoutePool();
  await pool?.end();
  await cluster?.stop();
});

const route = realRoutes;

async function claimForm(slug: string, slotId: string, fields: Record<string, string>, cookies: Record<string, string> = {}) {
  const { POST } = await route('s/[slug]/slots/[id]/claim');
  return POST!(formPost(`/s/${slug}/slots/${slotId}/claim`, fields, { cookies }), params({ slug, id: slotId }));
}

test('claim: 303 to /me?new= with the link cookie; the same form again, alone or five at once, gets the same answer; other words get 409', async () => {
  const { slotIds } = await sheetWithSlots(pool, { slug: 'route-claim', capacities: [1, 1] });
  const fields = { rid: newRequestId(), name: 'The Mike family', contact: 'mike-family@example.test', note: 'Oranges' };
  const first = await claimForm('route-claim', slotIds[0]!, fields);
  assert.equal(first.status, 303);
  const location = first.headers.get('location')!;
  assert.match(location, /^\/me\?new=\d+$/);
  const token = cookieSet(first, 'ss_me');
  assert.match(token ?? '', /^[A-Za-z0-9_-]{43}$/);
  assert.ok(!location.includes(token!), 'no Location carries a token');
  assert.equal(first.headers.get('cache-control'), 'private, no-store');

  const repeats = await Promise.all(Array.from({ length: 5 }, () => claimForm('route-claim', slotIds[0]!, fields)));
  for (const repeat of repeats) {
    assert.equal(repeat.status, 303);
    assert.equal(repeat.headers.get('location'), location);
    assert.equal(cookieSet(repeat, 'ss_me'), token);
  }
  // Five copies of one new form at once, none of them first in line.
  const together = { rid: newRequestId(), name: 'The Frank family' };
  const parallel = await Promise.all(Array.from({ length: 5 }, () => claimForm('route-claim', slotIds[1]!, together)));
  assert.equal(new Set(parallel.map((answer) => `${answer.status} ${answer.headers.get('location')} ${cookieSet(answer, 'ss_me')}`)).size, 1);
  assert.deepEqual(await roster(pool, slotIds[1]!), { confirmed: ['The Frank family'], waiting: [] });

  const altered = await claimForm('route-claim', slotIds[0]!, { ...fields, name: "Frank's crew" });
  assert.equal(altered.status, 409);
  assert.ok((await altered.text()).includes(escapeHtml(words.member.formReused)));
  assert.equal(cookieSet(altered, 'ss_me'), null);
  assert.deepEqual(await roster(pool, slotIds[0]!), { confirmed: ['The Mike family'], waiting: [] });
  await assertCountsConsistent(pool);
});

test('the same form again from the browser its first answer gave the cookie: the first answer again, never "for someone else"', async () => {
  await replayWithCookieProbe(route, pool, 'route-replay-cookie');
  await assertCountsConsistent(pool);
});

test("a phone that remembers its person keeps it: claiming for someone else answers 200 with their link once, and no cookie change", async () => {
  const { slotIds } = await sheetWithSlots(pool, { slug: 'route-other', capacities: [3] });
  const owner = await personWithLink(pool, 'Mike');
  const fields = { rid: newRequestId(), name: 'Grandma', contact: '' };
  const answer = await claimForm('route-other', slotIds[0]!, fields, { ss_me: owner.token });
  assert.equal(answer.status, 200);
  assert.equal(cookieSet(answer, 'ss_me'), null, "the phone's own person stays");
  const html = await answer.text();
  const link = /value="(http:\/\/127\.0\.0\.1:3000\/me\/[A-Za-z0-9_-]{43})"/.exec(html)?.[1];
  assert.ok(link, 'the new link, shown once');
  assert.ok(html.includes(escapeHtml(words.member.sendToThem)));
  // The link is theirs: never "open this link again" on this phone, which would make the phone theirs.
  assert.ok(html.includes(escapeHtml(words.org.linkAccessCode)) && !html.includes(escapeHtml(words.member.accessCode)), 'the hint for their link, not your own');
  const again = await claimForm('route-other', slotIds[0]!, fields, { ss_me: owner.token });
  assert.ok((await again.text()).includes(link), 'the same form again shows the same link');
  // The remembered link still works, and Grandma's link is a different person.
  const { GET } = await route('me/[token]');
  assert.equal((await GET!(get(`/me/${owner.token}`), params({ token: owner.token }))).status, 303);
  assert.deepEqual(await roster(pool, slotIds[0]!), { confirmed: ['Grandma'], waiting: [] });

  // as=me signs the phone's own person up, with no new link.
  const mine = await claimForm('route-other', slotIds[0]!, { rid: newRequestId(), as: 'me' }, { ss_me: owner.token });
  assert.equal(mine.status, 303);
  assert.equal(cookieSet(mine, 'ss_me'), null);
  assert.deepEqual(await roster(pool, slotIds[0]!), { confirmed: ['Grandma', 'Mike'], waiting: [] });
});

test('a private link becomes a cookie and a 303 to /me; unknown and malformed links get the same 404', async () => {
  const frank = await personWithLink(pool, 'Frank');
  const { GET } = await route('me/[token]');
  const opened = await GET!(get(`/me/${frank.token}`), params({ token: frank.token }));
  assert.equal(opened.status, 303);
  assert.equal(opened.headers.get('location'), '/me');
  assert.equal(cookieSet(opened, 'ss_me'), frank.token);
  const bodies = new Set<string>();
  for (const bad of [newToken(), 'short', `${frank.token}x`]) {
    const missing = await GET!(get(`/me/${bad}`), params({ token: bad }));
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get('location'), null);
    bodies.add(await missing.text());
  }
  assert.equal(bodies.size, 1, 'one 404 page for every link that does not work');
});

test("G6 through the routes: A's cookie on B's sign-up gets 404 for note, cancel and move, and B is unchanged; A's own works", async () => {
  for (const action of ['note', 'move', 'cancel'] as const) await ownershipProbe(route, pool, action, `route-owners-${action}`);
});

test('a stale or missing member cookie gets the unknown-link 404 (and the stale cookie is cleared)', async () => {
  const { POST } = await route('me/profile');
  const none = await POST!(formPost('/me/profile', { name: 'X' }), params({}));
  assert.equal(none.status, 404);
  const stale = await POST!(formPost('/me/profile', { name: 'X' }, { cookies: { ss_me: newToken() } }), params({}));
  assert.equal(stale.status, 404);
  assert.equal(cookieSet(stale, 'ss_me'), '', 'cleared');
});

test('a filled honeypot goes back to the sheet and writes nothing', async () => {
  const { slotIds } = await sheetWithSlots(pool, { slug: 'route-honey', capacities: [1] });
  const before = await count(pool, 'select count(*) from people');
  const answer = await claimForm('route-honey', slotIds[0]!, { rid: newRequestId(), name: 'Bot', ss_hp: 'http://spam.example' });
  assert.equal(answer.status, 303);
  assert.equal(answer.headers.get('location'), '/s/route-honey');
  assert.equal(await count(pool, 'select count(*) from people'), before);
});

test('a refused text shows the form again (400) with its sentence, what was typed and the same request id; a card number is refused in every field, a phone number is fine', async () => {
  const { slotIds } = await sheetWithSlots(pool, { slug: 'route-text', capacities: [3] });
  const people = await count(pool, 'select count(*) from people');
  const cases: [Record<string, string>, string][] = [
    [{ name: '' }, `${words.fields.name}: ${words.text.required}`],
    [{ name: '4242 4242 4242 4242' }, `${words.fields.name}: ${words.text.card}`],
    [{ name: 'Frank', contact: '4242 4242 4242 4242' }, `${words.fields.contact}: ${words.text.card}`],
    [{ name: 'Frank', note: 'Card 4242-4242-4242-4242' }, `${words.fields.note}: ${words.text.card}`]
  ];
  for (const [fields, sentence] of cases) {
    const rid = newRequestId();
    const answer = await claimForm('route-text', slotIds[0]!, { rid, ...fields });
    assert.equal(answer.status, 400, sentence);
    assert.equal(answer.headers.get('location'), null);
    const page = await answer.text();
    assert.ok(page.includes(escapeHtml(sentence)), sentence);
    assert.ok(page.includes(`name="rid" value="${rid}"`), 'the same request id, so sending it again signs up once');
    for (const typed of Object.values(fields)) assert.ok(page.includes(escapeHtml(typed)), `what was typed: ${typed}`);
  }
  // A form out of date (no usable request id) keeps what was typed and gets a new request id.
  const stale = await claimForm('route-text', slotIds[0]!, { rid: 'not-a-uuid', name: 'Frank' });
  assert.equal(stale.status, 400);
  const page = await stale.text();
  assert.ok(page.includes(escapeHtml(words.formErrors.form)) && page.includes('value="Frank"'));
  assert.match(page, /name="rid" value="[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"/);
  assert.equal(await count(pool, 'select count(*) from people'), people, 'no refusal wrote anything');
  const fine = await claimForm('route-text', slotIds[0]!, { rid: newRequestId(), name: 'The Mike family', contact: '+1 415 555 0134' });
  assert.equal(fine.status, 303);
  assert.match(fine.headers.get('location')!, /^\/me\?new=/);
});

test('member writes are throttled per connection (the 31st in 10 minutes gets 429)', async () => {
  const { POST } = await route('me/profile');
  let last: Response | undefined;
  for (let i = 0; i < 31; i += 1) last = await POST!(formPost('/me/profile', { name: 'X' }), params({}));
  assert.equal(last!.status, 429);
  assert.ok((await last!.text()).includes(escapeHtml(words.throttle.memberWrite)));
});

/** Every organizer route that must refuse a stranger: all of src/app/organizer/** except setup, sign-in, sign-out, give-up. */
function organizerRoutes(): string[] {
  return routePaths().filter(
    (path) => path.startsWith('organizer/') && !['organizer/setup', 'organizer/sign-in', 'organizer/sign-out', 'organizer/give-up'].includes(path)
  );
}

test('every organizer POST refuses no cookie, a forged seat, a wrong-key password cookie and a seat after the password; the seat holder passes', async () => {
  // The organizer's downloads have no POST: data-routes.test.ts sends strangers' GETs to them.
  const paths: string[] = [];
  for (const path of organizerRoutes()) if ((await route(path)).POST) paths.push(path);
  assert.ok(paths.length >= 20, `${paths.length} organizer routes`);
  const settings = readSettings({ DATABASE_URL: url });
  const seat = await takeSeat(pool, settings);
  assert.ok(seat, 'this database is fresh: the seat is open');
  const strangers: Record<string, string>[] = [
    {},
    { ss_org: `seat.${newToken()}` },
    { ss_org: passwordCookie({ ...settings, organizerPassword: 'not the saved password at all' }).cookieValue },
    { ss_org: `pw.${Math.floor(Date.now() / 1000)}.${newToken()}` }
  ];
  const before = { activity: await count(pool, 'select count(*) from activity'), people: await count(pool, 'select count(*) from people') };
  for (const path of paths) {
    const { POST } = await route(path);
    for (const cookies of strangers) {
      const answer = await POST!(formPost(`/${path}`, { name: 'Stranger', confirm: 'yes' }, { cookies }), params(pathParams(path)));
      assert.equal(answer.status, 403, `${path} with ${Object.values(cookies)[0]?.slice(0, 5) ?? 'no cookie'}`);
      const body = await answer.text();
      assert.ok(body.includes(escapeHtml(words.signInFirst)));
      assert.ok(!body.includes('example'), 'nothing private in the refusal');
    }
  }
  assert.equal(await count(pool, 'select count(*) from activity'), before.activity, 'the refused requests wrote nothing');
  assert.equal(await count(pool, 'select count(*) from people'), before.people);
  for (const path of paths) {
    const { POST } = await route(path);
    const holder = await POST!(formPost(`/${path}`, {}, { cookies: { ss_org: seat.cookieValue } }), params(pathParams(path)));
    assert.notEqual(holder.status, 403, `control: the seat holder passes ${path}`);
  }

  // Once a password is saved, the old seat cookie is refused everywhere too.
  process.env.ORGANIZER_PASSWORD = 'correct horse battery staple';
  try {
    for (const path of paths) {
      const { POST } = await route(path);
      const answer = await POST!(formPost(`/${path}`, {}, { cookies: { ss_org: seat.cookieValue } }), params(pathParams(path)));
      assert.equal(answer.status, 403, `${path} with the retired seat`);
    }
    const signedIn = passwordCookie(readSettings()).cookieValue;
    const { POST } = await route('organizer/settings');
    const control = await POST!(formPost('/organizer/settings', { groupName: 'U9 Tigers', duesAmount: '' }, { cookies: { ss_org: signedIn } }), params({}));
    assert.equal(control.status, 303, 'control: a valid password cookie passes');
  } finally {
    process.env.ORGANIZER_PASSWORD = '';
  }
});

test('an organizer cookie on a member route is recorded as the organizer (G4)', async () => {
  const fresh = await cluster.createDatabase({ migrated: true });
  await useDatabase(fresh);
  const local = poolFor(fresh);
  try {
    const { slotIds } = await sheetWithSlots(local, { slug: 'actor', capacities: [2] });
    const seat = (await takeSeat(local, readSettings({ DATABASE_URL: fresh })))!;
    const browser = 'organizerPhone_0000000';
    await claimForm('actor', slotIds[0]!, { rid: newRequestId(), name: 'Added by Mike' }, { ss_org: seat.cookieValue, ss_b: browser });
    await claimForm('actor', slotIds[0]!, { rid: newRequestId(), name: 'Frank' }, { ss_b: 'memberPhone_0000000000' });
    const { rows } = await local.query<{ actor: string; browser: string }>('select actor, browser from activity order by id');
    assert.deepEqual(rows, [
      { actor: 'organizer', browser },
      { actor: 'member', browser: 'memberPhone_0000000000' }
    ]);
  } finally {
    await local.end();
    await useDatabase(url);
  }
});

test('setup: five presses at once give one seat (303 with the cookie) and four 403s; then sign-in is throttled and slow when wrong', async () => {
  const fresh = await cluster.createDatabase({ migrated: true });
  await useDatabase(fresh);
  const local = poolFor(fresh);
  try {
    const { POST: setup } = await route('organizer/setup');
    const answers = await Promise.all(Array.from({ length: 5 }, () => setup!(formPost('/organizer/setup', {}), params({}))));
    const winners = answers.filter((answer) => answer.status === 303);
    assert.equal(winners.length, 1);
    const cookie = cookieSet(winners[0]!, 'ss_org');
    assert.match(cookie ?? '', /^seat\.[A-Za-z0-9_-]{43}$/);
    assert.match(winners[0]!.headers.getSetCookie()[0]!, /; HttpOnly; SameSite=Lax$/, 'http on loopback: no Secure, no __Host- (tests only)');
    for (const loser of answers.filter((answer) => answer.status !== 303)) {
      assert.equal(loser.status, 403);
      assert.ok((await loser.text()).includes(escapeHtml(words.organizer.setupLost)));
    }

    await useDatabase(fresh, 'correct horse battery staple');
    const { POST: signIn } = await route('organizer/sign-in');
    const started = Date.now();
    const wrong = await signIn!(formPost('/organizer/sign-in', { password: 'wrong guess' }), params({}));
    assert.equal(wrong.headers.get('location'), '/organizer?e=wrong');
    assert.ok(Date.now() - started >= 950, 'a wrong password waits a second');
    const right = await signIn!(formPost('/organizer/sign-in', { password: ' correct horse battery staple ' }), params({}));
    assert.equal(right.headers.get('location'), '/organizer');
    assert.match(cookieSet(right, 'ss_org') ?? '', /^pw\.\d+\./);
    // The right one was refunded: four more wrong ones fit in the 5 allowed, the sixth failure is refused.
    for (let i = 0; i < 4; i += 1) assert.equal((await signIn!(formPost('/organizer/sign-in', { password: 'nope' }), params({}))).status, 303);
    const sixth = await signIn!(formPost('/organizer/sign-in', { password: 'correct horse battery staple' }), params({}));
    assert.equal(sixth.status, 429);
    assert.ok((await sixth.text()).includes(escapeHtml(words.throttle.signIn)));
  } finally {
    await local.end();
    await useDatabase(url);
  }
});

test('sign-in: a connection refused by its own limit uses up none of the copy-wide budget; 50 real failures still close it', async () => {
  const fresh = await cluster.createDatabase({ migrated: true });
  await useDatabase(fresh, 'correct horse battery staple');
  const local = poolFor(fresh);
  try {
    const { POST: signIn } = await route('organizer/sign-in');
    // Two connections tell themselves apart by address (synthetic, from TEST-NET-1).
    const from = (address: string, password: string) =>
      signIn!(formPost('/organizer/sign-in', { password }, { headers: { 'x-real-ip': address } }), params({}));

    for (let i = 0; i < 5; i += 1) assert.equal((await from('192.0.2.1', 'wrong guess')).headers.get('location'), '/organizer?e=wrong');
    for (let i = 0; i < 50; i += 1) assert.equal((await from('192.0.2.1', 'wrong guess')).status, 429);
    const elsewhere = await from('192.0.2.2', 'correct horse battery staple');
    assert.equal(elsewhere.status, 303, 'the organizer, from another connection, with the right password');
    assert.match(cookieSet(elsewhere, 'ss_org') ?? '', /^pw\.\d+\./);

    // Control: real failures from ten connections (5 each) fill the copy's 50, and the next try anywhere is refused.
    await resetThrottle(local);
    const connections = Array.from({ length: 10 }, (_, i) => `192.0.2.${10 + i}`);
    await Promise.all(connections.map(async (address) => {
      for (let i = 0; i < 5; i += 1) assert.equal((await from(address, 'wrong guess')).status, 303);
    }));
    const closed = await from('192.0.2.99', 'correct horse battery staple');
    assert.equal(closed.status, 429);
    assert.ok((await closed.text()).includes(escapeHtml(words.throttle.signIn)));
  } finally {
    await local.end();
    await useDatabase(url);
  }
});

test('every POST route refuses a foreign Origin, Origin: null, same-site with no Origin, and no headers (handler-level T21)', async () => {
  const posts = await originProbe(route, pool);
  assert.ok(posts >= 30, `${posts} POST routes`);
});
