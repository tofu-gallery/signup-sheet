// GET /organizer/sheets/<slug>/share/week: this week's reminder (share.ts weekText), made from the public sheet only
// (names, or "Taken", and open places; never a contact), with WhatsApp, Text, Email, Copy and Share, and one email to
// everyone signed up who gave an address (bcc).
import { htmlResponse } from '../../../../../../lib/page';
import { weekShareShell } from '../../../../../../lib/pages/sheet-admin';
import { answering, notFound, organizerGet, pageContext, type Params, pathSlug } from '../../../../../../lib/routes';
import { organizerView, publicSheetView } from '../../../../../../lib/views';

export const dynamic = 'force-dynamic';

export const GET = answering('week share page', async (request: Request, context: Params<'slug'>) => {
  const organizer = await organizerGet(request);
  if (organizer instanceof Response) return organizer;
  const slug = pathSlug((await context.params).slug);
  const sheet = slug ? await publicSheetView(organizer.pool, slug, { draft: true }) : null;
  const admin = slug ? await organizerView(organizer.pool, slug) : null;
  if (!sheet || !admin) return notFound();
  const page = pageContext(request);
  return htmlResponse(200, weekShareShell(organizer.signedIn.organizer, sheet, admin, page.origin, page.now));
});
