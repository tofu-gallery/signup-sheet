// db.ts against a real database: SET LOCAL only, rollback and destroy on failure, restarts, and what each failure
// answers. Every busy or unavailable error here is a real one, not a constructed object.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { connectionSettings } from '../../scripts/tofu-database.mjs';
import { RowCapError } from '../../src/lib/caps';
import { createPool, dbFailure, inTransaction, isDbError, POOL_SETTINGS, Restart, StillBusy } from '../../src/lib/db';
import { logFailure } from '../../src/lib/log';
import { RequestRefused } from '../../src/lib/request';
import { failureResponse } from '../../src/lib/responses';
import { words } from '../../src/words';
import { poolFor, seedPerson, seedSheet, seedSignup, seedSlot } from '../support/fixtures';
import { type Cluster, startCluster } from '../support/postgres';

let cluster: Cluster;
let url: string;
let pool: pg.Pool;

before(async () => {
  cluster = await startCluster();
  url = await cluster.createDatabase({ migrated: true });
  pool = poolFor(url);
});

after(async () => {
  await pool?.end();
  await cluster?.stop();
});

async function capture(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  try {
    await run();
  } finally {
    console.error = original;
  }
  return lines;
}

test('the pool has the settings Tofu needs', () => {
  assert.deepEqual(POOL_SETTINGS, { max: 3, idleTimeoutMillis: 5000, connectionTimeoutMillis: 10000, query_timeout: 15000, allowExitOnIdle: true });
  assert.equal(pool.options.max, 3);
});

test('a transaction sets its timeouts with SET LOCAL only: the connection is back to its defaults after it', async () => {
  const single = new pg.Pool({ ...connectionSettings({ DATABASE_URL: url }), max: 1 });
  try {
    const inside = await inTransaction(single, async (tx) => {
      const { rows } = await tx.query<{ lock: string; statement: string }>(
        "select current_setting('lock_timeout') as lock, current_setting('statement_timeout') as statement"
      );
      return rows[0];
    });
    assert.deepEqual(inside, { lock: '5s', statement: '10s' });
    const { rows } = await single.query<{ lock: string }>("select current_setting('lock_timeout') as lock");
    assert.equal(rows[0]?.lock, '0');
  } finally {
    await single.end();
  }
});

test('a failed transaction rolls back and its client is destroyed, not returned to the pool', async () => {
  const single = new pg.Pool({ ...connectionSettings({ DATABASE_URL: url }), max: 1 });
  try {
    const pidBefore = (await single.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]?.pid;
    await assert.rejects(
      inTransaction(single, async (tx) => {
        await tx.query("insert into people (name, added_by) values ('Rolled back', 'member')");
        throw new Error('the write failed');
      })
    );
    const pidAfter = (await single.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]?.pid;
    assert.notEqual(pidAfter, pidBefore, 'a new connection');
    const { rows } = await single.query("select 1 from people where name = 'Rolled back'");
    assert.equal(rows.length, 0);
  } finally {
    await single.end();
  }
});

test('Restart runs the work again from BEGIN, up to its attempts; then the busy answer', async () => {
  let runs = 0;
  const value = await inTransaction(
    pool,
    async () => {
      runs += 1;
      if (runs < 3) throw new Restart();
      return 'done';
    },
    { attempts: 3 }
  );
  assert.equal(value, 'done');
  runs = 0;
  const error = await inTransaction(pool, async () => {
    runs += 1;
    throw new Restart();
  }, { attempts: 3 }).catch((caught: unknown) => caught);
  assert.equal(runs, 3);
  assert.ok(error instanceof StillBusy);
  assert.equal(dbFailure(error), 'busy');
});

test('a claim that hits the capacity backstop runs once more from BEGIN with retryWhen', async () => {
  const sheet = await seedSheet(pool, 'retry');
  const { slotId } = await seedSlot(pool, sheet);
  await seedSignup(pool, slotId, await seedPerson(pool, 'Mike'), 'confirmed');
  const frank = await seedPerson(pool, 'Frank');
  let attempt = 0;
  const status = await inTransaction(
    pool,
    async (tx) => {
      attempt += 1;
      // The first attempt acts on a stale count; the second sees the slot full and joins the waitlist.
      const next = attempt === 1 ? 'confirmed' : 'waiting';
      await tx.query("insert into signups (slot_id, person_id, status, added_by) values ($1, $2, $3, 'member')", [slotId, frank, next]);
      return next;
    },
    { attempts: 2, retryWhen: (error) => isDbError(error, '23514', 'slots_within_capacity') }
  );
  assert.equal(status, 'waiting');
  assert.equal(attempt, 2);
});

test('real failures are classified: lock and statement timeouts are busy; a lost reply or no server is unavailable', async () => {
  const sheet = await seedSheet(pool, 'busy');
  const { slotId } = await seedSlot(pool, sheet);
  const holder = await pool.connect();
  await holder.query('begin');
  await holder.query('select id from slots where id = $1 for update', [slotId]);
  try {
    const lockTimeout = await inTransaction(pool, async (tx) => {
      await tx.query("set local lock_timeout = '100ms'");
      await tx.query('select id from slots where id = $1 for update', [slotId]);
    }).catch((error: unknown) => error);
    assert.ok(isDbError(lockTimeout, '55P03'));
    assert.equal(dbFailure(lockTimeout), 'busy');
  } finally {
    await holder.query('rollback');
    holder.release();
  }

  const statementTimeout = await inTransaction(pool, async (tx) => {
    await tx.query("set local statement_timeout = '50ms'");
    await tx.query('select pg_sleep(1)');
  }).catch((error: unknown) => error);
  assert.ok(isDbError(statementTimeout, '57014'));
  assert.equal(dbFailure(statementTimeout), 'busy');

  const impatient = new pg.Pool({ ...connectionSettings({ DATABASE_URL: url }), max: 1, query_timeout: 200 });
  try {
    const lostReply = await impatient.query('select pg_sleep(2)').catch((error: unknown) => error);
    assert.equal(dbFailure(lostReply), 'unavailable');
  } finally {
    await impatient.end();
  }

  const nowhere = createPool({ DATABASE_URL: 'postgresql://app_owner@127.0.0.1:1/none' });
  try {
    const refused = await nowhere.query('select 1').catch((error: unknown) => error);
    assert.equal(dbFailure(refused), 'unavailable');
  } finally {
    await nowhere.end();
  }

  const duplicate = await pool.query("insert into sheets (slug, title) values ('busy', 'Again')").catch((error: unknown) => error);
  assert.ok(isDbError(duplicate, '23505'));
  assert.equal(dbFailure(duplicate), 'error');
});

test('the log gets the SQLSTATE and constraint only, never the values in the error message', async () => {
  const probe = 'PRIVATE-PROBE-4815 mike-family@example.test';
  const failure = await pool.query('select $1::int', [probe]).catch((error: unknown) => error);
  assert.ok(String((failure as Error).message).includes('PRIVATE-PROBE'), 'control: the message itself does carry the value');
  const lines = await capture(async () => logFailure('claim', failure));
  assert.deepEqual(lines, ['[signup-sheet] claim: database error 22P02']);

  const duplicate = await pool.query("insert into people (name, token_hash, added_by) values ('x', $1, 'member'), ('y', $1, 'member')", [Buffer.alloc(32, 1)]).catch((error: unknown) => error);
  const more = await capture(async () => logFailure('new link', duplicate));
  assert.deepEqual(more, ['[signup-sheet] new link: database error 23505 on people_token_hash_key']);
});

test('each failure gets its answer, and nothing from the error reaches the page', async () => {
  const lines = await capture(async () => {
    const busy = failureResponse('claim', new StillBusy());
    assert.equal(busy.status, 503);
    assert.ok((await busy.text()).includes(words.busy));
    const unavailable = failureResponse('claim', Object.assign(new Error('connect ECONNREFUSED'), { syscall: 'connect', code: 'ECONNREFUSED' }));
    assert.equal(unavailable.status, 503);
    assert.ok((await unavailable.text()).includes(words.waking));
    const failed = failureResponse('claim', await pool.query('select $1::int', ['PRIVATE-PROBE-9']).catch((error: unknown) => error));
    assert.equal(failed.status, 500);
    assert.ok(!(await failed.text()).includes('PROBE'));
    assert.equal(failureResponse('claim', new RowCapError('people')).status, 409);
    assert.equal(failureResponse('claim', new RequestRefused(413)).status, 413);
  });
  assert.ok(lines.every((line) => !line.includes('PROBE')));
});
