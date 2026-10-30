import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readSettings } from '../../src/lib/settings';
import { clientAddress, connectionKey, copyKey, LIMITS } from '../../src/lib/throttle';

const settings = readSettings({ DATABASE_URL: 'postgresql://app@127.0.0.1:1/db' });

test('the client address: x-vercel-forwarded-for, then x-real-ip, then the first x-forwarded-for entry', () => {
  assert.equal(clientAddress(new Headers({ 'x-vercel-forwarded-for': '1.1.1.1', 'x-real-ip': '2.2.2.2', 'x-forwarded-for': '3.3.3.3' })), '1.1.1.1');
  assert.equal(clientAddress(new Headers({ 'x-real-ip': '2.2.2.2', 'x-forwarded-for': '3.3.3.3, 4.4.4.4' })), '2.2.2.2');
  assert.equal(clientAddress(new Headers({ 'x-forwarded-for': ' 3.3.3.3 , 4.4.4.4' })), '3.3.3.3');
  assert.equal(clientAddress(new Headers({})), 'unknown');
});

test('throttle keys hold a keyed hash, never the address, and fit the table', () => {
  const key = connectionKey('signin', new Headers({ 'x-real-ip': '203.0.113.7' }), settings);
  assert.match(key, /^signin:[0-9a-f]{32}$/);
  assert.ok(!key.includes('203'));
  assert.notEqual(connectionKey('signin', new Headers({ 'x-real-ip': '203.0.113.7' }), { ...settings, databaseUrl: 'other' }), key);
  assert.ok(key.length <= 80);
  assert.equal(copyKey('member'), 'copy:member');
});

test('the limits are the ones TOFU.md lists (Requests)', () => {
  assert.deepEqual(LIMITS.signInPerConnection, { hits: 5, seconds: 900 });
  assert.deepEqual(LIMITS.signInPerCopy, { hits: 50, seconds: 3600 });
  assert.deepEqual(LIMITS.setupPerConnection, { hits: 5, seconds: 3600 });
  assert.deepEqual(LIMITS.memberWritePerConnection, { hits: 30, seconds: 600 });
  assert.deepEqual(LIMITS.memberWritePerCopy, { hits: 2000, seconds: 3600 });
  assert.deepEqual(LIMITS.linkMissPerConnection, { hits: 30, seconds: 600 });
  assert.deepEqual(LIMITS.importPerCopy, { hits: 30, seconds: 3600 });
});
