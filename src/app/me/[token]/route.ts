// GET /me/<token>: a private link. It sets the link's cookie and answers 303 to /me, so the token leaves the address bar
// at once; no Location carries it. Unknown and malformed links get the same 404, and too many of them from one
// connection the throttle's 429. Nothing is written for a link that works (no activity: this is a GET).
import { MAX_AGE, setCookie } from '../../../lib/cookies';
import { appPool } from '../../../lib/db';
import { expectedOrigin } from '../../../lib/guard';
import { memberByToken } from '../../../lib/identity';
import { failureResponse, seeOther, sentencePage } from '../../../lib/responses';
import type { Params } from '../../../lib/routes';
import { readSettings } from '../../../lib/settings';
import { connectionKey, LIMITS, overLimit } from '../../../lib/throttle';
import { words } from '../../../words';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: Params<'token'>): Promise<Response> {
  const { token } = await context.params;
  try {
    const pool = appPool();
    const member = await memberByToken(pool, token);
    if (member) {
      const scheme = expectedOrigin(request.headers)?.scheme ?? 'https';
      return seeOther('/me', [setCookie('ss_me', token, MAX_AGE.member, scheme)]);
    }
    if (await overLimit(pool, connectionKey('link-miss', request.headers, readSettings()), LIMITS.linkMissPerConnection)) {
      return sentencePage(429, words.throttle.linkMiss);
    }
    return sentencePage(404, words.member.unknownLink);
  } catch (error) {
    return failureResponse('private link', error);
  }
}
