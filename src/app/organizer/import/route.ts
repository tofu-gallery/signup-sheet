// GET /organizer/import: the import page (pages/group.ts), a box for the file with "Check this file" and "Import it".
// POST /organizer/import: checks a signup-sheet/1 file (a dry run) or imports it (importer.ts; see TOFU.md, Import and
// export).
//
// Two ways in, told apart by Content-Type:
// - JSON (application/json: an agent, the live check). The body is the file, at most 512 KB, and the file's own
//   `dryRun` decides (without one, it imports). Every answer is JSON: 200 {ok: true, dryRun, summary, counts}, or
//   {ok: false, error, path}, `error` being one sentence that ends "Nothing was imported." and `path` the field it is
//   about (or null).
// - The import page's form (application/x-www-form-urlencoded): `json` (the file, at most 512 KB once decoded), `action`
//   (`import` imports; anything else checks) and `rid`, the page's request id, needed to import: a second press of the
//   button imports nothing more (409). Every answer is the import page again, its box keeping the file; once a file is
//   imported, with a link to each sheet it made.
// In this order: the Origin guard (403), the organizer (401 JSON, 403 the form), the copy's import limit (30 an hour,
// 429), the media type (415), the size (413), then the file. A refused file answers 400, and nothing at all is written.
import { type Organizer, organizerRefusal, requireOrganizer } from '../../../lib/access';
import { appPool } from '../../../lib/db';
import { expectedOrigin, guarded } from '../../../lib/guard';
import { browserFor } from '../../../lib/identity';
import { type ImportOutcome, runImport } from '../../../lib/importer';
import { logFailure } from '../../../lib/log';
import { htmlResponse } from '../../../lib/page';
import { importShell } from '../../../lib/pages/group';
import { field, IMPORT_FORM_LIMIT_BYTES, IMPORT_LIMIT_BYTES, mediaType, readForm, readText, RequestRefused } from '../../../lib/request';
import { failureAnswer, PRIVATE, sentencePage } from '../../../lib/responses';
import { answering, organizerGet } from '../../../lib/routes';
import { readSettings } from '../../../lib/settings';
import { copyKey, LIMITS, overLimit, pruneSometimes } from '../../../lib/throttle';
import { newRequestId, requestIdFrom } from '../../../lib/tokens';
import { words } from '../../../words';

export const dynamic = 'force-dynamic';

const FORM = 'application/x-www-form-urlencoded';

export const POST = guarded(async (request: Request) => {
  const json = mediaType(request.headers) !== FORM;
  const cookies: string[] = [];
  // The import page shown again: who is signed in, the file as sent and the page's request id (kept, so pressing Import
  // it again imports nothing more; a new one when the form had none).
  let organizer: Organizer | null = null;
  let text = '';
  let rid: string | null = null;
  const answer = (status: number, outcome: ImportOutcome, headers: Record<string, string> = {}): Response => {
    if (!json) {
      if (!organizer) return sentencePage(status, outcome.ok ? outcome.summary : outcome.error, headers, cookies);
      return htmlResponse(status, importShell({ organizer, text, rid: rid ?? newRequestId(), outcome }), { headers, cookies });
    }
    const all = new Headers({ ...PRIVATE, ...headers });
    for (const cookie of cookies) all.append('Set-Cookie', cookie);
    // The JSON answer keeps its four fields; the sheets' list is for the page's links only.
    const body = outcome.ok ? { ok: true, dryRun: outcome.dryRun, summary: outcome.summary, counts: outcome.counts } : outcome;
    return Response.json(body, { status, headers: all });
  };
  const refused = (status: number, sentence: string, headers: Record<string, string> = {}) =>
    answer(status, { ok: false, error: sentence, path: null }, headers);

  try {
    const pool = appPool();
    const signedIn = await requireOrganizer(pool, request.headers, readSettings());
    if (!signedIn) return organizerRefusal(json ? 'json' : 'form');
    organizer = signedIn.organizer;
    const browser = browserFor(request.headers, expectedOrigin(request.headers)?.scheme ?? 'https');
    if (browser.setCookie) cookies.push(browser.setCookie);
    if (await overLimit(pool, copyKey('import'), LIMITS.importPerCopy)) return refused(429, words.throttle.import);

    let dryRun: boolean | null = null;
    let requestId: string | null = null;
    if (json) {
      if (mediaType(request.headers) !== 'application/json') return refused(415, words.import.formUnsupported);
      text = await readText(request, IMPORT_LIMIT_BYTES);
    } else {
      const form = await readForm(request, IMPORT_FORM_LIMIT_BYTES);
      text = field(form, 'json');
      rid = requestIdFrom(field(form, 'rid'));
      dryRun = field(form, 'action') !== 'import';
      if (!dryRun) {
        requestId = requestIdFrom(field(form, 'rid'));
        if (!requestId) return refused(400, words.formErrors.form);
      }
    }

    const outcome = await runImport(pool, text, { dryRun, requestId, ctx: { actor: 'organizer', browser: browser.id } });
    if (outcome.ok && !outcome.dryRun) {
      try {
        await pruneSometimes(pool);
      } catch (error) {
        logFailure('prune', error);
      }
    }
    return answer(outcome.ok ? 200 : outcome.repeated ? 409 : 400, outcome);
  } catch (error) {
    if (error instanceof RequestRefused) {
      if (error.status === 413) return refused(413, `${words.import.tooBig} ${words.import.nothingImported}`);
      if (error.status === 415) return refused(415, words.import.formUnsupported);
      return refused(400, `${words.import.unreadable} ${words.import.nothingImported}`);
    }
    const failure = failureAnswer('import', error);
    return refused(failure.status, failure.sentence, failure.retryAfter ? { 'Retry-After': failure.retryAfter } : {});
  }
});

export const GET = answering('import page', async (request: Request) => {
  const signedIn = await organizerGet(request);
  if (signedIn instanceof Response) return signedIn;
  return htmlResponse(200, importShell({ organizer: signedIn.signedIn.organizer, text: '', rid: newRequestId(), outcome: null }));
});
