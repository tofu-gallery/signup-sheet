import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readSettings } from '../../src/lib/settings';
import {
  firstLinkToken,
  isToken,
  newRequestId,
  newToken,
  requestHash,
  requestIdFrom,
  sha256,
  tokenHash
} from '../../src/lib/tokens';

const settings = readSettings({ DATABASE_URL: ' postgresql://app@127.0.0.1:1/db ', ORGANIZER_PASSWORD: '  ' });

test('settings are trimmed', () => {
  assert.equal(settings.databaseUrl, 'postgresql://app@127.0.0.1:1/db');
  assert.equal(settings.organizerPassword, '');
});

test('a private link is 43 base64url characters and only its SHA-256 is stored', () => {
  const token = newToken();
  assert.ok(isToken(token));
  assert.equal(tokenHash(token).length, 32);
  assert.notEqual(newToken(), token);
  for (const bad of ['', 'x'.repeat(42), 'x'.repeat(44), `${'x'.repeat(42)}=`, `${'x'.repeat(42)}/`]) assert.equal(isToken(bad), false);
});

test("a person's first link comes from the request id and the person's id: the same form and person give the same link, nothing else does", () => {
  const rid = newRequestId();
  const first = firstLinkToken(settings, rid, '41');
  assert.ok(isToken(first));
  assert.equal(firstLinkToken(settings, rid, '41'), first);
  assert.notEqual(firstLinkToken(settings, newRequestId(), '41'), first);
  assert.notEqual(firstLinkToken(settings, rid, '42'), first, 'the same form making another person gives another link');
  assert.notEqual(firstLinkToken(settings, rid, '4'), firstLinkToken(settings, rid.slice(0, -1), `${rid.at(-1)}4`), 'the separator keeps the parts apart');
  assert.notEqual(firstLinkToken({ ...settings, databaseUrl: `${settings.databaseUrl}x` }, rid, '41'), first, 'a new DATABASE_URL gives another key');
  assert.notEqual(requestHash(rid).toString('hex'), tokenHash(first).toString('hex'));
});

test('request ids must be v4 UUIDs; their hash, never the id, is stored', () => {
  const rid = newRequestId();
  assert.equal(requestIdFrom(rid), rid);
  assert.equal(requestIdFrom(` ${rid.toUpperCase()} `), rid);
  for (const bad of ['', 'abc', '00000000-0000-1000-8000-000000000000', `${rid}x`, '6ba7b810-9dad-11d1-80b4-00c04fd430c8']) {
    assert.equal(requestIdFrom(bad), null, bad);
  }
  assert.deepEqual(requestHash(rid), sha256(rid));
});
