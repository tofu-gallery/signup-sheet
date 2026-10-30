// POST /organizer/sign-out: this browser forgets its organizer cookie. Nothing else changes (a seat stays held until it
// ends or is given up), so it needs no database.
import { clearCookie } from '../../../lib/cookies';
import { expectedOrigin, guarded } from '../../../lib/guard';
import { readForm } from '../../../lib/request';
import { seeOther } from '../../../lib/responses';

export const dynamic = 'force-dynamic';

export const POST = guarded(async (request: Request) => {
  await readForm(request);
  const scheme = expectedOrigin(request.headers)?.scheme ?? 'https';
  return seeOther('/', [clearCookie('ss_org', scheme)]);
});
