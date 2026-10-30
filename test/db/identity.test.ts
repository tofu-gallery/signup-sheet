// Private links, their replacement, a claim form's derived first link, and the activity record.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type pg from 'pg';
import { readCookie } from '../../src/lib/cookies';
import { inTransaction } from '../../src/lib/db';
import { browserFor, memberByToken, recordActivity, replaceLink } from '../../src/lib/identity';
import { readSettings } from '../../src/lib/settings';
import { firstLinkToken, newRequestId, newToken, requestHash, tokenHash } from '../../src/lib/tokens';
import { poolFor, seedSheet, seedSlot } from '../support/fixtures';
import { type Cluster, startCluster } from '../support/postgres';

let cluster: Cluster;
let pool: pg.Pool;
let url: string;

before(async () => {
  cluster = await startCluster();
  url = await cluster.createDatabase({ migrated: true });
  pool = poolFor(url);
});

after(async () => {
  await pool?.end();
  await cluster?.stop();
});

async function personWithToken(token: string, name = 'The Mike family'): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    "insert into people (name, token_hash, link_made_at, added_by) values ($1, $2, now(), 'member') returning id",
    [name, tokenHash(token)]
  );
  return rows[0]!.id;
}

const cookieHeaders = (token: string) => new Headers({ cookie: `__Host-ss_me=${token}` });

test('a link finds its person by hash; unknown and malformed links find nobody', async () => {
  const token = newToken();
  const id = await personWithToken(token);
  assert.deepEqual(await memberByToken(pool, token), { id, name: 'The Mike family' });
  assert.equal(await memberByToken(pool, newToken()), null);
  for (const malformed of [null, '', 'short', `${token}x`, `${token.slice(0, 42)}=`]) {
    assert.equal(await memberByToken(pool, malformed), null);
  }
});

test('a new link kills the old one and every cookie holding it; the new one works at once', async () => {
  const old = newToken();
  const id = await personWithToken(old, 'Mike');
  const fresh = await replaceLink(pool, id);
  assert.ok(fresh && fresh !== old);
  assert.equal(await memberByToken(pool, readCookie(cookieHeaders(old), 'ss_me', 'https')), null);
  assert.deepEqual(await memberByToken(pool, readCookie(cookieHeaders(fresh), 'ss_me', 'https')), { id, name: 'Mike' });
  assert.equal(await replaceLink(pool, '999999999'), null);
});

test("a repeated claim form re-derives the same first link; a replaced link or a new DATABASE_URL does not bring it back", async () => {
  const settings = readSettings({ DATABASE_URL: url });
  const rid = newRequestId();
  const id = await personWithToken(newToken(), 'Frank');
  const first = firstLinkToken(settings, rid, id);
  await pool.query('update people set token_hash = $1 where id = $2', [tokenHash(first), id]);
  const sheet = await seedSheet(pool, 'replay');
  const { slotId } = await seedSlot(pool, sheet);
  await pool.query(
    "insert into signups (slot_id, person_id, status, added_by, request_hash) values ($1, $2, 'confirmed', 'member', $3)",
    [slotId, id, requestHash(rid)]
  );

  // The retry finds the sign-up by the request id's hash and derives the same link from it and the person's id.
  const { rows } = await pool.query<{ person_id: string }>('select person_id from signups where request_hash = $1', [requestHash(rid)]);
  assert.equal(rows[0]?.person_id, id);
  assert.deepEqual(await memberByToken(pool, firstLinkToken(settings, rid, id)), { id, name: 'Frank' });
  // The same form making another person (another id) gives another link, and so does a new DATABASE_URL.
  assert.notEqual(firstLinkToken(settings, rid, `${Number(id) + 1}`), first);
  assert.equal(await memberByToken(pool, firstLinkToken(readSettings({ DATABASE_URL: `${url}?x=1` }), rid, id)), null);

  await replaceLink(pool, id);
  assert.equal(await memberByToken(pool, firstLinkToken(settings, rid, id)), null);

  // Neither the link, nor the request id it came from, is anywhere in the stored rows.
  const dump = JSON.stringify((await pool.query("select to_jsonb(p) as row from people p union all select to_jsonb(s) from signups s")).rows);
  assert.ok(!dump.includes(first) && !dump.includes(rid));
});

test('the activity row is part of the write: a write that rolls back leaves none', async () => {
  const browser = browserFor(new Headers({}), 'https');
  assert.match(browser.id, /^[A-Za-z0-9_-]{22}$/);
  assert.match(browser.setCookie ?? '', /^__Host-ss_b=[A-Za-z0-9_-]{22}; Path=\/; Max-Age=34560000; HttpOnly; SameSite=Lax; Secure$/);
  const kept = browserFor(new Headers({ cookie: `__Host-ss_b=${browser.id}` }), 'https');
  assert.deepEqual(kept, { id: browser.id, setCookie: null });

  await assert.rejects(
    inTransaction(pool, async (tx) => {
      await recordActivity(tx, { actor: 'member', kind: 'claim', browser: browser.id, sheetId: null });
      throw new Error('the write failed');
    })
  );
  await inTransaction(pool, (tx) => recordActivity(tx, { actor: 'organizer', kind: 'claim', browser: browser.id, sheetId: null }));
  const { rows } = await pool.query<{ actor: string }>('select actor from activity where browser = $1', [browser.id]);
  assert.deepEqual(rows, [{ actor: 'organizer' }]);
  await assert.rejects(inTransaction(pool, (tx) => recordActivity(tx, { actor: 'member', kind: 'Bad Kind', browser: browser.id, sheetId: null })));
});
