// POST /organizer/sign-in: the ORGANIZER_PASSWORD (state `password` only). Every try counts against the throttle in the
// database, per connection and then per copy, and a right one is refunded, so only failures add up. A connection over
// its own limit is refused before the copy's count, so its refused tries never use up the organizer's tries from
// elsewhere. A wrong password is answered after a second.
import {
  organizerAccess,
  passwordCookie,
  passwordMatches,
  signInFormShown,
  WRONG_PASSWORD_DELAY_MS
} from '../../../lib/access';
import { setCookie } from '../../../lib/cookies';
import { appPool } from '../../../lib/db';
import { expectedOrigin, guarded } from '../../../lib/guard';
import { field, readForm } from '../../../lib/request';
import { seeOther, sentencePage } from '../../../lib/responses';
import { readSettings } from '../../../lib/settings';
import { connectionKey, copyKey, LIMITS, overLimit, refund } from '../../../lib/throttle';
import { words } from '../../../words';

export const dynamic = 'force-dynamic';

export const POST = guarded(async (request: Request) => {
  const form = await readForm(request);
  const pool = appPool();
  const settings = readSettings();
  const scheme = expectedOrigin(request.headers)?.scheme ?? 'https';
  const access = await organizerAccess(pool, settings);
  if (!signInFormShown(access.state)) return seeOther('/organizer');

  const keys = [connectionKey('sign-in', request.headers, settings), copyKey('sign-in')];
  if (await overLimit(pool, keys[0]!, LIMITS.signInPerConnection)) return sentencePage(429, words.throttle.signIn);
  if (await overLimit(pool, keys[1]!, LIMITS.signInPerCopy)) return sentencePage(429, words.throttle.signIn);

  if (passwordMatches(field(form, 'password'), settings)) {
    await refund(pool, keys);
    const cookie = passwordCookie(settings);
    return seeOther('/organizer', [setCookie('ss_org', cookie.cookieValue, cookie.maxAgeSeconds, scheme)]);
  }
  await new Promise((resolve) => setTimeout(resolve, WRONG_PASSWORD_DELAY_MS));
  return seeOther('/organizer?e=wrong');
});
