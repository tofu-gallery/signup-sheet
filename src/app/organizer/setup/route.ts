// POST /organizer/setup: the first browser to press Set up, within the database's first 24 hours and before any
// ORGANIZER_PASSWORD, holds the setup seat for 7 days (access.ts). Everyone else gets 403 with the sentence for the
// state. GET requests never take the seat: only this POST does.
import { organizerAccess, organizerFromCookie, setupRefusal, takeSeat } from '../../../lib/access';
import { readCookie, setCookie } from '../../../lib/cookies';
import { appPool } from '../../../lib/db';
import { expectedOrigin, guarded } from '../../../lib/guard';
import { readForm } from '../../../lib/request';
import { seeOther, sentencePage } from '../../../lib/responses';
import { readSettings } from '../../../lib/settings';
import { connectionKey, LIMITS, overLimit } from '../../../lib/throttle';
import { words } from '../../../words';

export const dynamic = 'force-dynamic';

export const POST = guarded(async (request: Request) => {
  await readForm(request);
  const pool = appPool();
  const settings = readSettings();
  const scheme = expectedOrigin(request.headers)?.scheme ?? 'https';
  if (await overLimit(pool, connectionKey('setup', request.headers, settings), LIMITS.setupPerConnection)) {
    return sentencePage(429, words.throttle.setup);
  }
  const access = await organizerAccess(pool, settings);
  if (organizerFromCookie(readCookie(request.headers, 'ss_org', scheme), access, settings)) return seeOther('/organizer');
  if (access.state !== 'setup-open') return sentencePage(403, setupRefusal(access.state));
  const seat = await takeSeat(pool, settings);
  if (!seat) return sentencePage(403, words.organizer.setupLost);
  return seeOther('/organizer', [setCookie('ss_org', seat.cookieValue, seat.maxAgeSeconds, scheme)]);
});
