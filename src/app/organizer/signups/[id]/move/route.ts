// GET /organizer/signups/<id>/move: the places with room on the same sheet. POST: the organizer moves a sign-up there
// (W3), field `to` (a slot id). The organizer may move people out of a cancelled date. The moved person is marked to
// tell, and the sheet page shows the message naming the old and the new day.
import { guarded } from '../../../../../lib/guard';
import { htmlResponse } from '../../../../../lib/page';
import { moveShell } from '../../../../../lib/pages/sheet-admin';
import { field } from '../../../../../lib/request';
import { afterWrite, answering, done, notFound, organizerGet, organizerPost, pageContext, type Params, pathId } from '../../../../../lib/routes';
import { moveSignup } from '../../../../../lib/signups';
import { organizerSignup, organizerView } from '../../../../../lib/views';

export const dynamic = 'force-dynamic';

export const POST = guarded(async (request: Request, context: Params<'id'>) => {
  const signupId = pathId((await context.params).id);
  const post = await organizerPost(request);
  if (post instanceof Response) return post;
  if (!signupId) return notFound(post);
  const before = await organizerSignup(post.pool, signupId);
  if (!before) return notFound(post);
  const back = `/organizer/signups/${signupId}/move`;
  const toSlotId = pathId(field(post.form, 'to'));
  if (!toSlotId) return done(post, `${back}?e=gone`);
  const result = await moveSignup(post.pool, { signupId, toSlotId, owner: null }, post.ctx);
  if (result.kind === 'missing') return notFound(post);
  if (result.kind === 'refused') return done(post, `${back}?e=${result.reason}`);
  await afterWrite(post);
  return done(post, `/organizer/sheets/${result.slug}?changed=${signupId}&was=${before.slotId}`);
});

export const GET = answering('organizer move page', async (request: Request, context: Params<'id'>) => {
  const organizer = await organizerGet(request);
  if (organizer instanceof Response) return organizer;
  const signupId = pathId((await context.params).id);
  const signup = signupId ? await organizerSignup(organizer.pool, signupId) : null;
  const sheet = signup ? await organizerView(organizer.pool, signup.sheetSlug) : null;
  if (!signup || !sheet) return notFound();
  const page = pageContext(request);
  return htmlResponse(200, moveShell(organizer.signedIn.organizer, signup, sheet, page.query.get('e'), page.now));
});
