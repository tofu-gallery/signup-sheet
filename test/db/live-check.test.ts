// qa/live-check.py, run whole against the real route handlers and a throwaway database through the bridge
// (test/support/bridge.ts): no HTTP and no Next.js server. Each mode must pass on the real source; delivery must leave
// the organizer's data exactly as it was, also when it stops part-way; and with a protection taken out of a copy of the
// source, the live check must fail at that protection's own line (its negative controls).
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type pg from 'pg';
import { runLiveCheck, runLocalChecks, type CheckResult } from '../support/bridge';
import { assertCountsConsistent, changedCopy, count, type Edit, endRoutePool, snapshot, useDatabase } from '../support/core';
import { poolFor } from '../support/fixtures';
import { copyRoutes, realRoutes, type RouteLoader } from '../support/probes';
import { type Cluster, REPO, scratchDirectory, startCluster } from '../support/postgres';

// An obvious local test value, never a real password: the copy is "redeployed" with it as ORGANIZER_PASSWORD.
const LOCAL_PASSWORD = 'local-test-password-not-real';

let cluster: Cluster;
const pools: pg.Pool[] = [];
const scratch = scratchDirectory();

before(async () => {
  cluster = await startCluster();
});

after(async () => {
  await endRoutePool();
  await Promise.all(pools.map((pool) => pool.end()));
  await cluster?.stop();
  scratch.remove();
});

async function newCopy(): Promise<{ url: string; pool: pg.Pool }> {
  const url = await cluster.createDatabase({ migrated: true });
  await useDatabase(url);
  const pool = poolFor(url);
  pools.push(pool);
  return { url, pool };
}

let states = 0;
function stateFile(): string {
  states += 1;
  return join(scratch.dir, `copy-${states}`, 'state.json');
}

async function check(load: RouteLoader, args: string[], env: Record<string, string> = {}): Promise<CheckResult> {
  const result = await runLiveCheck(load, args, env);
  assert.equal(result.err, '', `the live check wrote to stderr:\n${result.err}`);
  return result;
}

function passed(result: CheckResult): void {
  assert.equal(result.code, 0, `the live check failed:\n${result.out}`);
  assert.match(result.out, /^RESULT PASS$/m);
  assert.doesNotMatch(result.out, /^FAIL /m);
}

function failedAt(result: CheckResult, line: string, words: string): void {
  assert.equal(result.code, 1, `the live check must fail:\n${result.out}`);
  assert.match(result.out, /^RESULT FAIL$/m);
  const lines = result.out.split('\n').filter((each) => each.startsWith(`FAIL ${line} `));
  assert.ok(lines.some((each) => each.includes(words)), `expected "FAIL ${line} … ${words} …" in:\n${result.out}`);
}

/** No private link, seat or password value in what the check printed or kept as evidence; its files are private. */
function keptPrivate(state: string, result: CheckResult): void {
  const seat = (JSON.parse(readFileSync(state, 'utf8')) as { seat?: { cookie?: string } }).seat?.cookie ?? '';
  assert.equal(statSync(state).mode & 0o777, 0o600, 'the state file is mode 600');
  const evidence = `${state}.evidence`;
  assert.equal(statSync(evidence).mode & 0o777, 0o700, 'the evidence folder is mode 700');
  const texts = [result.out];
  for (const run of readdirSync(evidence)) {
    for (const file of readdirSync(join(evidence, run))) {
      assert.equal(statSync(join(evidence, run, file)).mode & 0o777, 0o600, `${file} is mode 600`);
      texts.push(readFileSync(join(evidence, run, file), 'utf8'));
    }
  }
  for (const text of texts) {
    assert.doesNotMatch(text, /\/me\/[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/, 'no private link');
    assert.doesNotMatch(text, /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/, 'no 43-character token');
    if (seat) assert.ok(!text.includes(seat.slice(5)), 'no seat cookie');
    assert.ok(!text.includes(LOCAL_PASSWORD), 'no password');
  }
}

/** Everything of the organizer's a delivery run must leave alone: the business rows (activity is the run's own). */
async function organizerData(pool: pg.Pool): Promise<Record<string, unknown[]>> {
  const { activity: _activity, ...rest } = await snapshot(pool);
  return rest;
}

test('fresh, then password, then read, on a QA copy: every line passes, and nothing private is printed or kept', { timeout: 300_000 }, async () => {
  const { url, pool } = await newCopy();
  const state = stateFile();
  const fresh = await check(realRoutes, ['--mode', 'fresh', '--state', state]);
  passed(fresh);
  for (const line of ['M01', 'M06', 'M11', 'M13', 'M14', 'M16', 'M18', 'M20', 'M21', 'M23', 'M25', 'G01']) {
    assert.match(fresh.out, new RegExp(`^ok   ${line} `, 'm'), `${line} ran`);
  }
  await assertCountsConsistent(pool);
  assert.equal(await count(pool, "select count(*) from activity where actor = 'member'") > 0, true, 'members acted');

  // Saving ORGANIZER_PASSWORD and deploying again.
  await useDatabase(url, LOCAL_PASSWORD);
  const password = await check(realRoutes, ['--mode', 'password', '--state', state], { QA_PW: LOCAL_PASSWORD });
  passed(password);
  const memberRows = await count(pool, "select count(*) from activity where actor = 'member'");

  const read = await check(realRoutes, ['--mode', 'read', '--state', state]);
  passed(read);
  // R05 says what it looked for: the fresh run's own contacts and words, never the organizer's real ones.
  assert.match(read.out, /^info R05 looks for [1-9][0-9]* contacts and words /m);
  assert.match(read.out, /^ok   R05 the public pages carry no private link, none of those contacts or words, and no paid state or dues$/m);
  assert.equal(await count(pool, "select count(*) from activity where actor = 'member'"), memberRows, 'read and password write no member activity');
  keptPrivate(state, read);
  keptPrivate(state, fresh);
});

test('seat, import and delivery on an organizer copy: the organizer data is exactly as it was before', { timeout: 300_000 }, async () => {
  const { pool } = await newCopy();
  const state = stateFile();
  passed(await check(realRoutes, ['--mode', 'seat', '--state', state]));
  const soccer = join(REPO, 'examples/soccer.json');
  const dry = await check(realRoutes, ['--mode', 'import', '--file', soccer, '--state', state]);
  passed(dry);
  assert.match(dry.out, /^info summary: Would make: 1 sheet \(Snack sign-up, draft\)/m);
  assert.equal(await count(pool, 'select count(*) from sheets'), 0, 'the dry run made nothing');
  passed(await check(realRoutes, ['--mode', 'import', '--file', soccer, '--apply', '--state', state]));
  // What a real copy has by delivery time: an open sheet, and a member's contact the public pages must never show.
  await pool.query("update sheets set status = 'open' where slug = 'snacks'");
  await pool.query("update people set contact = 'frank-real-probe@example.com' where name = 'Frank''s family'");

  const before = await organizerData(pool);
  const delivery = await check(realRoutes, ['--mode', 'delivery', '--state', state]);
  passed(delivery);
  assert.match(delivery.out, /^ok   D31 /m);
  assert.deepEqual(await organizerData(pool), before, 'every row of the organizer data is as it was');
  assert.equal(await count(pool, "select count(*) from sheets where slug like 'zz-check-%'"), 0);
  assert.equal(await count(pool, "select count(*) from people where name like 'QA %'"), 0);
  await assertCountsConsistent(pool);
  keptPrivate(state, delivery);
  assert.ok(!delivery.out.includes('frank-real-probe'), "a real contact is never printed");

  const nothing = await check(realRoutes, ['--mode', 'delivery', '--cleanup-only', '--state', state]);
  passed(nothing);
});

test('a delivery run that stops part-way still removes its own sheet and people, and fails', { timeout: 300_000 }, async () => {
  // The claim form loses its honeypot field, so the check stops right after its import made a sheet and a person.
  const copy = changedCopy([{ file: 'src/lib/pages/public.ts', from: 'name="ss_hp" type="text"', to: 'name="ss_hp_gone" type="text"' }]);
  try {
    const { pool } = await newCopy();
    const state = stateFile();
    const load = copyRoutes(copy);
    passed(await check(load, ['--mode', 'seat', '--state', state]));
    passed(await check(load, ['--mode', 'import', '--file', join(REPO, 'examples/dues.json'), '--apply', '--state', state]));
    const before = await organizerData(pool);
    const stopped = await check(load, ['--mode', 'delivery', '--state', state]);
    failedAt(stopped, 'M11', 'honeypot');
    assert.match(stopped.out, /^ok   D30 /m);
    assert.match(stopped.out, /^ok   D31 /m);
    assert.deepEqual(await organizerData(pool), before);
    assert.equal(await count(pool, "select count(*) from people where name like 'QA %'"), 0);
  } finally {
    copy.remove();
  }
});

// The protections each control takes out, in a copy of the source; the strings are the same ones controls.test.ts edits.
const CONTROLS: { name: string; edits: Edit[]; line: string; words: string }[] = [
  {
    name: 'the Origin check in guarded()',
    edits: [{ file: 'src/lib/guard.ts', from: '    if (!originAllowed(request.headers)) return sentencePage(403, words.originRefused);\n', to: '' }],
    line: 'M04',
    words: 'foreign Origin'
  },
  {
    name: 'the public view that never selects a contact',
    edits: [{ file: 'src/lib/views.ts', from: '? `select g.slot_id as "slotId", p.name, g.note', to: '? `select g.slot_id as "slotId", p.name || \' \' || p.contact as name, g.note' }],
    line: 'M13',
    words: 'no contact'
  },
  {
    name: "the person filter on a member's cancel (W2)",
    edits: [
      { file: 'src/lib/signups.ts', from: '[signupId, owner?.personId ?? null]', to: '[signupId, null]' },
      { file: 'src/lib/signups.ts', from: 'lockSignups(tx, [signupId], owner ? { personId: owner.personId } : null)', to: 'lockSignups(tx, [signupId], null)' }
    ],
    line: 'M17b',
    words: "B's cookie cancelling A's sign-up"
  }
];

for (const control of CONTROLS) {
  test(`control: without ${control.name}, the live check fails at ${control.line}`, { timeout: 300_000 }, async () => {
    const copy = changedCopy(control.edits);
    try {
      await newCopy();
      const result = await check(copyRoutes(copy), ['--mode', 'fresh', '--state', stateFile()]);
      failedAt(result, control.line, control.words);
      if (control.line === 'M04') failedAt(result, 'M05', 'foreign Origin');
      if (control.line === 'M13') failedAt(result, 'M21', 'carries no contact');
    } finally {
      copy.remove();
    }
  });
}

test('the local HTTP suites run through the bridge: two addresses served by one process, so not HTTP and not two processes', { timeout: 300_000 }, async () => {
  const { pool } = await newCopy();
  const state = stateFile();
  const urls = ['--url', 'http://127.0.0.1:3000', '--url', 'http://127.0.0.1:3001'];
  const all = await runLocalChecks(realRoutes, [...urls, '--state', state, '--suite', 'all', '--rounds', '2', '--threads', '6']);
  assert.equal(all.err, '', all.err);
  passed(all);
  for (const line of ['T15', 'T21', 'T32', 'T23', 'T36', 'T35', 'T09', 'T01', 'T02']) {
    assert.match(all.out, new RegExp(`^ok   ${line} `, 'm'), `${line} ran`);
  }
  await assertCountsConsistent(pool);
  keptPrivate(state, all);

  const logs = join(scratch.dir, `logs-${states}`);
  mkdirSync(logs);
  writeFileSync(join(logs, 'clean.log'), 'GET /s/race 200 in 12ms\nPOST /s/race/slots/4/claim 303 in 40ms\n');
  passed(await runLocalChecks(realRoutes, [...urls, '--state', state, '--suite', 'logs', '--log-file', join(logs, 'clean.log')]));
  writeFileSync(join(logs, 'leaky.log'), `GET /me/${'Q'.repeat(43)} 303 in 3ms\n`);
  const leaky = await runLocalChecks(realRoutes, [...urls, '--state', state, '--suite', 'logs', '--log-file', join(logs, 'leaky.log')]);
  failedAt(leaky, 'T39', 'hold no private link');
  assert.ok(!leaky.out.includes('Q'.repeat(43)), 'the finding names a line, never the value');
});
