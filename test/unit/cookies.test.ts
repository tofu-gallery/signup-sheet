import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearCookie, cookieName, readCookie, setCookie } from '../../src/lib/cookies';

test('over https only the __Host- names are read; the unprefixed copies are ignored', () => {
  const headers = new Headers({ cookie: 'ss_org=pw.1.forged; __Host-ss_org=seat.real; ss_me=other' });
  assert.equal(readCookie(headers, 'ss_org', 'https'), 'seat.real');
  assert.equal(readCookie(headers, 'ss_me', 'https'), null);
  assert.equal(readCookie(new Headers({ cookie: 'ss_org=pw.1.forged' }), 'ss_org', 'https'), null);
});

test('over plain http (local tests) the unprefixed names are read', () => {
  const headers = new Headers({ cookie: '__Host-ss_me=a; ss_me=b' });
  assert.equal(readCookie(headers, 'ss_me', 'http'), 'b');
  assert.equal(cookieName('ss_b', 'http'), 'ss_b');
  assert.equal(cookieName('ss_b', 'https'), '__Host-ss_b');
});

test('the first value of a name wins, and malformed pairs are skipped', () => {
  assert.equal(readCookie(new Headers({ cookie: 'junk; =x; __Host-ss_b=first; __Host-ss_b=second' }), 'ss_b', 'https'), 'first');
  assert.equal(readCookie(new Headers({}), 'ss_b', 'https'), null);
});

test("every pair is read: cookies an app on another host of the same site sends first (64, or 300) never hide this app's own", () => {
  for (const planted of [64, 300]) {
    const others = Array.from({ length: planted }, (_, i) => `other${i}=x`).join('; ');
    assert.equal(readCookie(new Headers({ cookie: `${others}; __Host-ss_me=mine` }), 'ss_me', 'https'), 'mine', `${planted} first`);
  }
});

test('Set-Cookie has HttpOnly, SameSite=Lax, Path=/, no Domain, and Secure over https', () => {
  assert.equal(setCookie('ss_me', 'abc', 400 * 86400, 'https'), '__Host-ss_me=abc; Path=/; Max-Age=34560000; HttpOnly; SameSite=Lax; Secure');
  assert.equal(setCookie('ss_me', 'abc', 10, 'http'), 'ss_me=abc; Path=/; Max-Age=10; HttpOnly; SameSite=Lax');
  assert.equal(clearCookie('ss_org', 'https'), '__Host-ss_org=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure');
  assert.ok(!setCookie('ss_b', 'x', 1, 'https').includes('Domain'));
  assert.throws(() => setCookie('ss_me', 'a;b', 1, 'https'));
});
