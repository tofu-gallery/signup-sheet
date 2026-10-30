import assert from 'node:assert/strict';
import { test } from 'node:test';
import { absoluteUrl, expectedOrigin, guarded, localPath, originAllowed } from '../../src/lib/guard';
import { words } from '../../src/words';

const COPY = { host: 'sign-up-sheet-ab12cd.trytofu.app', 'x-forwarded-proto': 'https' };

function headers(extra: Record<string, string>): Headers {
  return new Headers({ ...COPY, ...extra });
}

test('the expected origin comes from the first forwarded entries, normalized', () => {
  assert.equal(expectedOrigin(headers({}))?.origin, 'https://sign-up-sheet-ab12cd.trytofu.app');
  assert.equal(
    expectedOrigin(new Headers({ host: 'internal:3000', 'x-forwarded-host': 'Copy.TryTofu.App, proxy.local', 'x-forwarded-proto': 'https, http' }))?.origin,
    'https://copy.trytofu.app'
  );
  assert.equal(expectedOrigin(new Headers({ host: 'example.test:443' }))?.origin, 'https://example.test');
  assert.equal(expectedOrigin(new Headers({ host: 'localhost:3000' }))?.origin, 'http://localhost:3000');
  assert.equal(expectedOrigin(new Headers({ host: '127.0.0.1:3000' }))?.scheme, 'http');
  assert.equal(expectedOrigin(new Headers({ host: 'localhost:3000', 'x-forwarded-proto': 'https' }))?.scheme, 'https');
});

test('a host or proto that is not plain gives no expected origin', () => {
  const odd: Record<string, string>[] = [{ host: 'evil.test/path' }, { host: 'a b' }, { host: '' }, { 'x-forwarded-proto': 'javascript' }, { host: 'x'.repeat(300) }];
  for (const extra of odd) {
    assert.equal(expectedOrigin(new Headers({ host: 'ok.test', ...extra })), null, JSON.stringify(extra));
  }
});

test('Origin must equal this copy exactly; without Origin only Sec-Fetch-Site: same-origin passes', () => {
  assert.equal(originAllowed(headers({ origin: 'https://sign-up-sheet-ab12cd.trytofu.app' })), true);
  assert.equal(originAllowed(headers({ origin: 'https://SIGN-UP-SHEET-AB12CD.trytofu.app:443' })), true);
  assert.equal(originAllowed(headers({ 'sec-fetch-site': 'same-origin' })), true);

  const refusals: Record<string, string>[] = [
    { origin: 'https://evil.trytofu.app' },
    { origin: 'http://sign-up-sheet-ab12cd.trytofu.app' },
    { origin: 'https://sign-up-sheet-ab12cd.trytofu.app.evil.test' },
    { origin: 'null' },
    { origin: 'null', 'sec-fetch-site': 'same-origin' },
    { origin: '' },
    { 'sec-fetch-site': 'same-site' },
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'none' },
    {}
  ];
  for (const refused of refusals) {
    assert.equal(originAllowed(headers(refused)), false, JSON.stringify(refused));
  }
  assert.equal(originAllowed(new Headers({ origin: 'https://x.test' })), false, 'no host at all');
});

test('guarded() refuses before the handler runs, with 403 and the sentence; the right Origin reaches it', async () => {
  let calls = 0;
  const POST = guarded(async () => {
    calls += 1;
    return new Response(null, { status: 303, headers: { Location: '/me' } });
  });

  const refused = await POST(new Request('https://sign-up-sheet-ab12cd.trytofu.app/forget', { method: 'POST', headers: headers({ origin: 'https://evil.trytofu.app' }) }));
  assert.equal(refused.status, 403);
  assert.ok((await refused.text()).includes(words.originRefused.replace(/'/g, '&#39;')));
  assert.equal(calls, 0);

  const control = await POST(new Request('https://sign-up-sheet-ab12cd.trytofu.app/forget', { method: 'POST', headers: headers({ origin: 'https://sign-up-sheet-ab12cd.trytofu.app' }) }));
  assert.equal(control.status, 303);
  assert.equal(control.headers.get('cache-control'), 'private, no-store');
  assert.equal(calls, 1);
});

test('guarded() answers an error from the handler without its details', async () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (line: string) => lines.push(line);
  try {
    const POST = guarded(async () => {
      throw new Error('PRIVATE-PROBE-7 the Mike family, mike-family@example.test');
    });
    const answer = await POST(new Request('https://x.test/p', { method: 'POST', headers: { host: 'x.test', origin: 'https://x.test' } }));
    assert.equal(answer.status, 500);
    assert.ok(!(await answer.text()).includes('PROBE'));
  } finally {
    console.error = original;
  }
  assert.equal(lines.length, 1);
  assert.ok(!lines[0]!.includes('PROBE') && !lines[0]!.includes('example.test'));
});

test('localPath keeps a plain path on this copy and turns anything else into /', () => {
  for (const ok of ['/', '/s/snacks', '/s/snacks/slots/12?e=name', '/me?new=4']) assert.equal(localPath(ok), ok);
  for (const bad of ['//evil.test', '/\\evil.test', '\\\\evil.test', 'https://evil.test', '/%2F%2Fevil.test', '/%5cevil.test', '/\t/evil.test', '/ /x', 'evil.test', '', '/\n']) {
    assert.equal(localPath(bad), '/', JSON.stringify(bad));
  }
});

test('absolute links come from the validated origin', () => {
  assert.equal(absoluteUrl(headers({}), '/s/snacks'), 'https://sign-up-sheet-ab12cd.trytofu.app/s/snacks');
  assert.equal(absoluteUrl(headers({}), '//evil.test'), null);
  assert.equal(absoluteUrl(new Headers({ host: 'bad host' }), '/'), null);
});
