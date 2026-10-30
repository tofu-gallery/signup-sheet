// GET /organizer/signups/<id>/swap: the confirmed people on other places of the sheet this one can trade with. POST: two
// confirmed sign-ups on one sheet trade places (W4), field `with` (the other sign-up's id). Both people are marked to
// tell; the sheet page then shows the message for both.
import { guarded } from '../../../../../lib/guard';
import { htmlResponse } from '../../../../../lib/page';
import { swapShell } from '../../../../../lib/pages/sheet-admin';
import { field } from '../../../../../lib/request';
import { afterWrite, answering, done, notFound, organizerGet, organizerPost, pageContext, type Params, pathId, signupSheetSlug } from '../../../../../lib/routes';
import { swapSignups } from '../../../../../lib/signups';
import { organizerSignup, organizerView } from '../../../../../lib/views';

export const dynamic = 'force-dynamic';

export const POST = guarded(async (request: Request, context: Params<'id'>) => {
  const signupId = pathId((await context.params).id);
  const post = await organizerPost(request);
  if (post instanceof Response) return post;
  if (!signupId) return notFound(post);
  const slug = await signupSheetSlug(post, signupId);
  if (!slug) return notFound(post);
  const back = `/organizer/signups/${signupId}/swap`;
  const other = pathId(field(post.form, 'with'));
  if (!other) return done(post, `${back}?e=changed`);
  const result = await swapSignups(post.pool, { a: signupId, b: other }, post.ctx);
  if (result.kind === 'missing') return done(post, `/organizer/sheets/${slug}?e=changed`);
  if (result.kind === 'refused') return done(post, `${back}?e=${result.reason}`);
  await afterWrite(post);
  return done(post, `/organizer/sheets/${slug}?changed=${result.signupIds.join('-')}`);
});

export const GET = answering('swap page', async (request: Request, context: Params<'id'>) => {
  const organizer = await organizerGet(request);
  if (organizer instanceof Response) return organizer;
  const signupId = pathId((await context.params).id);
  const signup = signupId ? await organizerSignup(organizer.pool, signupId) : null;
  const sheet = signup ? await organizerView(organizer.pool, signup.sheetSlug) : null;
  if (!signup || !sheet) return notFound();
  const page = pageContext(request);
  return htmlResponse(200, swapShell(organizer.signedIn.organizer, signup, sheet, page.query.get('e'), page.now));
});
