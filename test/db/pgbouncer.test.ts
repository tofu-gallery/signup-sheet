// The same races and access rules through PgBouncer in transaction mode with max_prepared_statements = 0, as Tofu's
// pooler runs: consecutive transactions of one client may land on different server connections. Direct PostgreSQL
// cannot show that the app keeps nothing on a session; this file does.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { organizerAccess, organizerFromCookie, type SeatTaken, takeSeat } from '../../src/lib/access';
import { checkCapsForClaim, ROW_CAPS, RowCapError } from '../../src/lib/caps';
import { inTransaction, Restart } from '../../src/lib/db';
import { lockSheetsOfSlots, lockSlots, promoteWaiting } from '../../src/lib/locks';
import { overLimit } from '../../src/lib/throttle';
import { readSettings } from '../../src/lib/settings';
import { barrier, countMismatches, poolFor, seedPerson, seedSheet, seedSignup, seedSlot, waitFor } from '../support/fixtures';
import {
  type Bouncer,
  type Cluster,
  holdMigrationLock,
  lockWaiters,
  runMigrate,
  startCluster,
  startPgBouncer,
  summarizeMigrations
} from '../support/postgres';

let cluster: Cluster;
let bouncer: Bouncer;
const pools: pg.Pool[] = [];

before(async () => {
  cluster = await startCluster();
  bouncer = await startPgBouncer(cluster);
});

after(async () => {
  await Promise.all(pools.map((pool) => pool.end()));
  await bouncer?.stop();
  await cluster?.stop();
});

/** A fresh copy reached through PgBouncer by `count` app processes. */
async function pooledCopy(count: number, migrated = true): Promise<{ database: string; url: string; processes: pg.Pool[] }> {
  const direct = await cluster.createDatabase({ migrated });
  const database = new URL(direct).pathname.slice(1);
  const url = bouncer.url(database);
  const processes = Array.from({ length: count }, () => poolFor(url));
  pools.push(...processes);
  return { database, url, processes };
}

test('negative control: a named statement fails once the pooler hands its client another server connection', async () => {
  const { url } = await pooledCopy(0);
  const a = new pg.Client({ connectionString: url });
  const b = new pg.Client({ connectionString: url });
  await a.connect();
  await b.connect();
  try {
    await a.query({ name: 'probe', text: 'select 1 as one' });
    // b's open transaction now holds the one idle server connection, the one where `probe` was prepared.
    await b.query('begin');
    await b.query('select 1');
    await assert.rejects(a.query({ name: 'probe', text: 'select 1 as one' }), { code: '26000' });
    // Control: the same query unnamed works.
    assert.equal((await a.query('select 1 as one')).rows[0]?.one, 1);
  } finally {
    await b.query('rollback').catch(() => {});
    await a.end();
    await b.end();
  }
});

test('transactions keep their SET LOCAL to themselves through the pooler', async () => {
  const { processes } = await pooledCopy(3);
  await Promise.all(
    processes.map((pool) =>
      inTransaction(pool, async (tx) => {
        const { rows } = await tx.query<{ value: string }>("select current_setting('lock_timeout') as value");
        assert.equal(rows[0]?.value, '5s');
      })
    )
  );
  const after = await Promise.all(
    Array.from({ length: 12 }, (_, i) => processes[i % 3]!.query<{ value: string }>("select current_setting('lock_timeout') as value"))
  );
  assert.ok(after.every((result) => result.rows[0]?.value === '0'));
});

test('three builds through the pooler: the transaction-level lock still lets exactly one apply', async () => {
  const { database, url } = await pooledCopy(0, false);
  const holder = await holdMigrationLock(cluster, database);
  const runs = [1, 2, 3].map(() => runMigrate({ DATABASE_URL: url }));
  await waitFor(async () => (await lockWaiters(holder)) === 3, 'three waiting builds');
  await holder.query('commit');
  await holder.end();
  const summary = summarizeMigrations(await Promise.all(runs));
  assert.deepEqual(summary.exits, [0, 0, 0]);
  assert.equal(summary.applied, 1);
  assert.equal(summary.waited + summary.alreadyRecorded, 2);
  // The other builds queued for the lock before the first one applied the file, so they say they waited.
  assert.ok(summary.waited >= 1);
});

test('five app processes press Set up at once through the pooler: one seat', async () => {
  const { url, processes } = await pooledCopy(5);
  const settings = readSettings({ DATABASE_URL: url });
  const results = await Promise.all(processes.map((pool) => takeSeat(pool, settings)));
  const winners = results.filter((result): result is SeatTaken => result !== null);
  assert.equal(winners.length, 1);
  const access = await organizerAccess(processes[2]!, settings);
  assert.equal(access.state, 'held');
  assert.deepEqual(organizerFromCookie(winners[0]!.cookieValue, access, settings), { via: 'seat' });
  const retired = await organizerAccess(processes[3]!, { ...settings, organizerPassword: 'correct horse battery staple' });
  assert.equal(retired.state, 'password');
  assert.equal(organizerFromCookie(winners[0]!.cookieValue, retired, settings), null);
});

test('twelve claims near the row cap through the pooler stay within it', async () => {
  const { processes } = await pooledCopy(4);
  await processes[0]!.query(
    "insert into people (name, added_by) select 'Person ' || g, 'import' from generate_series(1, $1::int) g",
    [ROW_CAPS.people - 3]
  );
  const arrive = barrier(12);
  const outcomes = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      inTransaction(processes[i % 4]!, async (tx) => {
        try {
          await checkCapsForClaim(tx);
        } catch (error) {
          await arrive();
          throw error;
        }
        await arrive();
        await tx.query("insert into people (name, added_by) values ($1, 'member')", [`Claimer ${i}`]);
      }).then(
        () => 'added',
        (error: unknown) => (error instanceof RowCapError ? 'refused' : 'error')
      )
    )
  );
  assert.ok(!outcomes.includes('error'));
  const { rows } = await processes[0]!.query<{ n: number }>('select count(*)::int as n from people');
  assert.ok(rows[0]!.n <= ROW_CAPS.people, `${rows[0]!.n} people`);
});

test('a cancel racing a promotion through the pooler keeps the stored count right, and Restart works', async () => {
  const { processes } = await pooledCopy(2);
  const pool = processes[0]!;
  const sheet = await seedSheet(pool, 'pooled');
  const { slotId } = await seedSlot(pool, sheet, { capacity: 1 });
  const first = await seedSignup(pool, slotId, await seedPerson(pool, 'Mike'), 'confirmed');
  for (const name of ['Frank', 'W2', 'W3']) await seedSignup(pool, slotId, await seedPerson(pool, name), 'waiting');
  let restarts = 0;
  await Promise.all([
    inTransaction(
      pool,
      async (tx) => {
        await lockSheetsOfSlots(tx, [slotId], 'share');
        await lockSlots(tx, [slotId]);
        if (restarts++ === 0) throw new Restart();
        await tx.query('delete from signups where id = $1', [first]);
        await promoteWaiting(tx, slotId);
      },
      { attempts: 2 }
    ),
    inTransaction(processes[1]!, async (tx) => {
      await lockSheetsOfSlots(tx, [slotId], 'share');
      await lockSlots(tx, [slotId]);
      await promoteWaiting(tx, slotId);
    })
  ]);
  assert.deepEqual(await countMismatches(pool), []);
  const { rows } = await pool.query<{ n: number }>("select count(*)::int as n from signups where slot_id = $1 and status = 'confirmed'", [slotId]);
  assert.equal(rows[0]?.n, 1);
});

test('the throttle counts hits from several processes through the pooler', async () => {
  const { processes } = await pooledCopy(3);
  const results = await Promise.all(Array.from({ length: 9 }, (_, i) => overLimit(processes[i % 3]!, 'signin:x', { hits: 5, seconds: 900 })));
  assert.equal(results.filter(Boolean).length, 4);
});
