import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  field,
  FORM_LIMIT_BYTES,
  IMPORT_FORM_LIMIT_BYTES,
  IMPORT_LIMIT_BYTES,
  mediaType,
  readForm,
  readText,
  RequestRefused
} from '../../src/lib/request';

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

function post(body: BodyInit | null, headers: Record<string, string> = FORM): Request {
  return new Request('https://x.test/p', { method: 'POST', headers, body, duplex: 'half' } as RequestInit);
}

async function refusedWith(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof RequestRefused);
    return error.status;
  }
  assert.fail('expected a refusal');
}

test('a plain form post is read, first value per field', async () => {
  const form = await readForm(post('name=The+Mike+family&note=Bringing%20oranges&name=second'));
  assert.equal(field(form, 'name'), 'The Mike family');
  assert.equal(field(form, 'note'), 'Bringing oranges');
  assert.equal(field(form, 'missing'), '');
});

test('a form over 16 KB is refused by Content-Length and by the bytes actually read', async () => {
  const big = `name=${'a'.repeat(FORM_LIMIT_BYTES)}`;
  assert.equal(await refusedWith(readForm(post(big))), 413);
  // No Content-Length: a stream that keeps going.
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      sent += 1024;
      controller.enqueue(new TextEncoder().encode('a'.repeat(1024)));
      if (sent > 64 * 1024) controller.close();
    }
  });
  assert.equal(await refusedWith(readForm(post(stream))), 413);
  assert.ok(sent < 64 * 1024, 'reading stopped soon after the limit');
});

test('anything but a urlencoded form, invalid UTF-8, or too many fields is refused', async () => {
  assert.equal(await refusedWith(readForm(post('a=b', { 'content-type': 'multipart/form-data; boundary=x' }))), 415);
  assert.equal(await refusedWith(readForm(post('a=b', {}))), 415);
  assert.equal(await refusedWith(readForm(post(new Uint8Array([0x61, 0x3d, 0xff, 0xfe])))), 400);
  assert.equal(await refusedWith(readForm(post(Array.from({ length: 101 }, (_, i) => `f${i}=1`).join('&')))), 400);
  assert.equal(await refusedWith(readForm(post('a=b', { ...FORM, 'content-length': 'nope' }))), 400);
});

test('a JSON body is read as text up to its limit, and only as valid UTF-8', async () => {
  const json = { 'content-type': 'application/json' };
  assert.equal(await readText(post('{"format":"signup-sheet/1"}', json)), '{"format":"signup-sheet/1"}');
  assert.equal(await refusedWith(readText(post(new Uint8Array([0x7b, 0xff]), json))), 400);
  assert.equal(await refusedWith(readText(post(`"${'x'.repeat(100)}"`, json), 50)), 413);
  assert.equal(await refusedWith(readText(post('{}', { ...json, 'content-length': String(IMPORT_LIMIT_BYTES + 1) }))), 413);
});

test("the import page's form may be larger than other forms; its media type is read without parameters", async () => {
  const file = `json=${'%7B'.repeat(IMPORT_LIMIT_BYTES / 2)}&action=check`;
  assert.equal(await refusedWith(readForm(post(file))), 413);
  assert.equal(field(await readForm(post(file), IMPORT_FORM_LIMIT_BYTES), 'action'), 'check');
  assert.equal(mediaType(new Headers({ 'content-type': 'Application/JSON; charset=utf-8' })), 'application/json');
  assert.equal(mediaType(new Headers()), '');
});
