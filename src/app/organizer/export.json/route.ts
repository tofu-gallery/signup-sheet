// GET /organizer/export.json: the whole copy as one signup-sheet/1 file to save (exporter.ts; see TOFU.md, Import and
// export), read at one instant. Organizer only: anyone else is sent to /organizer (303). It carries contacts and paid
// state, and never a link or a hash. A GET writes nothing.
//
// The JSON is written without indentation: an import takes at most 512 KB, and indenting it makes the same file about
// 70% larger, so a copy at the import's own limits (500 people, 2,000 sign-ups) would no longer import back.
import { exportCopy } from '../../../lib/exporter';
import { download } from '../../../lib/responses';
import { answering, organizerGet } from '../../../lib/routes';

export const dynamic = 'force-dynamic';

export const GET = answering('export', async (request: Request) => {
  const organizer = await organizerGet(request);
  if (organizer instanceof Response) return organizer;
  const now = new Date();
  const file = await exportCopy(organizer.pool, now);
  return download(`${JSON.stringify(file)}\n`, 'application/json; charset=utf-8', `signup-sheet-${now.toISOString().slice(0, 10)}.json`);
});
