// GET /organizer/sheets/<slug>/share/waitlist: "Message the waitlist" (share.ts waitlistMessages): one message to all of
// them (with one bcc email), and one to each person, sent to their own contact.
import { htmlResponse } from '../../../../../../lib/page';
import { waitlistShareShell } from '../../../../../../lib/pages/sheet-admin';
import { answering, notFound, organizerGet, pageContext, type Params, pathSlug } from '../../../../../../lib/routes';
import { organizerView } from '../../../../../../lib/views';

export const dynamic = 'force-dynamic';

export const GET = answering('waitlist share page', async (request: Request, context: Params<'slug'>) => {
  const organizer = await organizerGet(request);
  if (organizer instanceof Response) return organizer;
  const slug = pathSlug((await context.params).slug);
  const sheet = slug ? await organizerView(organizer.pool, slug) : null;
  if (!sheet) return notFound();
  const page = pageContext(request);
  return htmlResponse(200, waitlistShareShell(organizer.signedIn.organizer, sheet, page.origin, page.now));
});
