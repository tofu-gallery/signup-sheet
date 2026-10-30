// Reading request bodies within fixed limits (see TOFU.md, Requests): form posts up to 16 KB, the JSON import up to
// 512 KB, checked against Content-Length and against the bytes actually read. The import page's form carries the same
// file percent-encoded, which can triple it, so that one form may be larger; the file in it is then held to 512 KB.

export const FORM_LIMIT_BYTES = 16 * 1024;
export const IMPORT_LIMIT_BYTES = 512 * 1024;
export const IMPORT_FORM_LIMIT_BYTES = 3 * IMPORT_LIMIT_BYTES + FORM_LIMIT_BYTES;
const MAX_FIELDS = 100;

/** A body the app will not read: 400 (malformed), 413 (too big) or 415 (not a plain form post). */
export class RequestRefused extends Error {
  constructor(readonly status: 400 | 413 | 415) {
    super(`request refused with ${status}`);
    this.name = 'RequestRefused';
  }
}

export async function readBytes(request: Request, limit: number): Promise<Uint8Array> {
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    if (!/^[0-9]{1,15}$/.test(declared.trim())) throw new RequestRefused(400);
    if (Number(declared) > limit) throw new RequestRefused(413);
  }
  if (!request.body) return new Uint8Array(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw new RequestRefused(413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** The request's media type, lowercase and without parameters ('' when there is none). */
export function mediaType(headers: Headers): string {
  return (headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

/**
 * A plain HTML form post (application/x-www-form-urlencoded, valid UTF-8, at most `limit` bytes, 16 KB unless said, and
 * 100 fields).
 */
export async function readForm(request: Request, limit = FORM_LIMIT_BYTES): Promise<URLSearchParams> {
  if (mediaType(request.headers) !== 'application/x-www-form-urlencoded') throw new RequestRefused(415);
  const form = new URLSearchParams(utf8(await readBytes(request, limit)));
  let fields = 0;
  for (const _ of form.keys()) if (++fields > MAX_FIELDS) throw new RequestRefused(400);
  return form;
}

/**
 * A body as UTF-8 text, at most `limit` bytes. The import reads its JSON with its own strict reader (import-format.ts),
 * never JSON.parse, which keeps the last of two fields with the same name without a word.
 */
export async function readText(request: Request, limit = IMPORT_LIMIT_BYTES): Promise<string> {
  return utf8(await readBytes(request, limit));
}

/** A form field's first value, or '' when it is missing. */
export function field(form: URLSearchParams, name: string): string {
  return form.get(name) ?? '';
}

function utf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new RequestRefused(400);
  }
}
