// Probes shared by a test on the real source and by its negative control on a changed copy (controls.test.ts), so a
// control shows that this very probe fails once its protection is taken out. Each throws an AssertionError when what
// it guards does not hold. Route handlers are called directly (a Request in, a Response out): not HTTP tests.
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import type pg from 'pg';
import type { SeatTaken } from '../../src/lib/access';
import { isDbError } from '../../src/lib/db';
import { escapeHtml } from '../../src/lib/responses';
import { readSettings, type Settings } from '../../src/lib/settings';
import { newRequestId, newToken } from '../../src/lib/tokens';
import { words } from '../../src/words';
import { poolFor, waitFor } from './fixtures';
import {
  assertCountsConsistent,
  changedCopy,
  cookieSet,
  count,
  type Edit,
  formPost,
  get,
  jsonPost,
  member,
  organizer,
  params,
  pauseAfter,
  pauses,
  personWithLink,
  roster,
  settled,
  sheetWithSlots,
  snapshot
} from './core';
import { REPO } from './postgres';

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
export type RouteModule = { POST?: Handler; GET?: Handler };
/** Loads a route module by its path under src/app, such as 'me/signups/[id]/note'. */
export type RouteLoader = (path: string) => Promise<RouteModule>;

export const realRoutes: RouteLoader = (path) => import(join(REPO, 'src/app', path, 'route.ts')) as Promise<RouteModule>;

export function copyRoutes(copy: { load<T>(file: string): Promise<T> }): RouteLoader {
  return (path) => copy.load<RouteModule>(`src/app/${path}/route.ts`);
}

/** Every route's path under src/app, sorted. */
export function routePaths(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : entry.name === 'route.ts' ? [dir] : []));
  return walk(join(REPO, 'src/app'))
    .map((dir) => relative(join(REPO, 'src/app'), dir))
    .sort();
}

/** Path parameters naming nothing that exists, so a request that gets past a check changes nothing. */
export function pathParams(path: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const match of path.matchAll(/\[(\w+)\]/g)) values[match[1]!] = match[1] === 'slug' ? 'no-such-sheet' : '999999999';
  return values;
}

/**
 * T21 at the handler level: every POST route answers a foreign Origin, `Origin: null`, no Origin, and same-site with no
 * Origin with the 403 refusal, before its handler reads anything (no throttle hit is counted). Answers how many POST
 * routes it checked.
 */
export async function originProbe(load: RouteLoader, pool: pg.Pool): Promise<number> {
  const before = await count(pool, 'select count(*) from throttle');
  let posts = 0;
  for (const path of routePaths()) {
    const { POST } = await load(path);
    if (!POST) continue;
    posts += 1;
    for (const origin of ['https://evil.trytofu.app', 'null', null]) {
      const answer = await POST(formPost(`/${path}`, {}, { origin }), params(pathParams(path)));
      assert.equal(answer.status, 403, `${path} with Origin ${origin}`);
      assert.ok((await answer.text()).includes(escapeHtml(words.originRefused)), `${path}: the refusal's sentence`);
    }
    const sameSite = new Request(`http://127.0.0.1:3000/${path}`, {
      method: 'POST',
      headers: { host: '127.0.0.1:3000', 'sec-fetch-site': 'same-site', 'content-type': 'application/x-www-form-urlencoded' },
      body: ''
    });
    assert.equal((await POST(sameSite, params(pathParams(path)))).status, 403, `${path} same-site without Origin`);
  }
  assert.equal(await count(pool, 'select count(*) from throttle'), before, 'a refused POST never reached its handler');
  return posts;
}

export type MemberAction = 'note' | 'cancel' | 'move';

/**
 * G6 (T35) through one member route: A's cookie on B's sign-up gets the unknown-link 404, keeps A's cookie and changes
 * nothing; then A's own sign-up through the same route works, the probe's own control.
 */
export async function ownershipProbe(load: RouteLoader, pool: pg.Pool, action: MemberAction, slug: string): Promise<void> {
  const { slotIds } = await sheetWithSlots(pool, { slug, capacities: [2, 2] });
  const a = await personWithLink(pool, 'A');
  const b = await personWithLink(pool, 'B');
  const signUp = async (personId: string) =>
    (
      await pool.query<{ id: string }>(
        "insert into signups (slot_id, person_id, status, note, added_by) values ($1, $2, 'confirmed', 'Mine', 'member') returning id",
        [slotIds[0], personId]
      )
    ).rows[0]!.id;
  const mine = await signUp(a.id);
  const theirs = await signUp(b.id);
  const { POST } = await load(`me/signups/[id]/${action}`);
  const fields: Record<string, string> = action === 'note' ? { note: 'Changed' } : action === 'move' ? { to: slotIds[1]! } : {};
  const send = (signupId: string) =>
    POST!(formPost(`/me/signups/${signupId}/${action}`, fields, { cookies: { ss_me: a.token } }), params({ id: signupId }));

  const answer = await send(theirs);
  assert.equal(answer.status, 404, `${action} with A's link on B's sign-up`);
  assert.equal(cookieSet(answer, 'ss_me'), null, "A's working cookie is not cleared");
  const { rows } = await pool.query<{ slot_id: string; note: string }>('select slot_id, note from signups where id = $1', [theirs]);
  assert.deepEqual(rows[0], { slot_id: slotIds[0], note: 'Mine' }, "B's sign-up is unchanged");
  assert.equal((await send(mine)).status, 303, `control: ${action} on A's own sign-up`);
  await assertCountsConsistent(pool);
}

/**
 * T09 with the cookie the first answer set: the same claim form sent again from that browser (back and resend, a second
 * tap), alone or several at once, gets the first answer again: 303 to the same /me?new=, the same cookie. Its control:
 * a browser that remembers someone else still gets the new person's link page, every time, and keeps its own cookie.
 */
export async function replayWithCookieProbe(load: RouteLoader, pool: pg.Pool, slug: string): Promise<void> {
  const { slotIds } = await sheetWithSlots(pool, { slug, capacities: [3] });
  const slotId = slotIds[0]!;
  const { POST } = await load('s/[slug]/slots/[id]/claim');
  const send = (fields: Record<string, string>, cookies: Record<string, string> = {}) =>
    POST!(formPost(`/s/${slug}/slots/${slotId}/claim`, fields, { cookies }), params({ slug, id: slotId }));

  const fields = { rid: newRequestId(), name: 'The Frank family', contact: '' };
  const first = await send(fields);
  assert.equal(first.status, 303);
  const location = first.headers.get('location');
  const token = cookieSet(first, 'ss_me') ?? '';
  assert.match(location ?? '', /^\/me\?new=\d+$/);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  const repeats = [await send(fields, { ss_me: token }), ...(await Promise.all([1, 2, 3].map(() => send(fields, { ss_me: token }))))];
  for (const repeat of repeats) {
    assert.equal(repeat.status, 303, 'the same form from the person it made: the first answer, not a link "for someone else"');
    assert.equal(repeat.headers.get('location'), location);
    assert.equal(cookieSet(repeat, 'ss_me'), token);
  }

  const mike = await personWithLink(pool, 'Mike');
  const forGrandma = { rid: newRequestId(), name: 'Grandma', contact: '' };
  for (const answer of [await send(forGrandma, { ss_me: mike.token }), await send(forGrandma, { ss_me: mike.token })]) {
    assert.equal(answer.status, 200, "control: a link made for someone else is shown, and the phone's person stays");
    assert.equal(cookieSet(answer, 'ss_me'), null);
    assert.ok((await answer.text()).includes(escapeHtml(words.member.sendToThem)));
  }
  assert.deepEqual(await roster(pool, slotId), { confirmed: ['The Frank family', 'Grandma'], waiting: [] });
}

/**
 * M10b and T36 for the import: strangers' imports (no cookie, a forged seat, a password cookie signed by another key),
 * as JSON and as the import page's form, are refused (401 JSON, 403 the form) and change nothing, not even the count
 * against the organizer's import limit. Its control on the same route: the organizer's own check of the file is 200.
 */
export async function importStrangerProbe(load: RouteLoader, pool: pg.Pool, organizerCookie: string): Promise<void> {
  const { POST } = await load('organizer/import');
  const file = JSON.stringify({ format: 'signup-sheet/1', dryRun: true, people: [{ key: 'probe', name: 'Import probe' }] });
  const before = await snapshot(pool);
  const counted = await count(pool, 'select count(*) from throttle');
  const strangers: Record<string, string>[] = [{}, { ss_org: `seat.${newToken()}` }, { ss_org: `pw.${Math.floor(Date.now() / 1000)}.${newToken()}` }];
  for (const cookies of strangers) {
    const json = await POST!(jsonPost('/organizer/import', file, cookies), params({}));
    assert.equal(json.status, 401, `a stranger's JSON import (${Object.values(cookies)[0]?.slice(0, 5) ?? 'no cookie'})`);
    assert.deepEqual(await json.json(), { error: words.signInFirst });
    const form = await POST!(formPost('/organizer/import', { json: file, action: 'import', rid: newRequestId() }, { cookies }), params({}));
    assert.equal(form.status, 403, "a stranger's import form");
    assert.ok((await form.text()).includes(escapeHtml(words.signInFirst)));
  }
  assert.deepEqual(await snapshot(pool), before, "a stranger's import changes nothing");
  assert.equal(await count(pool, 'select count(*) from throttle'), counted, "a stranger's import uses up none of the organizer's");
  const control = await POST!(jsonPost('/organizer/import', file, { ss_org: organizerCookie }), params({}));
  assert.equal(control.status, 200, "control: the organizer's own check of the same file");
}

/** Real ids for the organizer's pages: an open sheet with a date ahead, a place, a confirmed sign-up and its person. */
export type PageFixture = { slug: string; dateId: string; slotId: string; signupId: string; personId: string };

export async function pageFixture(pool: pg.Pool, slug = `pages-${Date.now().toString(36)}`): Promise<PageFixture> {
  const { dateId, slotIds } = await sheetWithSlots(pool, { slug, capacities: [2, 2] });
  const frank = await personWithLink(pool, "Frank's family", 'frank-fixture@example.test');
  const { rows } = await pool.query<{ id: string }>(
    "insert into signups (slot_id, person_id, status, added_by) values ($1, $2, 'confirmed', 'member') returning id",
    [slotIds[0], frank.id]
  );
  return { slug, dateId, slotId: slotIds[0]!, signupId: rows[0]!.id, personId: frank.id };
}

function fixtureParams(path: string, fixture: PageFixture): Record<string, string> {
  const values: Record<string, string> = {};
  if (path.includes('[slug]')) values.slug = fixture.slug;
  if (path.includes('[id]')) {
    values.id = path.startsWith('organizer/dates/')
      ? fixture.dateId
      : path.startsWith('organizer/slots/')
        ? fixture.slotId
        : path.startsWith('organizer/signups/')
          ? fixture.signupId
          : fixture.personId;
  }
  return values;
}

/** Organizer GETs whose answer to the organizer is a redirect to a page, not a page. */
const ORGANIZER_REDIRECTS = new Set(['organizer/sheets', 'organizer/sheets/[slug]/dates']);

/**
 * T36 for the organizer's pages: every organizer GET (the access page /organizer itself aside) sends strangers (no
 * cookie, a forged seat, a password cookie signed by another key) to /organizer with an empty body; its control on the
 * same route is the organizer's own page (200) for real ids. No GET writes activity. Answers how many routes it checked.
 */
export async function organizerPagesProbe(load: RouteLoader, pool: pg.Pool, organizerCookie: string, fixture: PageFixture): Promise<number> {
  const strangers: Record<string, string>[] = [{}, { ss_org: `seat.${newToken()}` }, { ss_org: `pw.${Math.floor(Date.now() / 1000)}.${newToken()}` }];
  const activity = await count(pool, 'select count(*) from activity');
  let checked = 0;
  for (const path of routePaths()) {
    if (!path.startsWith('organizer/')) continue;
    const { GET } = await load(path);
    if (!GET) continue;
    checked += 1;
    const values = fixtureParams(path, fixture);
    const address = `/${path.replace(/\[(\w+)\]/g, (_, name: string) => values[name]!)}`;
    for (const cookies of strangers) {
      const answer = await GET(get(address, cookies), params(values));
      assert.equal(answer.status, 303, `${path}: a stranger (${Object.values(cookies)[0]?.slice(0, 5) ?? 'no cookie'})`);
      assert.equal(answer.headers.get('location'), '/organizer');
      assert.equal(await answer.text(), '', `${path}: nothing in the answer`);
    }
    const control = await GET(get(address, { ss_org: organizerCookie }), params(values));
    assert.equal(control.status, ORGANIZER_REDIRECTS.has(path) ? 303 : 200, `control: the organizer gets ${path}`);
    await control.arrayBuffer();
  }
  assert.equal(await count(pool, 'select count(*) from activity'), activity, 'a GET writes no activity');
  return checked;
}

/** Five browsers press Set up at once, from five app processes: exactly one gets the seat. */
export async function seatRaceProbe(
  takeSeat: (db: pg.Pool, settings: Settings) => Promise<SeatTaken | null>,
  processes: pg.Pool[],
  settings: Settings
): Promise<SeatTaken> {
  const results = await Promise.all(processes.map((pool) => takeSeat(pool, settings)));
  const winners = results.filter((result): result is SeatTaken => result !== null);
  assert.equal(winners.length, 1, 'exactly one browser holds the seat');
  return winners[0]!;
}

type Signups = typeof import('../../src/lib/signups');
type People = typeof import('../../src/lib/people');

// Where the copy pauses: W11 once it holds the person's sign-ups, and a member write once it holds its sign-up.
const REMOVAL_HOLDS_SIGNUPS = '      if (signups.length !== before.rows.length) throw new Restart();';
const MEMBER_HOLDS_SIGNUP = '  const [signup] = await lockSignups(tx, [signupId], owner ? { personId: owner.personId } : null);';

/**
 * W11 against a member write it does not hold (locks.ts, step 5): while the removal of P holds P's sign-up on slot x,
 * P signs up for slot z and then cancels that new sign-up. Pauses in a copy of the source (plus `edits`, for a negative
 * control) line the steps up the same way every run: the cancel holds z and its sign-up when the removal goes on, and
 * only then asks for P. Neither may deadlock; both must finish, and P must be gone with every sign-up they had.
 */
export async function removalRaceProbe(url: string, edits: Edit[] = []): Promise<void> {
  const copy = changedCopy([
    pauseAfter('src/lib/people.ts', REMOVAL_HOLDS_SIGNUPS, 'removal'),
    pauseAfter('src/lib/signups.ts', MEMBER_HOLDS_SIGNUP, 'cancel'),
    ...edits
  ]);
  const gate = pauses(['removal', 'cancel']);
  const [db, first, second, third] = [poolFor(url), poolFor(url), poolFor(url), poolFor(url)] as const;
  try {
    const { claim, cancelSignup } = await copy.load<Signups>('src/lib/signups.ts');
    const { removePersonEverywhere } = await copy.load<People>('src/lib/people.ts');
    const slug = `removal-race-${Date.now().toString(36)}`;
    const { slotIds } = await sheetWithSlots(db, { slug, capacities: [2, 2] });
    const [x, z] = slotIds as [string, string];
    const p = await personWithLink(db, 'P');
    await db.query("insert into signups (slot_id, person_id, status, added_by) values ($1, $2, 'confirmed', 'member')", [x, p.id]);

    const removal = settled(removePersonEverywhere(first, p.id, organizer()));
    await gate.reached('removal');
    const made = await claim(second, readSettings({ DATABASE_URL: url }), {
      slug,
      slotId: z,
      requestId: newRequestId(),
      who: { kind: 'me', auth: p.auth, contact: '' },
      note: '',
      rules: 'member'
    }, member());
    assert.equal(made.kind, 'signed-up', JSON.stringify(made));
    const cancel = settled(cancelSignup(third, { signupId: (made as { signupId: string }).signupId, owner: p.auth }, member()));
    await gate.reached('cancel');
    gate.open('removal');
    await waitFor(
      async () => (await count(db, "select count(*) from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()")) > 0,
      'the removal to wait for the cancel'
    );
    gate.open('cancel');

    const outcomes = { removal: await removal, cancel: await cancel };
    for (const [what, outcome] of Object.entries(outcomes)) {
      assert.ok(!('error' in outcome && isDbError(outcome.error, '40P01')), `deadlock: the ${what} was ended as its victim`);
    }
    for (const [what, outcome] of Object.entries(outcomes)) {
      assert.ok('value' in outcome, `the ${what} failed: ${'error' in outcome ? String(outcome.error) : ''}`);
    }
    assert.equal((outcomes.removal as { value: { kind: string } }).value.kind, 'removed');
    assert.equal((outcomes.cancel as { value: { kind: string } }).value.kind, 'cancelled');
    assert.equal(await count(db, 'select count(*) from people where id = $1', [p.id]), 0);
    assert.equal(await count(db, 'select count(*) from signups where person_id = $1', [p.id]), 0);
    await assertCountsConsistent(db);
  } finally {
    gate.end();
    await Promise.all([db, first, second, third].map((pool) => pool.end()));
    copy.remove();
  }
}
