// GET /health, called directly as a route handler (Request in, Response out) on a real database. Not an HTTP test:
// headers set by next.config.ts and the server's own behaviour are checked over HTTP by qa/local-http-check.py (its
// headers suite) and the live check.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { GET } from '../../src/app/health/route';
import { poolFor, seedSheet } from '../support/fixtures';
import { type Cluster, startCluster } from '../support/postgres';

let cluster: Cluster;
let url: string;
const shared = globalThis as typeof globalThis & { signupSheetPool?: { end(): Promise<void> } };

async function withEnv<T>(env: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const saved = { DATABASE_URL: process.env.DATABASE_URL, ORGANIZER_PASSWORD: process.env.ORGANIZER_PASSWORD };
  Object.assign(process.env, env);
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete process.env[key];
  try {
    return await run();
  } finally {
    await shared.signupSheetPool?.end();
    delete shared.signupSheetPool;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

before(async () => {
  cluster = await startCluster();
  url = await cluster.createDatabase({ migrated: true });
});

after(async () => {
  await cluster?.stop();
});

test('health reports the organizer state and the listed open sheets, and nothing else', async () => {
  const pool = poolFor(url);
  try {
    const fresh = await withEnv({ DATABASE_URL: url, ORGANIZER_PASSWORD: undefined }, () => GET());
    assert.equal(fresh.status, 200);
    assert.equal(fresh.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await fresh.json(), { app: 'signup-sheet', organizer: 'setup-open', openSheets: 0 });

    await seedSheet(pool, 'listed', 'open');
    await seedSheet(pool, 'draft', 'draft');
    await pool.query("insert into sheets (slug, title, status, listed) values ('zz-check-abc123', 'Check', 'open', false)");
    const withSheets = await withEnv({ DATABASE_URL: url, ORGANIZER_PASSWORD: 'correct horse battery staple' }, () => GET());
    assert.deepEqual(await withSheets.json(), { app: 'signup-sheet', organizer: 'password', openSheets: 1 });
    const { rows } = await pool.query<{ seat_state: string }>('select seat_state from app_state');
    assert.equal(rows[0]?.seat_state, 'retired', 'any request retires the seat once a password is saved');
  } finally {
    await pool.end();
  }
});

test('health answers 503 when the database cannot be reached', async () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (line: string) => lines.push(line);
  try {
    const down = await withEnv({ DATABASE_URL: 'postgresql://app_owner@127.0.0.1:1/none', ORGANIZER_PASSWORD: undefined }, () => GET());
    assert.equal(down.status, 503);
    assert.equal((await down.json()).app, 'signup-sheet');
  } finally {
    console.error = original;
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^\[signup-sheet\] health: Error ECONNREFUSED$/);
});
