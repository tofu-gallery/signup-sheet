// GET /organizer/sheets/<slug>/export.csv: the sheet's spreadsheet to save (csv.ts): a row per sign-up with contacts,
// notes and paid state. Organizer only: anyone else is sent to /organizer (303). An unknown sheet is 404.
import { sheetCsv } from '../../../../../lib/csv';
import { download } from '../../../../../lib/responses';
import { answering, notFound, organizerGet, type Params, pathSlug } from '../../../../../lib/routes';

export const dynamic = 'force-dynamic';

export const GET = answering('spreadsheet', async (request: Request, context: Params<'slug'>) => {
  const organizer = await organizerGet(request);
  if (organizer instanceof Response) return organizer;
  const slug = pathSlug((await context.params).slug);
  const csv = slug ? await sheetCsv(organizer.pool, slug) : null;
  if (!slug || csv === null) return notFound();
  return download(csv, 'text/csv; charset=utf-8', `${slug}-${new Date().toISOString().slice(0, 10)}.csv`);
});
