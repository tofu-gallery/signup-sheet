// GET /: always 200 for a healthy copy, never a redirect (TOFU.md, Pages). With one open listed sheet, that sheet in
// place (its own address as canonical); with several, a list; with none, the setup page while setup is open, else the
// empty page. A database that cannot be reached answers 503 (answering). An open sheet means the copy has had an
// organizer, so the setup state is read only when there is none.
import { organizerAccess } from '../lib/access';
import { htmlResponse } from '../lib/page';
import { sheetResponse } from '../lib/pages/load';
import { homeShell, setupShell } from '../lib/pages/public';
import { answering, pageContext } from '../lib/routes';
import { readSettings } from '../lib/settings';
import { groupView, listedOpenSheets } from '../lib/views';

export const dynamic = 'force-dynamic';

export const GET = answering('home page', async (request: Request) => {
  const context = pageContext(request);
  const sheets = await listedOpenSheets(context.pool);
  if (sheets.length === 1) {
    const page = await sheetResponse(context, sheets[0]!.slug, { inPlace: true });
    if (page) return page;
  }
  if (sheets.length === 0 && (await organizerAccess(context.pool, readSettings())).state === 'setup-open') {
    return htmlResponse(200, setupShell());
  }
  const group = await groupView(context.pool);
  return htmlResponse(200, homeShell(group.groupName, group.organizerName, sheets, context.now));
});
