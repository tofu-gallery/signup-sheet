import assert from 'node:assert/strict';
import { rootCertificates } from 'node:tls';
import { test } from 'node:test';
import { CONFIG_SENTENCES, connectionSettings, DatabaseConfigError } from '../../scripts/tofu-database.mjs';

const CA = '-----BEGIN CERTIFICATE-----\nnot-a-real-certificate\n-----END CERTIFICATE-----';
// A synthetic, test-only credential: it must never appear in an error.
const URL_WITH_PASSWORD = 'postgresql://postgres.abc:Sup3r%40secret-test-only@db.example.test:6543/postgres';

function refusal(env: Record<string, string>): string {
  try {
    connectionSettings(env);
  } catch (error) {
    assert.ok(error instanceof DatabaseConfigError);
    return error.message;
  }
  assert.fail('expected a refusal');
}

test('sslmode=require: the URL loses its TLS parameters and TLS verifies against Node roots plus the CA', () => {
  const settings = connectionSettings({ DATABASE_URL: `${URL_WITH_PASSWORD}?sslmode=require&application_name=x`, SUPABASE_CA_CERT: CA });
  assert.equal(settings.connectionString, `${URL_WITH_PASSWORD}?application_name=x`);
  assert.ok(settings.ssl);
  assert.equal(settings.ssl.rejectUnauthorized, true);
  assert.equal(settings.ssl.ca.length, rootCertificates.length + 1);
  assert.equal(settings.ssl.ca.at(-1), CA);
});

test('every TLS mode, no-verify and prefer included, becomes a verified connection', () => {
  for (const query of ['sslmode=no-verify', 'sslmode=prefer', 'sslmode=verify-full', 'ssl=true', 'ssl=1', 'sslrootcert=/x.crt', 'sslcert=/c&sslkey=/k']) {
    const settings = connectionSettings({ DATABASE_URL: `${URL_WITH_PASSWORD}?${query}`, SUPABASE_CA_CERT: CA });
    assert.equal(settings.ssl?.rejectUnauthorized, true, query);
    assert.ok(!/ssl/i.test(new URL(settings.connectionString).search), query);
  }
});

test('a URL that asks for no TLS gets none and needs no CA', () => {
  for (const url of [URL_WITH_PASSWORD, `${URL_WITH_PASSWORD}?sslmode=disable`, `${URL_WITH_PASSWORD}?ssl=false`]) {
    const settings = connectionSettings({ DATABASE_URL: url });
    assert.equal(settings.ssl, undefined, url);
    assert.ok(!settings.connectionString.includes('ssl'), url);
  }
});

test('sslmode without SUPABASE_CA_CERT is refused before connecting, with the exact sentence', () => {
  assert.equal(refusal({ DATABASE_URL: `${URL_WITH_PASSWORD}?sslmode=require` }), CONFIG_SENTENCES.missingCa);
  assert.equal(refusal({ DATABASE_URL: `${URL_WITH_PASSWORD}?sslmode=require`, SUPABASE_CA_CERT: '  \n' }), CONFIG_SENTENCES.missingCa);
  assert.equal(CONFIG_SENTENCES.missingCa, "SUPABASE_CA_CERT is not set: it is needed to check the database server's certificate.");
});

test('a URL that is not a PostgreSQL URL is refused without echoing it', () => {
  for (const url of ['not a url', 'mysql://u:Sup3r%40secret-test-only@h/d', 'postgresql:///nohost', 'http://u:Sup3r%40secret-test-only@h/d']) {
    const message = refusal({ DATABASE_URL: url });
    assert.equal(message, 'DATABASE_URL must be a PostgreSQL URL.');
    assert.ok(!message.includes('secret'));
  }
  assert.equal(refusal({}), CONFIG_SENTENCES.missingUrl);
});
