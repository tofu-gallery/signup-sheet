// The schema on a real PostgreSQL 14 that imitates a Supabase database made before 2026-10-30: anon and authenticated
// get every new table, sequence and function in public by default.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type pg from 'pg';
import { countMismatches, dayFromToday, poolFor, seedPerson, seedSheet, seedSignup, seedSlot } from '../support/fixtures';
import { type Cluster, runMigrate, startCluster } from '../support/postgres';

const TABLES = ['app_state', 'sheets', 'dates', 'slots', 'people', 'signups', 'activity', 'throttle'];
const IDENTITY_TABLES = ['sheets', 'dates', 'slots', 'people', 'signups', 'activity'];

let cluster: Cluster;
let url: string;
let database: string;
let pool: pg.Pool;

before(async () => {
  cluster = await startCluster();
  url = await cluster.createDatabase({ migrated: false });
  database = new URL(url).pathname.slice(1);
  pool = poolFor(url);
});

after(async () => {
  await pool?.end();
  await cluster?.stop();
});

test('control: the imitated old defaults do grant a new table to anon', async () => {
  await pool.query('create table public.probe (id int)');
  const [row] = await cluster.admin<{ granted: boolean }>("select has_table_privilege('anon', 'public.probe', 'select') as granted", [], database);
  assert.equal(row?.granted, true);
  await pool.query('drop table public.probe');
});

test('the migration applies once and is recorded once', async () => {
  const first = await runMigrate({ DATABASE_URL: url });
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /\[tofu-migrate\] applied 20261030000000_signup_sheet\.sql/);
  const again = await runMigrate({ DATABASE_URL: url });
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /0 applied, 1 already recorded, 1 files\./);
  const ledger = await cluster.admin<{ version: string; name: string }>('select version, name from supabase_migrations.schema_migrations', [], database);
  assert.deepEqual(ledger, [{ version: '20261030000000', name: 'signup_sheet' }]);
});

test('row-level security is on for every table, and anon and authenticated hold nothing', async () => {
  const rls = await cluster.admin<{ relname: string; relrowsecurity: boolean }>(
    "select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' order by 1",
    [],
    database
  );
  assert.deepEqual(rls.map((row) => row.relname).sort(), [...TABLES].sort());
  assert.ok(rls.every((row) => row.relrowsecurity));

  for (const role of ['anon', 'authenticated']) {
    for (const table of TABLES) {
      const [row] = await cluster.admin<{ any: boolean }>(
        "select has_table_privilege($1, $2, 'select,insert,update,delete,truncate,references,trigger') as any",
        [role, `public.${table}`],
        database
      );
      assert.equal(row?.any, false, `${role} on ${table}`);
    }
    for (const table of IDENTITY_TABLES) {
      const [row] = await cluster.admin<{ any: boolean }>(
        "select has_sequence_privilege($1, pg_get_serial_sequence($2, 'id'), 'usage,select,update') as any",
        [role, `public.${table}`],
        database
      );
      assert.equal(row?.any, false, `${role} on the ${table} sequence`);
    }
    const [revision] = await cluster.admin<{ any: boolean }>(
      "select has_sequence_privilege($1, 'public.reminder_revision', 'usage,select,update') as any",
      [role],
      database
    );
    assert.equal(revision?.any, false, `${role} on the reminder_revision sequence`);
    const [fn] = await cluster.admin<{ can: boolean }>(
      "select has_function_privilege($1, 'public.signups_keep_count()', 'execute') as can",
      [role],
      database
    );
    assert.equal(fn?.can, false, `${role} on signups_keep_count()`);
  }
  const [everyone] = await cluster.admin<{ can: boolean }>(
    "select has_function_privilege('public', 'public.signups_keep_count()', 'execute') as can",
    [],
    database
  );
  assert.equal(everyone?.can, false);
});

test('as anon a table answers 42501; with SELECT handed back by hand, row-level security still shows no row', async () => {
  await seedPerson(pool, 'The Mike family', 'mike-family@example.test');
  const client = await cluster.superClient(database);
  try {
    await client.query('begin');
    await client.query('set local role anon');
    await assert.rejects(client.query('select * from public.people'), { code: '42501' });
    await client.query('rollback');

    await client.query('grant select on all tables in schema public to anon');
    await client.query('begin');
    await client.query('set local role anon');
    const { rows } = await client.query<{ n: number }>('select count(*)::int as n from public.people');
    await client.query('rollback');
    assert.equal(rows[0]?.n, 0);
    // Control: the same query as the owner sees the row.
    const owner = await pool.query<{ n: number }>('select count(*)::int as n from people');
    assert.ok((owner.rows[0]?.n ?? 0) >= 1);
  } finally {
    await client.query('revoke select on all tables in schema public from anon').catch(() => {});
    await client.end();
  }
});

test('the count trigger is SECURITY INVOKER with an empty search_path', async () => {
  const [fn] = await cluster.admin<{ prosecdef: boolean; proconfig: string[] }>(
    "select prosecdef, proconfig from pg_proc where proname = 'signups_keep_count'",
    [],
    database
  );
  assert.equal(fn?.prosecdef, false);
  assert.ok(fn?.proconfig.some((setting) => /^search_path=("")?$/.test(setting)), String(fn?.proconfig));
});

test('the backstop: a direct confirmed insert or promotion into a full slot fails with slots_within_capacity', async () => {
  const sheet = await seedSheet(pool, 'backstop');
  const { slotId } = await seedSlot(pool, sheet, { capacity: 1 });
  const first = await seedPerson(pool, 'The Mike family');
  const second = await seedPerson(pool, 'Mike');
  await seedSignup(pool, slotId, first, 'confirmed');
  await assert.rejects(seedSignup(pool, slotId, second, 'confirmed'), { code: '23514', constraint: 'slots_within_capacity' });
  const waiting = await seedSignup(pool, slotId, second, 'waiting');
  await assert.rejects(pool.query("update signups set status = 'confirmed' where id = $1", [waiting]), {
    code: '23514',
    constraint: 'slots_within_capacity'
  });
  assert.deepEqual(await countMismatches(pool), []);
});

test('lowering a capacity below the confirmed count is refused by the database too', async () => {
  const sheet = await seedSheet(pool, 'capacity');
  const { slotId } = await seedSlot(pool, sheet, { capacity: 2 });
  await seedSignup(pool, slotId, await seedPerson(pool, 'Frank'), 'confirmed');
  await seedSignup(pool, slotId, await seedPerson(pool, 'Mike'), 'confirmed');
  await assert.rejects(pool.query('update slots set capacity = 1 where id = $1', [slotId]), { code: '23514' });
});

test('the stored count follows inserts, promotions, moves, deletes and cascades', async () => {
  const sheet = await seedSheet(pool, 'counting');
  const a = await seedSlot(pool, sheet, { capacity: 2 });
  const b = await seedSlot(pool, sheet, { capacity: 2, onDate: dayFromToday(17) });
  const people = await Promise.all(['A', 'B', 'C', 'D'].map((name) => seedPerson(pool, name)));
  const s1 = await seedSignup(pool, a.slotId, people[0]!, 'confirmed');
  await seedSignup(pool, a.slotId, people[1]!, 'confirmed');
  const s3 = await seedSignup(pool, a.slotId, people[2]!, 'waiting');
  assert.deepEqual(await countMismatches(pool), []);
  await pool.query('update signups set slot_id = $2 where id = $1', [s1, b.slotId]);
  await pool.query("update signups set status = 'confirmed' where id = $1", [s3]);
  assert.deepEqual(await countMismatches(pool), []);
  await pool.query('delete from signups where id = $1', [s3]);
  await seedSignup(pool, b.slotId, people[3]!, 'confirmed');
  assert.deepEqual(await countMismatches(pool), []);
  // Deleting a date deletes its slots and their sign-ups in one cascade.
  await pool.query('delete from dates where id = $1', [b.dateId]);
  assert.deepEqual(await countMismatches(pool), []);
  const [left] = (await pool.query<{ n: number }>('select count(*)::int as n from signups where slot_id = $1', [b.slotId])).rows;
  assert.equal(left?.n, 0);
});

test('the request hash must be 32 bytes, and app_state has exactly one row', async () => {
  const sheet = await seedSheet(pool, 'hashes');
  const { slotId } = await seedSlot(pool, sheet, { capacity: 3 });
  const person = await seedPerson(pool, 'Frank');
  await assert.rejects(
    pool.query("insert into signups (slot_id, person_id, status, added_by, request_hash) values ($1, $2, 'waiting', 'member', $3)", [
      slotId,
      person,
      Buffer.alloc(31)
    ]),
    { code: '23514' }
  );
  await assert.rejects(pool.query('insert into app_state (id) values (2)'), { code: '23514' });
  const [state] = (await pool.query<{ n: number; seat_state: string }>("select count(*)::int as n, min(seat_state) as seat_state from app_state")).rows;
  assert.deepEqual(state, { n: 1, seat_state: 'open' });
});
