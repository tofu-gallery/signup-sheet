// scripts/tofu-migrate.mjs: the build-time migration. Its concurrency is proven by holding the migration lock in the
// test first, so every build is known to be waiting before the lock is let go.
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { waitFor } from '../support/fixtures';
import {
  type Cluster,
  holdMigrationLock,
  lockWaiters,
  REPO,
  runMigrate,
  startCluster,
  summarizeMigrations
} from '../support/postgres';

const FILE = '20261030000000_signup_sheet.sql';
let cluster: Cluster;

before(async () => {
  cluster = await startCluster();
});

after(async () => {
  await cluster?.stop();
});

test('an empty DATABASE_URL applies nothing and exits 0', async () => {
  for (const value of ['', '   ']) {
    const result = await runMigrate({ DATABASE_URL: value });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '[tofu-migrate] DATABASE_URL is not set; nothing to apply.\n');
  }
});

test('a bad DATABASE_URL, or sslmode without SUPABASE_CA_CERT, stops before connecting with its sentence alone', async () => {
  const bad = await runMigrate({ DATABASE_URL: 'mysql://user:Sup3r-secret-test-only@127.0.0.1/db' });
  assert.equal(bad.code, 1);
  assert.equal(bad.stderr, '[tofu-migrate] DATABASE_URL must be a PostgreSQL URL.\n');
  // Nothing listens on port 1, so an attempt to connect would end with ECONNREFUSED instead of this sentence.
  const noCa = await runMigrate({ DATABASE_URL: 'postgresql://user:Sup3r-secret-test-only@127.0.0.1:1/db?sslmode=require' });
  assert.equal(noCa.code, 1);
  assert.equal(noCa.stderr, "[tofu-migrate] SUPABASE_CA_CERT is not set: it is needed to check the database server's certificate.\n");
  const refused = await runMigrate({ DATABASE_URL: 'postgresql://user:Sup3r-secret-test-only@127.0.0.1:1/db' });
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /^\[tofu-migrate\] failed: connect ECONNREFUSED/);
  assert.ok(!refused.stderr.includes('secret'));
});

test('three builds at once: all wait for the lock, exactly one applies the file, the ledger records it once', async () => {
  const url = await cluster.createDatabase({ migrated: false });
  const database = new URL(url).pathname.slice(1);
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
  const ledger = await cluster.admin('select version from supabase_migrations.schema_migrations', [], database);
  assert.equal(ledger.length, 1);
  console.log(`# three builds: ${summary.waited} printed that they waited, ${summary.alreadyRecorded} found the file already recorded`);
});

test("a build that waits longer than the app's 15-second reply deadline still applies (that deadline is not the script's)", { timeout: 60_000 }, async () => {
  const url = await cluster.createDatabase({ migrated: false });
  const database = new URL(url).pathname.slice(1);
  const holder = await holdMigrationLock(cluster, database);
  const run = runMigrate({ DATABASE_URL: url });
  await waitFor(async () => (await lockWaiters(holder)) === 1, 'the waiting build');
  await new Promise((resolve) => setTimeout(resolve, 16_500));
  await holder.query('commit');
  await holder.end();
  const result = await run;
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.ms > 16_000, `waited ${result.ms} ms`);
  assert.match(result.stdout, /applied 20261030000000_signup_sheet\.sql/);
});

test('a file that fails is rolled back whole, with its ledger row; the failure names the file and its SQLSTATE', async () => {
  const url = await cluster.createDatabase({ migrated: false });
  const database = new URL(url).pathname.slice(1);
  const project = join(cluster.dir, 'broken-project');
  mkdirSync(join(project, 'supabase/migrations'), { recursive: true });
  copyFileSync(join(REPO, 'supabase/migrations', FILE), join(project, 'supabase/migrations', FILE));
  writeFileSync(
    join(project, 'supabase/migrations/20261031000000_broken.sql'),
    "create table public.half_done (id int);\ninsert into public.half_done values (1);\nselect 1 / 0;\n"
  );
  try {
    const result = await runMigrate({ DATABASE_URL: url }, project);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /applied 20261030000000_signup_sheet\.sql/);
    assert.equal(result.stderr, '[tofu-migrate] 20261031000000_broken.sql failed: SQLSTATE 22012\n');
    const ledger = await cluster.admin<{ version: string }>('select version from supabase_migrations.schema_migrations order by 1', [], database);
    assert.deepEqual(ledger.map((row) => row.version), ['20261030000000']);
    const [table] = await cluster.admin<{ exists: boolean }>("select to_regclass('public.half_done') is not null as exists", [], database);
    assert.equal(table?.exists, false);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("a data migration that fails on a row never prints the row's values; a syntax error in the file is printed in full", async () => {
  const url = await cluster.createDatabase({ migrated: true });
  const database = new URL(url).pathname.slice(1);
  await cluster.admin("insert into public.people (name, added_by) values ('ROWPROBE-Frank', 'member')", [], database);
  const project = join(cluster.dir, 'data-migration-project');
  mkdirSync(join(project, 'supabase/migrations'), { recursive: true });
  copyFileSync(join(REPO, 'supabase/migrations', FILE), join(project, 'supabase/migrations', FILE));
  const migration = join(project, 'supabase/migrations/20261031000000_numbers.sql');
  try {
    writeFileSync(migration, 'alter table public.people add column probe_n integer;\nupdate public.people set probe_n = name::integer;\n');
    const data = await runMigrate({ DATABASE_URL: url }, project);
    assert.equal(data.code, 1);
    assert.ok(!data.stderr.includes('ROWPROBE'), "no row's value in the build log");
    assert.equal(data.stderr, '[tofu-migrate] 20261031000000_numbers.sql failed: SQLSTATE 22P02\n');
    // Control: PostgreSQL's own message for that statement does quote the row.
    const message = await cluster.admin('select name::integer from public.people', [], database).then(
      () => '',
      (error: Error) => error.message
    );
    assert.match(message, /ROWPROBE-Frank/);

    writeFileSync(migration, 'selec 1;\n');
    const syntax = await runMigrate({ DATABASE_URL: url }, project);
    assert.equal(syntax.code, 1);
    assert.equal(syntax.stderr, '[tofu-migrate] 20261031000000_numbers.sql failed: SQLSTATE 42601, at character 1: syntax error at or near "selec"\n');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
