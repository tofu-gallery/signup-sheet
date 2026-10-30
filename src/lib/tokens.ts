// Hashes, private links, request ids and the keys the app derives from its settings (see TOFU.md, Members and their
// links). No key is ever saved: each one comes from DATABASE_URL (and, for organizer cookies, the password), so a new
// DATABASE_URL or password changes it. Member links are checked by their hash alone, so they survive both.
import { createHash, createHmac, hkdfSync, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Settings } from './settings';

export function sha256(data: string | Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

/** Compares two secrets in constant time (false when their lengths differ). */
export function sameBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function derive(material: string, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', material, 'signup-sheet', info, 32));
}

/**
 * Signs organizer password cookies: a new ORGANIZER_PASSWORD or DATABASE_URL signs out every browser signed in with the
 * password. A seat cookie is checked against the hash in app_state instead (access.ts), so a new DATABASE_URL keeps it.
 */
export function organizerKey(settings: Settings): Buffer {
  return derive(`${settings.databaseUrl}\0${settings.organizerPassword}`, 'organizer v1');
}

/** Derives a new person's first private link from the claim form's request id. */
export function linkKey(settings: Settings): Buffer {
  return derive(settings.databaseUrl, 'edit links v1');
}

/** Keys the throttle's connection hashes, so the throttle table holds no address. */
export function addressKey(settings: Settings): Buffer {
  return derive(settings.databaseUrl, 'ip v1');
}

/** A private link's token: 32 random bytes as 43 base64url characters. Only its SHA-256 is ever stored. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function isToken(text: string): boolean {
  return TOKEN_PATTERN.test(text);
}

export function tokenHash(token: string): Buffer {
  return sha256(token);
}

/**
 * The first private link of a person a claim makes, derived from the claim form's request id and the new person's id. A
 * repeated POST of the same form can then answer with the same link, although the database holds only the link's hash
 * and the request id's hash. The person's id is part of it because ids are never reused: a form sent again after its
 * sign-up is gone makes a person with another id, so it gets a link no one has had, and a link that was replaced (by a
 * random one, newToken) or whose person was removed can never be issued again.
 */
export function firstLinkToken(settings: Settings, requestId: string, personId: string): string {
  return createHmac('sha256', linkKey(settings)).update(`edit-link\0${requestId}\0${personId}`).digest('base64url');
}

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The request id the server writes into each claim form: a v4 UUID. */
export function newRequestId(): string {
  return randomUUID();
}

/** The request id a form sent back, or null unless it is a v4 UUID. */
export function requestIdFrom(text: string): string | null {
  const id = text.trim().toLowerCase();
  return REQUEST_ID.test(id) ? id : null;
}

/** What signups.request_hash stores: never the request id itself, from which a first link could be derived. */
export function requestHash(requestId: string): Buffer {
  return sha256(requestId);
}
