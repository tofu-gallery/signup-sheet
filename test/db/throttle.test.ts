// The throttle table, shared by every app process.
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import type pg from 'pg';
import { overLimit, pruneSometimes, refund } from '../../src/lib/throttle';
import { poolFor } from '../support/fixtures';
import { type Cluster, startCluster } from '../support/postgres';

let cluster: Cluster;
let first: pg.Pool;
let second: pg.Pool;

before(async () => {
  cluster = await startCluster();
  const url = await cluster.createDatabase({ migrated: true });
  first = poolFor(url);
  second = poolFor(url);
});

beforeEach(async () => {
  // Independent cases start clean; the limits themselves are never changed.
  await first.query('truncate throttle');
});

after(async () => {
  await first?.end();
  await second?.end();
  await cluster?.stop();
});

const LIMIT = { hits: 5, seconds: 900 };

test('the sixth hit in a window is over a limit of five', async () => {
  const answers = [];
  for (let i = 0; i < 6; i += 1) answers.push(await overLimit(first, 'signin:abc', LIMIT));
  assert.deepEqual(answers, [false, false, false, false, false, true]);
});

test('hits from two app processes, all at once, share one count', async () => {
  const results = await Promise.all(
    Array.from({ length: 24 }, (_, i) => overLimit(i % 2 ? first : second, 'copy:member', { hits: 20, seconds: 3600 }))
  );
  assert.equal(results.filter(Boolean).length, 4);
  const { rows } = await first.query<{ hits: number }>("select hits from throttle where key = 'copy:member'");
  assert.equal(rows[0]?.hits, 24);
});

test('a window that has ended starts again at one', async () => {
  for (let i = 0; i < 6; i += 1) await overLimit(first, 'signin:old', LIMIT);
  await first.query("update throttle set window_start = now() - interval '16 minutes' where key = 'signin:old'");
  assert.equal(await overLimit(first, 'signin:old', LIMIT), false);
  const { rows } = await first.query<{ hits: number }>("select hits from throttle where key = 'signin:old'");
  assert.equal(rows[0]?.hits, 1);
});

test('a refund takes back one hit, never below zero', async () => {
  await overLimit(first, 'signin:r', LIMIT);
  await overLimit(first, 'copy:signin', LIMIT);
  await refund(first, ['signin:r', 'copy:signin', 'missing']);
  await refund(first, ['signin:r']);
  const { rows } = await first.query<{ key: string; hits: number }>('select key, hits from throttle order by key');
  assert.deepEqual(rows, [
    { key: 'copy:signin', hits: 0 },
    { key: 'signin:r', hits: 0 }
  ]);
});

test('pruning, on about 1 in 50 writes, deletes only throttle rows older than a day and activity older than 120 days', async () => {
  const browser = 'A'.repeat(22);
  await first.query(
    `insert into throttle (key, window_start, hits) values ('old', now() - interval '25 hours', 3), ('new', now() - interval '23 hours', 3);
     insert into activity (at, actor, kind, browser) values (now() - interval '121 days', 'member', 'claim', '${browser}'), (now() - interval '119 days', 'member', 'claim', '${browser}')`
  );
  assert.equal(await pruneSometimes(first, 0.5), false);
  assert.equal((await first.query('select 1 from throttle')).rowCount, 2);
  assert.equal(await pruneSometimes(first, 0.001), true);
  const keys = (await first.query<{ key: string }>('select key from throttle')).rows.map((row) => row.key);
  assert.deepEqual(keys, ['new']);
  const kept = await first.query<{ n: number }>("select count(*)::int as n from activity where at > now() - interval '120 days'");
  const all = await first.query<{ n: number }>('select count(*)::int as n from activity');
  assert.equal(kept.rows[0]?.n, 1);
  assert.equal(all.rows[0]?.n, 1);
});
