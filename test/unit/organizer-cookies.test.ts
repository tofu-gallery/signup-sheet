import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  organizerFromCookie,
  type OrganizerAccess,
  passwordCookie,
  passwordMatches,
  signInFormShown
} from '../../src/lib/access';
import { readSettings } from '../../src/lib/settings';
import { sha256 } from '../../src/lib/tokens';

// Synthetic, test-only values.
const settings = readSettings({ DATABASE_URL: 'postgresql://app@127.0.0.1:1/db', ORGANIZER_PASSWORD: ' correct horse battery ' });
const PASSWORD: OrganizerAccess = { state: 'password', seat: null };
const NOW = new Date('2026-11-01T12:00:00Z');

test('the password is compared trimmed, and only a long enough saved one can match', () => {
  assert.equal(passwordMatches('correct horse battery', settings), true);
  assert.equal(passwordMatches('  correct horse battery\n', settings), true);
  assert.equal(passwordMatches('correct horse', settings), false);
  assert.equal(passwordMatches('short', { ...settings, organizerPassword: 'short' }), false);
});

test('a password cookie works while that password and DATABASE_URL stay; changing either signs it out', () => {
  const { cookieValue, maxAgeSeconds } = passwordCookie(settings, NOW);
  assert.match(cookieValue, /^pw\.[0-9]+\.[A-Za-z0-9_-]{43}$/);
  assert.equal(maxAgeSeconds, 90 * 86400);
  assert.deepEqual(organizerFromCookie(cookieValue, PASSWORD, settings, NOW), { via: 'password' });
  assert.equal(organizerFromCookie(cookieValue, PASSWORD, { ...settings, organizerPassword: 'a different long password' }, NOW), null);
  assert.equal(organizerFromCookie(cookieValue, PASSWORD, { ...settings, databaseUrl: 'postgresql://app@127.0.0.1:2/db' }, NOW), null);
});

test('a password cookie older than 90 days, from the future, or altered is refused', () => {
  const old = passwordCookie(settings, new Date(NOW.getTime() - 91 * 86400_000)).cookieValue;
  assert.equal(organizerFromCookie(old, PASSWORD, settings, NOW), null);
  const future = passwordCookie(settings, new Date(NOW.getTime() + 3600_000)).cookieValue;
  assert.equal(organizerFromCookie(future, PASSWORD, settings, NOW), null);
  const good = passwordCookie(settings, NOW).cookieValue;
  const [, issued, mac] = good.split('.');
  assert.equal(organizerFromCookie(`pw.${Number(issued) + 1}.${mac}`, PASSWORD, settings, NOW), null);
  const altered = `${mac!.slice(0, -1)}${mac!.endsWith('A') ? 'B' : 'A'}`;
  assert.equal(organizerFromCookie(`pw.${issued}.${altered}`, PASSWORD, settings, NOW), null);
});

test('in every state but held and password no cookie signs in; a seat cookie only matches its own seat', () => {
  const secret = Buffer.alloc(32, 7);
  const seatCookie = `seat.${secret.toString('base64url')}`;
  const held: OrganizerAccess = { state: 'held', seat: { hash: sha256(secret), until: new Date(NOW.getTime() + 1000) } };
  assert.deepEqual(organizerFromCookie(seatCookie, held, settings, NOW), { via: 'seat' });
  assert.equal(organizerFromCookie(`seat.${Buffer.alloc(32, 8).toString('base64url')}`, held, settings, NOW), null);
  assert.equal(organizerFromCookie(passwordCookie(settings, NOW).cookieValue, held, settings, NOW), null);
  assert.equal(organizerFromCookie(seatCookie, PASSWORD, settings, NOW), null);
  for (const state of ['setup-open', 'locked-short', 'locked-removed', 'locked-expired', 'locked-unclaimed'] as const) {
    const access: OrganizerAccess = { state, seat: null };
    assert.equal(organizerFromCookie(seatCookie, access, settings, NOW), null, state);
    assert.equal(organizerFromCookie(passwordCookie(settings, NOW).cookieValue, access, settings, NOW), null, state);
    assert.equal(signInFormShown(state), false, state);
  }
  assert.equal(signInFormShown('password'), true);
  assert.equal(signInFormShown('held'), false);
});
