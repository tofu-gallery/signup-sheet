// The sign-up core's races and access rules through PgBouncer in transaction mode (max_prepared_statements = 0), as
// Tofu's pooler runs: consecutive transactions of one client can land on different server connections. Direct
// PostgreSQL runs of the same tests cannot show that nothing depends on a session; these can. Still not HTTP tests.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { takeSeat } from '../../src/lib/access';
import { inTransaction } from '../../src/lib/db';
import { lockSheetsOfSlots, lockSlots } from '../../src/lib/locks';
import { removePersonEverywhere } from '../../src/lib/people';
import { readSettings, type Settings } from '../../src/lib/settings';
import { cancelSignup, claim, type ClaimInput, changeNote, swapSignups } from '../../src/lib/signups';
import { deleteTarget, deletionPreview } from '../../src/lib/structure';
import { newRequestId, newToken, tokenHash } from '../../src/lib/tokens';
import { barrier, poolFor, waitFor } from '../support/fixtures';
import { assertCountsConsistent, cookieSet, count, formPost, member, organizer, params, personWithLink, roster, sheetWithSlots } from '../support/core';
import { removalRaceProbe } from '../support/probes';
import { type Bouncer, type Cluster, REPO, startCluster, startPgBouncer } from '../support/postgres';
import { join } from 'node:path';

let cluster: Cluster;
let bouncer: Bouncer;
let processes: pg.Pool[];
let pool: pg.Pool;
let url: string;
let settings: Settings;
const shared = globalThis as typeof globalThis & { signupSheetPool?: pg.Pool };

before(async () => {
  cluster = await startCluster();
  bouncer = await startPgBouncer(cluster);
  const direct = await cluster.createDatabase({ migrated: true });
  url = bouncer.url(new URL(direct).pathname.slice(1));
  processes = Array.from({ length: 5 }, () => poolFor(url));
  pool = processes[0]!;
  settings = readSettings({ DATABASE_URL: url });
});

after(async () => {
  await shared.signupSheetPool?.end();
  delete shared.signupSheetPool;
  await Promise.all((processes ?? []).map((each) => each.end()));
  await bouncer?.stop();
  await cluster?.stop();
});

const newClaim = (slug: string, slotId: string, name: string, requestId = newRequestId()): ClaimInput => ({
  slug,
  slotId,
  requestId,
  who: { kind: 'new', name, contact: '' },
  note: '',
  rules: 'member'
});

async function signUp(slotId: string, name: string, status: 'confirmed' | 'waiting') {
  const person = await personWithLink(pool, name);
  const { rows } = await pool.query<{ id: string }>(
    "insert into signups (slot_id, person_id, status, added_by) values ($1, $2, $3, 'member') returning id",
    [slotId, person.id, status]
  );
  return { signupId: rows[0]!.id, ...person };
}

test('one form from five processes at once, and one form for two places at once, through the pooler', async () => {
  const { slotIds } = await sheetWithSlots(pool, { slug: 'pooled-rid', capacities: [1, 1, 1] });
  const input = newClaim('pooled-rid', slotIds[0]!, 'Frank');
  const results = await Promise.all(processes.map((each) => claim(each, settings, input, member())));
  const answers = new Set(results.map((result) => (result.kind === 'signed-up' ? `${result.signupId}:${result.token}` : result.kind)));
  assert.equal(answers.size, 1, [...answers].join(' | '));
  assert.ok(![...answers][0]!.startsWith('reused'));

  const both = newClaim('pooled-rid', slotIds[1]!, 'Mike');
  const split = await Promise.all([claim(processes[1]!, settings, both, member()), claim(processes[2]!, settings, { ...both, slotId: slotIds[2]! }, member())]);
  assert.deepEqual(split.map((result) => result.kind).sort(), ['reused', 'signed-up']);
  assert.equal(await count(pool, 'select count(*) from signups where slot_id = any($1::bigint[])', [slotIds]), 2);
  await assertCountsConsistent(pool);
});

test('ten claims on the last place from five processes through the pooler (3 rounds)', async () => {
  for (let round = 0; round < 3; round += 1) {
    const slug = `pooled-last-${round}`;
    const { slotIds } = await sheetWithSlots(pool, { slug, capacities: [1] });
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => claim(processes[i % 5]!, settings, newClaim(slug, slotIds[0]!, `C${i}`), member())));
    const statuses = results.map((result) => (result.kind === 'signed-up' ? result.status : result.kind));
    assert.equal(statuses.filter((status) => status === 'confirmed').length, 1);
    assert.equal(statuses.filter((status) => status === 'waiting').length, 9);
    await assertCountsConsistent(pool);
  }
});

test('a cancel and a claim, a swap and two claims, a removal and a claim, all at once through the pooler', async () => {
  for (let round = 0; round < 5; round += 1) {
    const slug = `pooled-mix-${round}`;
    const { slotIds } = await sheetWithSlots(pool, { slug, capacities: [1, 1, 2] });
    const [x, y, z] = slotIds as [string, string, string];
    const a = await signUp(x, 'A', 'confirmed');
    const w = await signUp(x, 'WX', 'waiting');
    const b = await signUp(y, 'B', 'confirmed');
    const c = await signUp(z, 'C', 'confirmed');
    const ready = barrier(5);
    const results = await Promise.allSettled([
      ready().then(() => swapSignups(processes[0]!, { a: a.signupId, b: b.signupId }, organizer())),
      ready().then(() => claim(processes[1]!, settings, newClaim(slug, x, 'NX'), member())),
      ready().then(() => claim(processes[2]!, settings, newClaim(slug, y, 'NY'), member())),
      ready().then(() => removePersonEverywhere(processes[3]!, c.id, organizer())),
      ready().then(() => cancelSignup(processes[4]!, { signupId: w.signupId, owner: w.auth }, member()))
    ]);
    for (const result of results) assert.equal(result.status, 'fulfilled', String((result as PromiseRejectedResult).reason));
    assert.deepEqual((await roster(pool, x)).confirmed, ['B']);
    assert.deepEqual((await roster(pool, y)).confirmed, ['A']);
    assert.deepEqual(await roster(pool, z), { confirmed: [], waiting: [] });
    await assertCountsConsistent(pool);
  }
});

test("G6 and a replaced link through the pooler: another's sign-up finds nothing; a link replaced mid-write changes nothing", async () => {
  const { slotIds } = await sheetWithSlots(pool, { slug: 'pooled-owner', capacities: [2] });
  const a = await signUp(slotIds[0]!, 'A', 'confirmed');
  const b = await signUp(slotIds[0]!, 'B', 'confirmed');
  assert.deepEqual(await cancelSignup(processes[1]!, { signupId: b.signupId, owner: a.auth }, member()), { kind: 'missing' });
  assert.deepEqual(await changeNote(processes[2]!, { signupId: b.signupId, owner: a.auth, note: 'x' }, member()), { kind: 'missing' });

  const rotation = await pool.connect();
  try {
    await rotation.query('begin');
    await rotation.query('update people set token_hash = $1 where id = $2', [tokenHash(newToken()), a.id]);
    const cancel = cancelSignup(processes[3]!, { signupId: a.signupId, owner: a.auth }, member());
    await waitFor(async () => (await count(processes[4]!, "select count(*) from pg_stat_activity where wait_event_type = 'Lock'")) > 0, 'the cancel to wait');
    await rotation.query('commit');
    assert.deepEqual(await cancel, { kind: 'missing' });
  } finally {
    rotation.release();
  }
  assert.deepEqual(await roster(pool, slotIds[0]!), { confirmed: ['A', 'B'], waiting: [] });
});

test('W11 and a member write it does not hold, lined up by pauses, through the pooler: no deadlock, nothing half removed', async () => {
  await removalRaceProbe(url);
});

test('a delete whose list changed while a claim was in flight deletes nothing, through the pooler', async () => {
  const { slotIds } = await sheetWithSlots(pool, { slug: 'pooled-delete', capacities: [2] });
  const preview = (await deletionPreview(pool, { kind: 'slot', id: slotIds[0]! }))!;
  const person = await personWithLink(pool, 'Late');
  const inFlight = await pool.connect();
  try {
    await inFlight.query('begin');
    await lockSheetsOfSlots(inFlight, [slotIds[0]!], 'share');
    await lockSlots(inFlight, [slotIds[0]!]);
    await inFlight.query("insert into signups (slot_id, person_id, status, added_by) values ($1, $2, 'confirmed', 'member')", [slotIds[0], person.id]);
    const deletion = deleteTarget(processes[1]!, { target: { kind: 'slot', id: slotIds[0]! }, seen: preview.seen }, organizer());
    await waitFor(async () => (await count(processes[2]!, "select count(*) from pg_stat_activity where wait_event_type = 'Lock'")) > 0, 'the delete to wait');
    await inFlight.query('commit');
    assert.equal((await deletion).kind, 'changed');
  } finally {
    inFlight.release();
  }
  assert.equal(await count(pool, 'select count(*) from slots where id = $1', [slotIds[0]]), 1);
});

test('the claim and organizer route handlers through the pooler: one form five times at once, and the organizer check', async () => {
  await shared.signupSheetPool?.end();
  delete shared.signupSheetPool;
  process.env.DATABASE_URL = url;
  process.env.ORGANIZER_PASSWORD = '';
  const { slotIds } = await sheetWithSlots(pool, { slug: 'pooled-route', capacities: [1] });
  const { POST: claimRoute } = (await import(join(REPO, 'src/app/s/[slug]/slots/[id]/claim/route.ts'))) as {
    POST: (request: Request, context: unknown) => Promise<Response>;
  };
  const fields = { rid: newRequestId(), name: 'The Mike family' };
  const answers = await Promise.all(
    Array.from({ length: 5 }, () => claimRoute(formPost(`/s/pooled-route/slots/${slotIds[0]}/claim`, fields), params({ slug: 'pooled-route', id: slotIds[0]! })))
  );
  assert.equal(new Set(answers.map((answer) => `${answer.status} ${answer.headers.get('location')} ${cookieSet(answer, 'ss_me')}`)).size, 1);
  assert.equal(answers[0]!.status, 303);

  const seat = (await takeSeat(pool, settings))!;
  const { POST: remove } = (await import(join(REPO, 'src/app/organizer/signups/[id]/remove/route.ts'))) as {
    POST: (request: Request, context: unknown) => Promise<Response>;
  };
  const signupId = (await pool.query<{ id: string }>('select id from signups where slot_id = $1', [slotIds[0]])).rows[0]!.id;
  const stranger = await remove(formPost(`/organizer/signups/${signupId}/remove`, {}, { cookies: { ss_org: `seat.${newToken()}` } }), params({ id: signupId }));
  assert.equal(stranger.status, 403);
  assert.deepEqual((await roster(pool, slotIds[0]!)).confirmed, ['The Mike family']);
  const holder = await remove(formPost(`/organizer/signups/${signupId}/remove`, {}, { cookies: { ss_org: seat.cookieValue } }), params({ id: signupId }));
  assert.equal(holder.status, 303);
  assert.deepEqual(await roster(pool, slotIds[0]!), { confirmed: [], waiting: [] });
  await inTransaction(pool, async (tx) => {
    const { rows } = await tx.query<{ value: string }>("select current_setting('lock_timeout') as value");
    assert.equal(rows[0]?.value, '5s');
  });
  await assertCountsConsistent(pool);
});
