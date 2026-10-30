import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseConfigError } from '../../scripts/tofu-database.mjs';

test('importing the database module reads no setting and opens no connection', async () => {
  const saved = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const db = await import('../../src/lib/db');
    assert.equal((globalThis as { signupSheetPool?: unknown }).signupSheetPool, undefined);
    assert.throws(() => db.appPool(), (error: unknown) => error instanceof DatabaseConfigError);
    assert.equal((globalThis as { signupSheetPool?: unknown }).signupSheetPool, undefined, 'a failed setting leaves no pool');
  } finally {
    if (saved !== undefined) process.env.DATABASE_URL = saved;
  }
});

test('failures that are not from PostgreSQL itself are classified without reading their messages for data', async () => {
  const { dbFailure, StillBusy } = await import('../../src/lib/db');
  assert.equal(dbFailure(new DatabaseConfigError('DATABASE_URL must be a PostgreSQL URL.')), 'unavailable');
  assert.equal(dbFailure(new StillBusy()), 'busy');
  assert.equal(dbFailure(new Error('Query read timeout')), 'unavailable');
  assert.equal(dbFailure(new Error('timeout exceeded when trying to connect')), 'unavailable');
  assert.equal(dbFailure(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED', syscall: 'connect' })), 'unavailable');
  assert.equal(dbFailure(Object.assign(new Error('self-signed certificate in certificate chain'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' })), 'unavailable');
  // A bug is not an outage.
  assert.equal(dbFailure(Object.assign(new TypeError('bad argument'), { code: 'ERR_INVALID_ARG_TYPE' })), 'error');
  assert.equal(dbFailure(new TypeError('x is undefined')), 'error');
  assert.equal(dbFailure('a string'), 'error');
});
