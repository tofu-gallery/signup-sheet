// GET /organizer/reminder.ics?day=thu&time=18:00: "Remind me each week" (ics.ts reminderCalendar), a repeating event in
// the organizer's own calendar until the day after the last date still ahead on an open sheet, its SEQUENCE the reminder
// revision (it grows with every change that can move that day, a shorter season included). The app sends nothing: the
// calendar does the reminding. Organizer only: anyone else is sent to /organizer (303). A day or time it can't use is
// 400; with no date ahead on any open sheet, a 404 that says so.
import { REMINDER_DAYS, reminderCalendar } from '../../../lib/ics';
import { expectedOrigin } from '../../../lib/guard';
import { download, sentencePage } from '../../../lib/responses';
import { answering, organizerGet } from '../../../lib/routes';
import { civilToday, parseTime } from '../../../lib/time';
import { reminderSeason } from '../../../lib/views';
import { words } from '../../../words';

export const dynamic = 'force-dynamic';

export const GET = answering('reminder file', async (request: Request) => {
  const organizer = await organizerGet(request);
  if (organizer instanceof Response) return organizer;
  const query = new URL(request.url).searchParams;
  const wanted = (query.get('day') ?? 'thu').toLowerCase();
  const day = REMINDER_DAYS.find((each) => each === wanted);
  const typed = query.get('time') ?? '18:00';
  const time = /^[0-9]{2}:[0-9]{2}$/.test(typed) ? parseTime(typed) : null;
  if (!day || !time) return sentencePage(400, words.ics.badReminder);
  const origin = expectedOrigin(request.headers);
  const season = await reminderSeason(organizer.pool);
  if (!origin || !season) return sentencePage(404, words.ics.nothingToRemind);
  const now = new Date();
  const calendar = reminderCalendar({
    day,
    time,
    today: civilToday(season.timezone, now),
    lastDate: season.lastDate,
    sequence: season.revision,
    host: origin.host,
    organizerLink: `${origin.origin}/organizer`,
    now
  });
  return download(calendar, 'text/calendar; charset=utf-8', 'sign-up-reminder.ics');
});
