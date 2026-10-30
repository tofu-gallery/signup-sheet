// Negative controls: each runs a copy of the source with one protection taken out (changedCopy, a scratch directory
// that is deleted afterwards; the real source is never changed) and shows that the probe for that protection sees the
// bug. A probe that cannot fail proves nothing. Where the probe is shared (test/support/probes.ts), the control runs
// that very probe on the copy and requires the assertion it fails with. Where a race is involved, the copy also waits
// at the point the bug needs, so the control fails every time instead of when the scheduler allows it.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type pg from 'pg';
import { takeSeat } from '../../src/lib/access';
import { readSettings } from '../../src/lib/settings';
import { newRequestId, newToken } from '../../src/lib/tokens';
import { poolFor, waitFor } from '../support/fixtures';
import {
  changedCopy,
  count,
  type Edit,
  endRoutePool,
  formPost,
  member,
  organizer,
  params,
  personWithLink,
  roster,
  sheetWithSlots,
  useDatabase
} from '../support/core';
import {
  copyRoutes,
  importStrangerProbe,
  type MemberAction,
  organizerPagesProbe,
  originProbe,
  pageFixture,
  ownershipProbe,
  removalRaceProbe,
  replayWithCookieProbe,
  type RouteLoader,
  seatRaceProbe
} from '../support/probes';
import { type Cluster, startCluster } from '../support/postgres';

type Signups = typeof import('../../src/lib/signups');
type People = typeof import('../../src/lib/people');
type Views = typeof import('../../src/lib/views');
type Identity = typeof import('../../src/lib/identity');
type Locks = typeof import('../../src/lib/locks');
type Access = typeof import('../../src/lib/access');
type Route = { POST: (request: Request, context: unknown) => Promise<Response> };

let cluster: Cluster;
const pools: pg.Pool[] = [];

before(async () => {
  cluster = await startCluster();
});

after(async () => {
  await endRoutePool();
  await Promise.all(pools.map((pool) => pool.end()));
  await cluster?.stop();
});

async function copyDatabase(): Promise<{ url: string; pool: pg.Pool }> {
  const url = await cluster.createDatabase({ migrated: true });
  const pool = poolFor(url);
  pools.push(pool);
  return { url, pool };
}

async function twoSignups(pool: pg.Pool, slug: string) {
  const { slotIds } = await sheetWithSlots(pool, { slug, capacities: [2, 2] });
  const a = await personWithLink(pool, 'A');
  const b = await personWithLink(pool, 'B');
  const insert = async (personId: string) =>
    (await pool.query<{ id: string }>("insert into signups (slot_id, person_id, status, added_by) values ($1, $2, 'confirmed', 'member') returning id", [slotIds[0], personId])).rows[0]!.id;
  return { slotIds, a, b, aSignup: await insert(a.id), bSignup: await insert(b.id) };
}

/** Runs a shared route probe on a changed copy's route handlers and a fresh database; answers the assertion it failed. */
async function probeFails(edits: Edit[], probe: (load: RouteLoader, pool: pg.Pool) => Promise<unknown>): Promise<assert.AssertionError> {
  const copy = changedCopy(edits);
  try {
    const { url, pool } = await copyDatabase();
    await useDatabase(url);
    const failure = await probe(copyRoutes(copy), pool).then(
      () => null,
      (error: unknown) => error
    );
    assert.ok(failure instanceof assert.AssertionError, `the probe must fail an assertion on the copy, not end with ${String(failure)}`);
    return failure;
  } finally {
    copy.remove();
  }
}

/** The probe's own message comes first; node:assert adds the values it compared after it. */
function failedWith(failure: assert.AssertionError, message: string): void {
  assert.ok(failure.message.startsWith(message), `expected the probe to fail with "${message}", it failed with: ${failure.message}`);
}

// The person filter each member route relies on: note and cancel reach their sign-up through lockOneSignup, move through
// its own two reads.
const LOCK_ONE_FILTER: Edit[] = [
  { file: 'src/lib/signups.ts', from: '[signupId, owner?.personId ?? null]', to: '[signupId, null]' },
  { file: 'src/lib/signups.ts', from: 'lockSignups(tx, [signupId], owner ? { personId: owner.personId } : null)', to: 'lockSignups(tx, [signupId], null)' }
];
const MOVE_FILTER: Edit[] = [
  { file: 'src/lib/signups.ts', from: '[input.signupId, input.owner?.personId ?? null]', to: '[input.signupId, null]' },
  {
    file: 'src/lib/signups.ts',
    from: 'lockSignups(tx, [input.signupId], input.owner ? { personId: input.owner.personId } : null)',
    to: 'lockSignups(tx, [input.signupId], null)'
  }
];

for (const [action, edits] of [['note', LOCK_ONE_FILTER], ['cancel', LOCK_ONE_FILTER], ['move', MOVE_FILTER]] as [MemberAction, Edit[]][]) {
  test(`control: without the person filter the ${action} route uses, its G6 route probe fails (A's link changes B's sign-up)`, async () => {
    const failure = await probeFails(edits, (load, pool) => ownershipProbe(load, pool, action, `control-g6-${action}`));
    failedWith(failure, `${action} with A's link on B's sign-up`);
  });
}

test('control: without the Origin check in guarded(), the T21 probe fails at the first POST route', async () => {
  const failure = await probeFails(
    [{ file: 'src/lib/guard.ts', from: '    if (!originAllowed(request.headers)) return sentencePage(403, words.originRefused);\n', to: '' }],
    originProbe
  );
  failedWith(failure, 'forget with Origin https://evil.trytofu.app');
});

test('control: without the organizer check in the import route, a stranger imports (the M10b import probe fails)', async () => {
  const failure = await probeFails(
    [{ file: 'src/app/organizer/import/route.ts', from: "    if (!signedIn) return organizerRefusal(json ? 'json' : 'form');\n", to: '' }],
    async (load, pool) => importStrangerProbe(load, pool, (await takeSeat(pool, readSettings()))!.cookieValue)
  );
  failedWith(failure, "a stranger's JSON import");
});

test("control: without the organizer check in organizerGet, a stranger gets the organizer's pages (the T36 page probe fails)", async () => {
  const failure = await probeFails(
    [
      {
        file: 'src/lib/routes.ts',
        from: "  if (!signedIn) return seeOther('/organizer');\n  return { pool, settings, signedIn };",
        to: "  return { pool, settings, signedIn: signedIn ?? { access: { state: 'password' as const, seat: null }, organizer: { via: 'password' as const } } };"
      }
    ],
    async (load, pool) => organizerPagesProbe(load, pool, (await takeSeat(pool, readSettings()))!.cookieValue, await pageFixture(pool, 'control-pages'))
  );
  failedWith(failure, 'organizer/dates/[id]/cancel: a stranger (no cookie)');
});

test('control: one POST route not wrapped in guarded() fails the T21 probe at that route', async () => {
  const failure = await probeFails([{ file: 'src/app/me/profile/route.ts', from: 'export const POST = guarded(async', to: 'export const POST = (async' }], originProbe);
  failedWith(failure, 'me/profile with Origin https://evil.trytofu.app');
});

test("control: a claim that shows the someone-else link page whenever the phone remembers anyone fails the replay probe", async () => {
  const failure = await probeFails(
    [{ file: 'src/app/s/[slug]/slots/[id]/claim/route.ts', from: 'remembered && remembered.personId !== result.personId', to: "remembered && who.kind === 'new'" }],
    (load, pool) => replayWithCookieProbe(load, pool, 'control-replay')
  );
  assert.match(failure.message, /^the same form from the person it made/);
});

test("control: without setup's open-seat condition, five presses at once all take the seat (the seat race probe fails)", async () => {
  const copy = changedCopy([{ file: 'src/lib/access.ts', from: "where id = 1 and seat_state = 'open' and now()", to: 'where id = 1 and now()' }]);
  try {
    const { takeSeat } = await copy.load<Access>('src/lib/access.ts');
    const { url } = await copyDatabase();
    const processes = Array.from({ length: 5 }, () => poolFor(url));
    pools.push(...processes);
    const failure = await seatRaceProbe(takeSeat, processes, readSettings({ DATABASE_URL: url })).then(
      () => null,
      (error: unknown) => error
    );
    assert.ok(failure instanceof assert.AssertionError, String(failure));
    assert.match(failure.message, /^exactly one browser holds the seat/);
  } finally {
    copy.remove();
  }
});

test('control: W11 without its person lock and last read deadlocks with a member write it does not hold (the W11 probe fails)', async () => {
  const { url } = await copyDatabase();
  const withoutPersonLock: Edit = {
    file: 'src/lib/people.ts',
    from: [
      "      const found = await tx.query('select 1 from people where id = $1 for update', [personId]);",
      "      if (found.rows.length === 0) return { kind: 'missing' };",
      '      const final = await tx.query<{ id: string; slotId: string }>(',
      '        \'select id, slot_id as "slotId" from signups where person_id = $1 order by id\',',
      '        [personId]',
      '      );',
      '      if (same(final.rows) !== same(before.rows)) throw new Restart();'
    ].join('\n'),
    to: ["      const found = await tx.query('select 1 from people where id = $1', [personId]);", "      if (found.rows.length === 0) return { kind: 'missing' };"].join('\n')
  };
  const failure = await removalRaceProbe(url, [withoutPersonLock]).then(
    () => null,
    (error: unknown) => error
  );
  assert.ok(failure instanceof assert.AssertionError, String(failure));
  assert.match(failure.message, /^deadlock: the (removal|cancel) was ended as its victim/);
});

test('control: without the slot lock and the capacity CHECK, ten claims on one place overfill it (the race probe sees it)', async () => {
  const copy = changedCopy([
    { file: 'src/lib/locks.ts', from: 'order by s.id for update of s', to: 'order by s.id' },
    // Every claim reads the count before any commits: the race happens every time.
    { file: 'src/lib/signups.ts', from: "  const repeated = await answerRepeatedForm(", to: "  await new Promise((resolve) => setTimeout(resolve, 300));\n  const repeated = await answerRepeatedForm(" }
  ]);
  try {
    const { claim } = await copy.load<Signups>('src/lib/signups.ts');
    const { url, pool } = await copyDatabase();
    await pool.query('alter table slots drop constraint slots_within_capacity');
    const others = [poolFor(url), poolFor(url)];
    pools.push(...others);
    const { slotIds } = await sheetWithSlots(pool, { slug: 'control-race', capacities: [1] });
    const settings = readSettings({ DATABASE_URL: url });
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        claim([pool, ...others][i % 3]!, settings, { slug: 'control-race', slotId: slotIds[0]!, requestId: newRequestId(), who: { kind: 'new', name: `C${i}`, contact: '' }, note: '', rules: 'member' }, member())
      )
    );
    assert.ok((await roster(pool, slotIds[0]!)).confirmed.length > 1, 'the bug is visible: more confirmed than places');
  } finally {
    copy.remove();
  }
});

test('control: without the re-read of a sign-up under its slot lock (X1), a cancel frees the wrong slot', async () => {
  const copy = changedCopy([{ file: 'src/lib/signups.ts', from: 'if (!sheet || !slot || signup.slotId !== slotId) throw new Restart();', to: 'if (!sheet || !slot) throw new Restart();' }]);
  try {
    const { cancelSignup } = await copy.load<Signups>('src/lib/signups.ts');
    const { lockSheets } = await copy.load<Locks>('src/lib/locks.ts');
    const { url, pool } = await copyDatabase();
    const other = poolFor(url);
    pools.push(other);
    const { sheetId, slotIds } = await sheetWithSlots(pool, { slug: 'control-x1', capacities: [1, 1, 1] });
    const [x, y, z] = slotIds as [string, string, string];
    const a = await personWithLink(pool, 'A');
    const aSignup = (await pool.query<{ id: string }>("insert into signups (slot_id, person_id, status, added_by) values ($1, $2, 'confirmed', 'member') returning id", [x, a.id])).rows[0]!.id;
    for (const [slot, name, status] of [[x, 'Waiting X', 'waiting'], [z, 'Z', 'confirmed'], [z, 'Waiting Z', 'waiting']] as const) {
      const person = await personWithLink(pool, name);
      await pool.query("insert into signups (slot_id, person_id, status, added_by) values ($1, $2, $3, 'member')", [slot, person.id, status]);
    }
    const structural = await pool.connect();
    try {
      await structural.query('begin');
      await lockSheets(structural, [sheetId], 'update');
      const cancel = cancelSignup(other, { signupId: aSignup, owner: a.auth }, member());
      await waitFor(async () => (await count(pool, "select count(*) from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()")) > 0, 'the cancel to wait');
      await structural.query("update signups set slot_id = $1 where slot_id = $2 and status = 'confirmed'", [y, z]);
      await structural.query('update signups set slot_id = $1 where id = $2', [z, aSignup]);
      await structural.query("update signups set status = 'confirmed' where slot_id = $1 and status = 'waiting'", [x]);
      await structural.query('commit');
      await cancel;
    } finally {
      structural.release();
    }
    assert.deepEqual((await roster(pool, z)).waiting, ['Waiting Z'], "the bug is visible: Z's place is free but its waiting person was not moved up");
  } finally {
    copy.remove();
  }
});

test("control: a repeated form whose name is not compared hands the first person's link to someone else", async () => {
  const copy = changedCopy([
    { file: 'src/lib/signups.ts', from: "earlier.addedBy !== 'member' || earlier.name !== who.name || earlier.contact !== who.contact", to: "earlier.addedBy !== 'member' || earlier.contact !== who.contact" }
  ]);
  try {
    const { claim } = await copy.load<Signups>('src/lib/signups.ts');
    const { url, pool } = await copyDatabase();
    const settings = readSettings({ DATABASE_URL: url });
    const { slotIds } = await sheetWithSlots(pool, { slug: 'control-rid', capacities: [2] });
    const input = { slug: 'control-rid', slotId: slotIds[0]!, requestId: newRequestId(), who: { kind: 'new' as const, name: 'Frank', contact: '' }, note: '', rules: 'member' as const };
    const first = await claim(pool, settings, input, member());
    const other = await claim(pool, settings, { ...input, who: { kind: 'new', name: 'Mike', contact: '' } }, member());
    assert.equal(other.kind, 'signed-up');
    assert.equal((other as { token: string }).token, (first as { token: string }).token, "the bug is visible: Mike got Frank's link");
  } finally {
    copy.remove();
  }
});

test('control: with a link formula that leaves out the person id, a form sent again after a cancel brings a replaced link back', async () => {
  const copy = changedCopy([{ file: 'src/lib/tokens.ts', from: '.update(`edit-link\\0${requestId}\\0${personId}`)', to: '.update(`edit-link\\0${requestId}`)' }]);
  try {
    const { claim, cancelSignup } = await copy.load<Signups>('src/lib/signups.ts');
    const { makeNewLink } = await copy.load<People>('src/lib/people.ts');
    const { memberByToken } = await copy.load<Identity>('src/lib/identity.ts');
    const { url, pool } = await copyDatabase();
    const settings = readSettings({ DATABASE_URL: url });
    const { slotIds } = await sheetWithSlots(pool, { slug: 'control-link', capacities: [1] });
    const input = { slug: 'control-link', slotId: slotIds[0]!, requestId: newRequestId(), who: { kind: 'new' as const, name: 'Frank', contact: '' }, note: '', rules: 'member' as const };
    const first = (await claim(pool, settings, input, member())) as { token: string; signupId: string };
    const person = (await memberByToken(pool, first.token))!;
    const made = (await makeNewLink(pool, { personId: person.id }, organizer())) as { token: string };
    await cancelSignup(pool, { signupId: first.signupId, owner: null }, organizer());
    assert.equal(await memberByToken(pool, first.token), null, 'the old link was replaced');
    assert.ok(made.token);
    await claim(pool, settings, input, member());
    assert.notEqual(await memberByToken(pool, first.token), null, 'the bug is visible: the replaced link opens a person again');
  } finally {
    copy.remove();
  }
});

test("control: a public view that selects a contact leaks it (the privacy probe sees it)", async () => {
  const copy = changedCopy([{ file: 'src/lib/views.ts', from: '? `select g.slot_id as "slotId", p.name, g.note', to: '? `select g.slot_id as "slotId", p.name || \' \' || p.contact as name, g.note' }]);
  try {
    const { publicSheetView } = await copy.load<Views>('src/lib/views.ts');
    const { pool } = await copyDatabase();
    const { slotIds } = await sheetWithSlots(pool, { slug: 'control-privacy', capacities: [1] });
    const frank = await personWithLink(pool, 'Frank', 'privacy-probe-control@example.com');
    await pool.query("insert into signups (slot_id, person_id, status, added_by) values ($1, $2, 'confirmed', 'member')", [slotIds[0], frank.id]);
    assert.ok(JSON.stringify(await publicSheetView(pool, 'control-privacy', { draft: false })).includes('privacy-probe-control'), 'the bug is visible');
  } finally {
    copy.remove();
  }
});

test("control: without the organizer check, a stranger's POST removes a sign-up (the organizer-route probe sees it)", async () => {
  const copy = changedCopy([
    {
      file: 'src/lib/routes.ts',
      from: "  if (!signedIn) return organizerRefusal('form');\n  return makePost(request, form, pool, settings, signedIn.organizer);",
      to: '  return makePost(request, form, pool, settings, signedIn?.organizer ?? null);'
    }
  ]);
  try {
    const { POST } = await copy.load<Route>('src/app/organizer/signups/[id]/remove/route.ts');
    const { url, pool } = await copyDatabase();
    await useDatabase(url);
    const { bSignup } = await twoSignups(pool, 'control-organizer');
    const answer = await POST(formPost(`/organizer/signups/${bSignup}/remove`, {}, { cookies: { ss_org: `seat.${newToken()}` } }), params({ id: bSignup }));
    assert.equal(answer.status, 303);
    assert.equal(await count(pool, 'select count(*) from signups where id = $1', [bSignup]), 0, 'the bug is visible: a stranger removed B');
  } finally {
    copy.remove();
  }
});
