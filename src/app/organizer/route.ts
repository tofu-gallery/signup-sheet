// GET /organizer: for the signed-in organizer, the dashboard (pages/organizer.ts): Needs attention first, what is coming
// up, the sheets, the group invite and the weekly reminder. For anyone else, the page for the access state: the setup
// page while setup is open (a GET never takes the seat), the held-elsewhere page, the sign-in form while a password is
// saved, or the sentence for a locked state. The organizer check is the first query.
import { organizerAccess, requireOrganizer } from '../../lib/access';
import { htmlResponse } from '../../lib/page';
import { dashboardShell, stateShell } from '../../lib/pages/organizer';
import { answering, pageContext, pathId } from '../../lib/routes';
import { readSettings } from '../../lib/settings';
import { organizerHome, organizerSignup } from '../../lib/views';

export const dynamic = 'force-dynamic';

export const GET = answering('organizer page', async (request: Request) => {
  const context = pageContext(request);
  const settings = readSettings();
  const signedIn = await requireOrganizer(context.pool, context.headers, settings);
  if (!signedIn) return htmlResponse(200, stateShell(await organizerAccess(context.pool, settings), context.query));
  const home = await organizerHome(context.pool);
  const toldId = pathId(context.query.get('told') ?? undefined);
  const told = toldId ? await organizerSignup(context.pool, toldId) : null;
  return htmlResponse(
    200,
    dashboardShell({ home, organizer: signedIn.organizer, access: signedIn.access, origin: context.origin, query: context.query, told, now: context.now })
  );
});
