// W1, the claim, on a real database: a form's request id and its replays, new and remembered people, the race for the
// last place, the waitlist's order, refusals, and the activity record. These call the transaction functions directly
// from three pools (three app processes); they are not HTTP tests (test/db/routes.test.ts calls the route handlers;
// qa/local-http-check.py checks real servers).
import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import type pg from 'pg';
import { ROW_CAPS, RowCapError } from '../../src/lib/caps';
import { type Db, isDbError } from '../../src/lib/db';
import { memberByToken } from '../../src/lib/identity';
import { makeNewLink } from '../../src/lib/people';
import { readSettings, type Settings } from '../../src/lib/settings';
import { cancelSignup, claim, type ClaimInput, type ClaimResult } from '../../src/lib/signups';
import { firstLinkToken, newRequestId, newToken, requestHash, tokenHash } from '../../src/lib/tokens';
import { poolFor, waitFor } from '../support/fixtures';
import {
  assertCountsConsistent,
  changedCopy,
  count,
  dayFromToday,
  FAIL_HOOK,
  member,
  organizer,
  personWithLink,
  roster,
  sheetWithSlots
} from '../support/core';
import { type Cluster, startCluster } from '../support/postgres';

let cluster: Cluster;
let url: string;
let pools: pg.Pool[];
let pool: pg.Pool;
let settings: Settings;

before(async () => {
  cluster = await startCluster();
  url = await cluster.createDatabase({ migrated: true });
  pools = [poolFor(url), poolFor(url), poolFor(url)];
  pool = pools[0]!;
  settings = readSettings({ DATABASE_URL: url });
});

afterEach(async () => assertCountsConsistent(pool));

after(async () => {
  await Promise.all((pools ?? []).map((each) => each.end()));
  await cluster?.stop();
});

function newClaim(slug: string, slotId: string, name: string, extra: Partial<ClaimInput> = {}): ClaimInput {
  return { slug, slotId, requestId: newRequestId(), who: { kind: 'new', name, contact: '' }, note: '', rules: 'member', ...extra };
}

type SignedUp = Extract<ClaimResult, { kind: 'signed-up' }>;

function signedUp(result: ClaimResult): SignedUp {
  assert.equal(result.kind, 'signed-up', JSON.stringify(result));
  return result as SignedUp;
}

test('a new member gets a private link derived from the form and their id; only hashes are stored', async () => {
  const { slotIds } = await sheetWithSlots(pool, { slug: 'first', capacities: [1] });
  const input = newClaim('first', slotIds[0]!, 'The Mike family', { who: { kind: 'new', name: 'The Mike family', contact: 'mike-family@example.test' }, note: 'Oranges' });
  const result = signedUp(await claim(pool, settings, input, member()));
  assert.equal(result.status, 'confirmed');
  assert.equal(result.replay, false);
  const found = await memberByToken(pool, result.token);
  assert.equal(found?.name, 'The Mike family');
  assert.equal(result.token, firstLinkToken(settings, input.requestId, found!.id));
  const dump = JSON.stringify((await pool.query('select to_jsonb(p) as r from people p union all select to_jsonb(g) from signups g')).rows);
  assert.ok(!dump.includes(result.token!) && !dump.includes(input.requestId), 'no link and no request id in any stored row');
  assert.deepEqual(await roster(pool, slotIds[0]!), { confirmed: ['The Mike family'], waiting: [] });
});

test('the same form again, one after another and five at once from three processes: one sign-up, one person, one link', async () => {
  const { slotIds } = await sheetWithSlots(pool, { slug: 'replay', capacities: [1, 1] });
  const people = await count(pool, 'select count(*) from people');

  const input = newClaim('replay', slotIds[0]!, 'Frank');
  const first = signedUp(await claim(pool, settings, input, member()));
  const again = signedUp(await claim(pools[1]!, settings, input, member()));
  assert.deepEqual({ ...again, replay: false }, first);
  assert.equal(again.replay, true);

  const parallel = newClaim('replay', slotIds[1]!, 'Mike');
  const results = (await Promise.all(Array.from({ length: 5 }, (_, i) => claim(pools[i % 3]!, settings, parallel, member())))).map(signedUp);
  assert.equal(results.filter((result) => !result.replay).length, 1, 'exactly one made the sign-up');
  assert.equal(new Set(results.map((result) => `${result.signupId}:${result.token}`)).size, 1, 'every answer has the same sign-up and link');
  assert.equal(await count(pool, 'select count(*) from people'), people + 2);
  assert.equal(await count(pool, 'select count(*) from signups where slot_id = any($1::bigint[])', [slotIds]), 2);
});

test('the same form with other words, or for another place, is refused (409) and hands over no link', async () => {
  const { slotIds } = await sheetWithSlots(pool, { slug: 'reused', capacities: [2, 2] });
  const input = newClaim('reused', slotIds[0]!, 'Frank', { note: 'Juice' });
  signedUp(await claim(pool, settings, input, member()));
  const people = await count(pool, 'select count(*) from people');
  const attempts: ClaimInput[] = [
    { ...input, who: { kind: 'new', name: 'Mike', contact: '' } },
    { ...input, who: { kind: 'new', name: 'Frank', contact: 'frank@example.test' } },
    { ...input, note: 'Water' },
    { ...input, slotId: slotIds[1]! }
  ];
  for (const attempt of attempts) assert.deepEqual(await claim(pool, settings, attempt, member()), { kind: 'reused' });
  assert.equal(await count(pool, 'select count(*) from people'), people, 'no new person');
  assert.deepEqual(await roster(pool, slotIds[1]!), { confirmed: [], waiting: [] });
});

test('one form sent for two places at the same instant (10 rounds): one sign-up, the other refused, never a second link', async () => {
  for (let round = 0; round < 10; round += 1) {
    const { slotIds } = await sheetWithSlots(pool, { slug: `twice-${round}`, capacities: [1, 1] });
    const people = await count(pool, 'select count(*) from people');
    const input = newClaim(`twice-${round}`, slotIds[0]!, 'Frank');
    const results = await Promise.all([
      claim(pools[0]!, settings, input, member()),
      claim(pools[1]!, settings, { ...input, slotId: slotIds[1]! }, member())
    ]);
    assert.deepEqual(results.map((result) => result.kind).sort(), ['reused', 'signed-up']);
    assert.equal(await count(pool, 'select count(*) from people'), people + 1);
    assert.equal(await count(pool, 'select count(*) from signups where slot_id = any($1::bigint[])', [slotIds]), 1);
  }
});

test('a form whose request id another place is using right now waits for it, then is refused (the unique-index path)', async () => {
  const { slotIds } = await sheetWithSlots(pool, { slug: 'held-rid', capacities: [1, 1] });
  const input = newClaim('held-rid', slotIds[1]!, 'Mike');
  const other = await personWithLink(pool, 'Frank');
  const people = await count(pool, 'select count(*) from people');
  const first = await pool.connect();
  try {
    // Another claim with the same request id has inserted its sign-up on the first slot and not committed yet.
    await first.query('begin');
    await first.query("insert into signups (slot_id, person_id, status, added_by, request_hash) values ($1, $2, 'confirmed', 'member', $3)", [
      slotIds[0],
      other.id,
      requestHash(input.requestId)
    ]);
    const second = claim(pools[1]!, settings, input, member());
    await waitFor(
      async () => (await count(pool, "select count(*) from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()")) > 0,
      'the second claim to wait on the request id'
    );
    await first.query('commit');
    assert.deepEqual(await second, { kind: 'reused' });
  } finally {
    first.release();
  }
  assert.equal(await count(pool, 'select count(*) from people'), people, "the second claim's new person was rolled back");
  assert.deepEqual(await roster(pool, slotIds[1]!), { confirmed: [], waiting: [] });
});

test('a typed name never merges with a person who has it: a new person with their own link, and the other is untouched', async () => {
  const { slotIds } = await sheetWithSlots(pool, { slug: 'same-name', capacities: [3] });
  const mikeFamily = await personWithLink(pool, 'The Mike family', 'mike-family@example.test');
  const result = signedUp(await claim(pool, settings, newClaim('same-name', slotIds[0]!, 'The Mike family'), member()));
  const made = await memberByToken(pool, result.token);
  assert.notEqual(made?.id, mikeFamily.id);
  assert.deepEqual(await memberByToken(pool, mikeFamily.token), { id: mikeFamily.id, name: 'The Mike family' });
  const { rows } = await pool.query<{ contact: string }>('select contact from people where id = $1', [mikeFamily.id]);
  assert.equal(rows[0]?.contact, 'mike-family@example.test');
});

test('as=me signs up the remembered person; its replay needs that same person; a replaced link stops it', async () => {
  const { slotIds } = await sheetWithSlots(pool, { slug: 'as-me', capacities: [2, 2, 2] });
  const mike = await personWithLink(pool, 'Mike', 'mike@example.test');
  const frank = await personWithLink(pool, 'Frank');
  const input: ClaimInput = { slug: 'as-me', slotId: slotIds[0]!, requestId: newRequestId(), who: { kind: 'me', auth: mike.auth, contact: '' }, note: '', rules: 'member' };
  const first = signedUp(await claim(pool, settings, input, member()));
  assert.equal(first.token, null, 'no new link for a remembered person');
  assert.deepEqual(await roster(pool, slotIds[0]!), { confirmed: ['Mike'], waiting: [] });

  assert.deepEqual(await claim(pool, settings, { ...input, who: { kind: 'me', auth: frank.auth, contact: '' } }, member()), { kind: 'reused' });
  assert.equal(signedUp(await claim(pool, settings, input, member())).signupId, first.signupId);
  // A new form for a place they already hold answers with that sign-up.
  const held = signedUp(await claim(pool, settings, { ...input, requestId: newRequestId() }, member()));
  assert.equal(held.signupId, first.signupId);

  // A contact typed on the remembered form replaces theirs; a name is never taken from the form.
  signedUp(await claim(pool, settings, { ...input, slotId: slotIds[1]!, requestId: newRequestId(), who: { kind: 'me', auth: mike.auth, contact: 'mike@new.example' } }, member()));
  const { rows } = await pool.query<{ contact: string }>('select contact from people where id = $1', [mike.id]);
  assert.equal(rows[0]?.contact, 'mike@new.example');

  await makeNewLink(pool, { personId: mike.id }, organizer());
  const stale = await claim(pool, settings, { ...input, slotId: slotIds[2]!, requestId: newRequestId() }, member());
  assert.deepEqual(stale, { kind: 'refused', reason: 'who', slug: 'as-me' });
  assert.deepEqual(await roster(pool, slotIds[2]!), { confirmed: [], waiting: [] });
});

test('a repeated form after its link was replaced says "signed up" and shows no link; the old link stays dead', async () => {
  const { slotIds } = await sheetWithSlots(pool, { slug: 'replaced', capacities: [1] });
  const input = newClaim('replaced', slotIds[0]!, 'Frank');
  const first = signedUp(await claim(pool, settings, input, member()));
  const person = await memberByToken(pool, first.token);
  await makeNewLink(pool, { personId: person!.id }, organizer());
  assert.deepEqual(await claim(pool, settings, input, member()), { kind: 'link-replaced', slug: 'replaced' });
  assert.equal(await memberByToken(pool, first.token), null);
});

test('a form sent again after its sign-up was cancelled never brings a replaced link back', async () => {
  const { slotIds } = await sheetWithSlots(pool, { slug: 'resurrect', capacities: [1] });
  const input = newClaim('resurrect', slotIds[0]!, 'Frank');
  const first = signedUp(await claim(pool, settings, input, member()));
  const person = (await memberByToken(pool, first.token))!;
  const replaced = await makeNewLink(pool, { personId: person.id }, organizer());
  assert.equal(replaced.kind, 'made');
  const token = (replaced as { token: string }).token;
  const cancelled = await cancelSignup(pool, { signupId: first.signupId, owner: { personId: person.id, tokenHash: tokenHash(token) } }, member());
  assert.equal(cancelled.kind, 'cancelled');

  const again = signedUp(await claim(pool, settings, input, member()));
  assert.equal(again.replay, false);
  assert.ok(again.token && again.token !== first.token && again.token !== token);
  assert.notEqual((await memberByToken(pool, again.token))?.id, person.id, 'a new person');
  assert.equal(await memberByToken(pool, first.token), null, 'the replaced first link still opens nothing');
});

test('a link replaced while a repeated form is answered: the answer is either before the new link, or shows none', async () => {
  const { slotIds } = await sheetWithSlots(pool, { slug: 'racing-link', capacities: [2] });
  for (const outcome of ['commit', 'rollback'] as const) {
    const input = newClaim('racing-link', slotIds[0]!, `Frank ${outcome}`);
    const first = signedUp(await claim(pool, settings, input, member()));
    const person = (await memberByToken(pool, first.token))!;
    const rotation = await pool.connect();
    try {
      await rotation.query('begin');
      await rotation.query('update people set token_hash = $1 where id = $2', [tokenHash(newToken()), person.id]);
      const replay = claim(pools[1]!, settings, input, member());
      await waitFor(
        async () => (await count(pool, "select count(*) from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()")) > 0,
        'the replay to wait for the new link'
      );
      await rotation.query(outcome);
      const result = await replay;
      if (outcome === 'commit') assert.deepEqual(result, { kind: 'link-replaced', slug: 'racing-link' });
      else assert.equal(signedUp(result).token, first.token, 'control: with no new link, the replay shows the same link');
    } finally {
      rotation.release();
    }
  }
});

test('the last place: ten claims at once on capacity 1 (3 rounds), six on capacity 2; the waitlist keeps arrival order', async () => {
  for (const [round, capacity, claimers] of [
    [0, 1, 10],
    [1, 1, 10],
    [2, 1, 10],
    [3, 2, 6]
  ] as const) {
    const slug = `race-${round}`;
    const { slotIds } = await sheetWithSlots(pool, { slug, capacities: [capacity] });
    const slotId = slotIds[0]!;
    const results = (
      await Promise.all(Array.from({ length: claimers }, (_, i) => claim(pools[i % 3]!, settings, newClaim(slug, slotId, `Claimer ${i}`), member())))
    ).map(signedUp);
    assert.equal(results.filter((result) => result.status === 'confirmed').length, capacity);
    const waiting = results.filter((result) => result.status === 'waiting');
    assert.equal(waiting.length, claimers - capacity);
    assert.deepEqual(waiting.map((result) => result.position).sort((a, b) => a! - b!), Array.from({ length: claimers - capacity }, (_, i) => i + 1));
    // Each waiting answer's number is its place in (queued_at, id) order.
    const order = await pool.query<{ id: string }>("select id from signups where slot_id = $1 and status = 'waiting' order by queued_at, id", [slotId]);
    for (const result of waiting) assert.equal(order.rows.findIndex((row) => row.id === result.signupId) + 1, result.position);
    const { rows } = await pool.query<{ confirmed_count: number }>('select confirmed_count from slots where id = $1', [slotId]);
    assert.equal(rows[0]?.confirmed_count, capacity);
  }
});

test('people already waiting take a free place before a newcomer, earliest first', async () => {
  const { slotIds } = await sheetWithSlots(pool, { slug: 'fifo', capacities: [2] });
  const slotId = slotIds[0]!;
  // A free place beside a waitlist (as a past or cancelled date can leave one); the next claim fills it from the queue.
  for (const [name, status] of [['Mike', 'confirmed'], ['W1', 'waiting'], ['W2', 'waiting']] as const) {
    const person = await personWithLink(pool, name);
    await pool.query("insert into signups (slot_id, person_id, status, added_by) values ($1, $2, $3, 'member')", [slotId, person.id, status]);
  }
  const newcomer = signedUp(await claim(pool, settings, newClaim('fifo', slotId, 'Newcomer'), member()));
  assert.equal(newcomer.status, 'waiting');
  assert.equal(newcomer.position, 2);
  assert.deepEqual(await roster(pool, slotId), { confirmed: ['Mike', 'W1'], waiting: ['W2', 'Newcomer'] });
  assert.equal(await count(pool, "select count(*) from signups g join people p on p.id = g.person_id where p.name = 'W1' and g.promoted_at is not null"), 1);
});

test('refusals write nothing: a closed sheet, a cancelled date, a started date, a required note, another sheet; the organizer may add to any status', async () => {
  const closed = await sheetWithSlots(pool, { slug: 'closed', capacities: [1], status: 'closed' });
  const cancelled = await sheetWithSlots(pool, { slug: 'called-off', capacities: [1] });
  await pool.query('update dates set cancelled_at = now() where id = $1', [cancelled.dateId]);
  const started = await sheetWithSlots(pool, { slug: 'started', capacities: [1], onDate: dayFromToday(-1) });
  const noted = await sheetWithSlots(pool, { slug: 'noted', capacities: [1], noteRequired: true });
  const before = { people: await count(pool, 'select count(*) from people'), activity: await count(pool, 'select count(*) from activity') };

  const refusals: [ClaimInput, string][] = [
    [newClaim('closed', closed.slotIds[0]!, 'A'), 'closed'],
    [newClaim('called-off', cancelled.slotIds[0]!, 'B'), 'cancelled'],
    [newClaim('started', started.slotIds[0]!, 'C'), 'past'],
    [newClaim('noted', noted.slotIds[0]!, 'D'), 'note'],
    [newClaim('noted', closed.slotIds[0]!, 'E'), 'gone']
  ];
  for (const [input, reason] of refusals) {
    const result = await claim(pool, settings, input, member());
    assert.equal(result.kind === 'refused' && result.reason, reason);
  }
  assert.equal(await count(pool, 'select count(*) from people'), before.people);
  assert.equal(await count(pool, 'select count(*) from activity'), before.activity);

  const added = signedUp(
    await claim(pool, settings, { slug: null, slotId: closed.slotIds[0]!, requestId: newRequestId(), who: { kind: 'organizer-new', name: 'Mike', contact: '' }, note: '', rules: 'organizer' }, organizer())
  );
  assert.equal(added.token, null, "the organizer's new person has no link yet");
  signedUp(await claim(pool, settings, newClaim('noted', noted.slotIds[0]!, 'Frank', { note: 'Bringing oranges' }), member()));
});

test('a deadlock or the capacity backstop runs a claim once more from BEGIN, never twice; a request id another place holds is 409 at once', async () => {
  // A copy whose every attempt first runs the statement the test gives it: a real server error with that SQLSTATE.
  const start = 'async function claimOnce(tx: Db, settings: Settings, input: ClaimInput, hash: Buffer, ctx: WriteContext): Promise<ClaimResult> {';
  const copy = changedCopy([{ file: 'src/lib/signups.ts', from: start, to: `${start}\n  await (globalThis as any).${FAIL_HOOK}?.(tx);` }]);
  const hooks = globalThis as Record<string, unknown>;
  try {
    const { claim: claimInCopy } = await copy.load<typeof import('../../src/lib/signups')>('src/lib/signups.ts');
    const { slotIds } = await sheetWithSlots(pool, { slug: 'retry-budget', capacities: [10] });
    const raise = (state: string, constraint?: string) =>
      `do $$ begin raise exception 'forced by the test' using errcode = '${state}'${constraint ? `, constraint = '${constraint}'` : ''}; end $$`;
    const attempt = async (failures: string[]) => {
      let attempts = 0;
      hooks[FAIL_HOOK] = async (tx: Db) => {
        const failure = failures[attempts];
        attempts += 1;
        if (failure) await tx.query(failure);
      };
      const result = await claimInCopy(pool, settings, newClaim('retry-budget', slotIds[0]!, 'Retried'), member()).catch((error: unknown) => error);
      return { attempts, result };
    };

    for (const [state, constraint] of [['40P01', undefined], ['23514', 'slots_within_capacity']] as const) {
      const always = await attempt([raise(state, constraint), raise(state, constraint), raise(state, constraint)]);
      assert.equal(always.attempts, 2, `${state}: one retry from BEGIN, no more`);
      assert.ok(isDbError(always.result, state, constraint), String(always.result));
      const once = await attempt([raise(state, constraint)]);
      assert.equal(once.attempts, 2);
      assert.equal(signedUp(once.result as ClaimResult).status, 'confirmed', `${state}: the retry signs the person up`);
    }
    const otherCheck = await attempt([raise('23514', 'some_other_check')]);
    assert.equal(otherCheck.attempts, 1, 'another CHECK is not retried');
    const taken = await attempt([raise('23505', 'signups_request_hash_key')]);
    assert.equal(taken.attempts, 1, 'a request id another place holds: no retry');
    assert.deepEqual(taken.result, { kind: 'reused' });
  } finally {
    delete hooks[FAIL_HOOK];
    copy.remove();
  }
});

test('the organizer adds a roster person once, however often the form is sent; a person deleted meanwhile is refused', async () => {
  const { slotIds } = await sheetWithSlots(pool, { slug: 'roster', capacities: [2], status: 'draft' });
  const mikeFamily = await personWithLink(pool, 'The Mike family');
  const input: ClaimInput = { slug: null, slotId: slotIds[0]!, requestId: newRequestId(), who: { kind: 'person', personId: mikeFamily.id }, note: '', rules: 'organizer' };
  const results = (await Promise.all([claim(pools[0]!, settings, input, organizer()), claim(pools[1]!, settings, input, organizer())])).map(signedUp);
  assert.equal(results[0]!.signupId, results[1]!.signupId);
  const gone = await personWithLink(pool, 'Gone');
  await pool.query('delete from people where id = $1', [gone.id]);
  const refused = await claim(pool, settings, { ...input, requestId: newRequestId(), who: { kind: 'person', personId: gone.id } }, organizer());
  assert.deepEqual(refused, { kind: 'refused', reason: 'person', slug: 'roster' });
});

test('G4: the activity row commits with the claim: refused at the row cap, nothing at all is written', async () => {
  const capped = await cluster.createDatabase({ migrated: true });
  const capPool = poolFor(capped);
  try {
    const { slotIds } = await sheetWithSlots(capPool, { slug: 'capped', capacities: [5] });
    await capPool.query("insert into people (name, added_by) select 'Person ' || g, 'import' from generate_series(1, $1::int) g", [ROW_CAPS.people]);
    const capSettings = readSettings({ DATABASE_URL: capped });
    await assert.rejects(claim(capPool, capSettings, newClaim('capped', slotIds[0]!, 'Over'), member()), (error) => error instanceof RowCapError);
    assert.equal(await count(capPool, 'select count(*) from people'), ROW_CAPS.people);
    assert.equal(await count(capPool, 'select count(*) from signups'), 0);
    assert.equal(await count(capPool, 'select count(*) from activity'), 0);

    await capPool.query("delete from people where name = 'Person 1'");
    signedUp(await claim(capPool, capSettings, newClaim('capped', slotIds[0]!, 'Fits'), member()));
    const { rows } = await capPool.query<{ actor: string; kind: string; browser: string }>('select actor, kind, browser from activity');
    assert.deepEqual(rows, [{ actor: 'member', kind: 'claim', browser: member().browser }]);
    await assertCountsConsistent(capPool);
  } finally {
    await capPool.end();
  }
});
