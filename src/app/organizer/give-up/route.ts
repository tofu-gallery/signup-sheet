// POST /organizer/give-up ("Give up setup"): the seat holder ends the seat at once; the state becomes locked-expired and
// the seat never reopens. Only the browser holding the seat can do it.
import { giveUpSeat, organizerRefusal } from '../../../lib/access';
import { clearCookie, readCookie } from '../../../lib/cookies';
import { appPool } from '../../../lib/db';
import { expectedOrigin, guarded } from '../../../lib/guard';
import { readForm } from '../../../lib/request';
import { seeOther } from '../../../lib/responses';

export const dynamic = 'force-dynamic';

export const POST = guarded(async (request: Request) => {
  await readForm(request);
  const scheme = expectedOrigin(request.headers)?.scheme ?? 'https';
  const ended = await giveUpSeat(appPool(), readCookie(request.headers, 'ss_org', scheme));
  if (!ended) return organizerRefusal('form');
  return seeOther('/organizer', [clearCookie('ss_org', scheme)]);
});
