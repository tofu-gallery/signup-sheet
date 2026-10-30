// POST /forget ("Not you?"): this browser stops remembering its person. 303 to `to`, a path on this copy only (else /).
import { clearCookie } from '../../lib/cookies';
import { expectedOrigin, guarded, localPath } from '../../lib/guard';
import { field, readForm } from '../../lib/request';
import { seeOther } from '../../lib/responses';

export const dynamic = 'force-dynamic';

export const POST = guarded(async (request: Request) => {
  const form = await readForm(request);
  const scheme = expectedOrigin(request.headers)?.scheme ?? 'https';
  return seeOther(localPath(field(form, 'to')), [clearCookie('ss_me', scheme)]);
});
