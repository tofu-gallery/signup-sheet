// GET /me/<token>/calendar/<signupId>.ics: one of the person's own sign-ups as a calendar file (ics.ts). Calendar apps
// send no cookie, so the link's token is in the address. Only the person's own confirmed sign-up has a file: a waiting
// one, another person's, one on a draft sheet, or a link that does not work all get the unknown-link 404 (G6). A date
// the organizer cancelled keeps its file, marked cancelled, so a calendar that takes it again drops the event. A GET
// writes nothing.
import { appPool } from '../../../../../lib/db';
import { expectedOrigin } from '../../../../../lib/guard';
import { eventFileName, personCalendar } from '../../../../../lib/ics';
import { memberByToken } from '../../../../../lib/identity';
import { download, sentencePage } from '../../../../../lib/responses';
import { answering, linkMissed, type Params } from '../../../../../lib/routes';
import { myCalendarEntry } from '../../../../../lib/views';
import { words } from '../../../../../words';

export const dynamic = 'force-dynamic';

const FILE = /^([1-9][0-9]{0,17})\.ics$/;

export const GET = answering('calendar file', async (request: Request, context: Params<'token' | 'file'>) => {
  const { token, file } = await context.params;
  const pool = appPool();
  const member = await memberByToken(pool, token);
  if (!member) return linkMissed(request, pool);
  const signupId = FILE.exec(file)?.[1];
  const entry = signupId ? await myCalendarEntry(pool, member.id, signupId) : null;
  const origin = expectedOrigin(request.headers);
  if (!entry || entry.status !== 'confirmed' || !origin) return sentencePage(404, words.member.unknownLink);
  const links = { host: origin.host, privateLink: `${origin.origin}/me/${token}`, sheetLink: `${origin.origin}/s/${entry.sheetSlug}` };
  return download(personCalendar([entry], () => links, new Date()), 'text/calendar; charset=utf-8', eventFileName(entry.sheetSlug, entry.onDate));
});
