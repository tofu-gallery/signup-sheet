// GET /organizer/sheets/new: the new sheet's form (it posts to /organizer/sheets). "new" is never a sheet's slug.
import { htmlResponse } from '../../../../lib/page';
import { NEW_SHEET, newSheetShell } from '../../../../lib/pages/sheet-admin';
import { answering, organizerGet, pageContext } from '../../../../lib/routes';

export const dynamic = 'force-dynamic';

export const GET = answering('new sheet page', async (request: Request) => {
  const organizer = await organizerGet(request);
  if (organizer instanceof Response) return organizer;
  return htmlResponse(200, newSheetShell(organizer.signedIn.organizer, NEW_SHEET, pageContext(request).query.get('e')));
});
