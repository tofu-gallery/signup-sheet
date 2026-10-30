// GET /me: the person's own page (pages/member.ts), from the link in their cookie: their name and contact, every sign-up,
// calendar buttons for the confirmed ones, and their private link. `new=` shows the after-claim panel, `open=` the
// message asking the group to take a place they left, `cancelled=` (with `sheet=` and `up=`) what a cancel did and the
// way back to the sheet. No cookie: 200 with how to get in; a cookie that no longer works: the unknown-link 404,
// clearing it. Generic titles; a link preview names nobody.
import { appPool } from '../../lib/db';
import { htmlResponse } from '../../lib/page';
import { meShell, noCookieShell } from '../../lib/pages/member';
import { sentencePage } from '../../lib/responses';
import { answering, memberPage, pathId } from '../../lib/routes';
import { groupView, meView, myUpcomingCalendar, slotWords } from '../../lib/views';
import { words } from '../../words';

export const dynamic = 'force-dynamic';

export const GET = answering('member page', async (request: Request) => {
  const member = await memberPage(request);
  if (member instanceof Response) return member;
  // No cookie: the page says where the link is, with the public footer (the organizer's name, never a contact).
  if (!member) return htmlResponse(200, noCookieShell((await groupView(appPool())).organizerName));
  const view = await meView(member.pool, member.personId);
  if (!view) return sentencePage(404, words.member.unknownLink);
  const calendar = await myUpcomingCalendar(member.pool, member.personId, member.now);
  const openSlot = pathId(member.query.get('open') ?? undefined);
  const left = openSlot ? await slotWords(member.pool, openSlot) : null;
  return htmlResponse(
    200,
    meShell({
      view,
      token: member.token,
      origin: member.origin,
      query: member.query,
      calendar,
      android: /Android/i.test(request.headers.get('user-agent') ?? ''),
      askGroup: left && left.sheetStatus === 'open' ? left : null,
      now: member.now
    })
  );
});
