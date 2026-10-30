// TLS with a self-made CA, as Tofu's databases chain to SUPABASE_CA_CERT: the cluster refuses plain connections, and
// both the app's pool and the migrate script verify the server against Node's roots plus the CA. Verification is
// never switched off, so a wrong CA fails. This proves the code path locally; that SUPABASE_CA_CERT reaches Tofu's
// build step is only proven by a real deploy's build log.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { DatabaseConfigError } from '../../scripts/tofu-database.mjs';
import { createPool, dbFailure } from '../../src/lib/db';
import { type Cluster, runMigrate, scratchDirectory, startCluster } from '../support/postgres';
import { makeTestCa, type TestCa } from '../support/tls';

let scratch: { dir: string; remove(): void };
let ca: TestCa;
let otherCa: TestCa;
let cluster: Cluster;

before(async () => {
  scratch = scratchDirectory();
  ca = makeTestCa(join(scratch.dir, 'ca'), 'server');
  otherCa = makeTestCa(join(scratch.dir, 'other'), 'other', false);
  cluster = await startCluster({ tls: { certFile: ca.certFile, keyFile: ca.keyFile, caPem: ca.caPem } });
});

after(async () => {
  await cluster?.stop();
  scratch?.remove();
});

test('the app pool connects over verified TLS with SUPABASE_CA_CERT', async () => {
  const url = await cluster.createDatabase({ migrated: true });
  assert.match(url, /\?sslmode=require$/);
  for (const host of ['127.0.0.1', 'localhost']) {
    const pool = createPool({ DATABASE_URL: url.replace('127.0.0.1', host), SUPABASE_CA_CERT: ca.caPem });
    try {
      const { rows } = await pool.query<{ ssl: boolean }>('select ssl from pg_stat_ssl where pid = pg_backend_pid()');
      assert.equal(rows[0]?.ssl, true, host);
    } finally {
      await pool.end();
    }
  }
});

test('control: this server refuses a connection without TLS', async () => {
  const url = await cluster.createDatabase({ migrated: false });
  const plain = new pg.Client({ connectionString: url.replace('?sslmode=require', '') });
  await assert.rejects(plain.connect(), /no encryption|pg_hba/);
});

test('a CA that did not sign the server certificate fails the connection; no CA at all fails before it', async () => {
  const url = await cluster.createDatabase({ migrated: false });
  const wrong = createPool({ DATABASE_URL: url, SUPABASE_CA_CERT: otherCa.caPem });
  try {
    const error = await wrong.query('select 1').catch((caught: unknown) => caught);
    assert.ok(error instanceof Error);
    assert.equal(dbFailure(error), 'unavailable');
    assert.match(String((error as { code?: string }).code), /CERT|UNABLE_TO/);
  } finally {
    await wrong.end();
  }
  assert.throws(() => createPool({ DATABASE_URL: url }), (error: unknown) => error instanceof DatabaseConfigError);
});

test('the migrate script applies over verified TLS, and stops with its sentence without the CA', async () => {
  const url = await cluster.createDatabase({ migrated: false });
  const missing = await runMigrate({ DATABASE_URL: url });
  assert.equal(missing.code, 1);
  assert.equal(missing.stderr, "[tofu-migrate] SUPABASE_CA_CERT is not set: it is needed to check the database server's certificate.\n");
  const wrong = await runMigrate({ DATABASE_URL: url, SUPABASE_CA_CERT: otherCa.caPem });
  assert.equal(wrong.code, 1);
  assert.match(wrong.stderr, /^\[tofu-migrate\] failed: /);
  const applied = await runMigrate({ DATABASE_URL: url, SUPABASE_CA_CERT: ca.caPem });
  assert.equal(applied.code, 0, applied.stderr);
  assert.match(applied.stdout, /applied 20261030000000_signup_sheet\.sql/);
});
