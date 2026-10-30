// GET /organizer/people/<id>: one person for the organizer: their sign-ups, name and contact, paid state (once there are
// dues), whether they have a private link, and the ways to make a new one, remove them everywhere or delete them.
import { htmlResponse } from '../../../../lib/page';
import { personShell } from '../../../../lib/pages/people';
import { answering, notFound, organizerGet, pageContext, type Params, pathId } from '../../../../lib/routes';
import { groupView, personView } from '../../../../lib/views';

export const dynamic = 'force-dynamic';

export const GET = answering('person page', async (request: Request, context: Params<'id'>) => {
  const organizer = await organizerGet(request);
  if (organizer instanceof Response) return organizer;
  const personId = pathId((await context.params).id);
  const person = personId ? await personView(organizer.pool, personId) : null;
  if (!person) return notFound();
  const group = await groupView(organizer.pool);
  return htmlResponse(200, personShell(organizer.signedIn.organizer, person, group, pageContext(request).query));
});
