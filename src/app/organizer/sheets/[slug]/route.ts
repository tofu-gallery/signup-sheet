// GET /organizer/sheets/<slug>: one sheet for the organizer (pages/sheet-admin.ts): every date and place with the people
// on it (contacts, notes, who added them and when, the waitlist in order), the changes for each, who to tell after a
// move, a swap, a new day or a cancelled date, and the share buttons. Anyone else is sent to /organizer.
import { htmlResponse } from '../../../../lib/page';
import { sheetAdminShell } from '../../../../lib/pages/sheet-admin';
import { answering, notFound, organizerGet, pageContext, type Params, pathId, pathSlug } from '../../../../lib/routes';
import { organizerSignup, organizerView } from '../../../../lib/views';

export const dynamic = 'force-dynamic';

export const GET = answering('organizer sheet page', async (request: Request, context: Params<'slug'>) => {
  const organizer = await organizerGet(request);
  if (organizer instanceof Response) return organizer;
  const slug = pathSlug((await context.params).slug);
  const sheet = slug ? await organizerView(organizer.pool, slug) : null;
  if (!sheet) return notFound();
  const page = pageContext(request);
  const toldId = pathId(page.query.get('told') ?? undefined);
  const told = toldId ? await organizerSignup(organizer.pool, toldId) : null;
  return htmlResponse(
    200,
    sheetAdminShell({ organizer: organizer.signedIn.organizer, sheet, origin: page.origin, query: page.query, told: told ? { id: told.id, name: told.name } : null, now: page.now })
  );
});
