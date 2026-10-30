// GET /me/<token>/calendar.ics: every confirmed sign-up of the person's own from today on, in one calendar file (ics.ts),
// cancelled dates marked cancelled. A link that does not work gets the unknown-link 404; with nothing ahead, a 404 that
// says so. A GET writes nothing.
import { appPool } from '../../../../lib/db';
import { expectedOrigin } from '../../../../lib/guard';
import { personCalendar } from '../../../../lib/ics';
import { memberByToken } from '../../../../lib/identity';
import { download, sentencePage } from '../../../../lib/responses';
import { answering, linkMissed, type Params } from '../../../../lib/routes';
import { myUpcomingCalendar } from '../../../../lib/views';
import { words } from '../../../../words';

export const dynamic = 'force-dynamic';

export const GET = answering('calendar file', async (request: Request, context: Params<'token'>) => {
  const { token } = await context.params;
  const pool = appPool();
  const member = await memberByToken(pool, token);
  if (!member) return linkMissed(request, pool);
  const origin = expectedOrigin(request.headers);
  if (!origin) return sentencePage(404, words.member.unknownLink);
  const entries = await myUpcomingCalendar(pool, member.id);
  if (entries.length === 0) return sentencePage(404, words.ics.noneUpcoming);
  const calendar = personCalendar(
    entries,
    (entry) => ({ host: origin.host, privateLink: `${origin.origin}/me/${token}`, sheetLink: `${origin.origin}/s/${entry.sheetSlug}` }),
    new Date()
  );
  return download(calendar, 'text/calendar; charset=utf-8', 'my-sign-ups.ics');
});
