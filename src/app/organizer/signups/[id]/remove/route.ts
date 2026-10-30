// GET /organizer/signups/<id>/remove: "Remove … from …?", with what happens to the place. POST: the organizer removes a
// sign-up (W2); the first person waiting moves up while the date still takes people. The sheet page links the
// question, never a one-tap Remove, so a tap meant for Move or Swap removes nobody; the POST itself takes no
// confirmation field (a form sent from the question).
import { guarded } from '../../../../../lib/guard';
import { htmlResponse } from '../../../../../lib/page';
import { removeOneShell } from '../../../../../lib/pages/sheet-admin';
import { afterWrite, answering, done, notFound, organizerGet, organizerPost, type Params, pathId } from '../../../../../lib/routes';
import { cancelSignup } from '../../../../../lib/signups';
import { organizerSignup, organizerView } from '../../../../../lib/views';

export const dynamic = 'force-dynamic';

export const POST = guarded(async (request: Request, context: Params<'id'>) => {
  const signupId = pathId((await context.params).id);
  const post = await organizerPost(request);
  if (post instanceof Response) return post;
  if (!signupId) return notFound(post);
  const result = await cancelSignup(post.pool, { signupId, owner: null }, post.ctx);
  // The organizer's removal is never locked (only a member's own cancel is), so anything else is a sign-up gone.
  if (result.kind !== 'cancelled') return notFound(post);
  await afterWrite(post);
  // `removed=<n>`: how many waiting people moved up (marked on the sheet "Moved up: tell them").
  return done(post, `/organizer/sheets/${result.slug}?removed=${result.promoted}#p${result.slotId}`);
});

export const GET = answering('remove page', async (request: Request, context: Params<'id'>) => {
  const organizer = await organizerGet(request);
  if (organizer instanceof Response) return organizer;
  const signupId = pathId((await context.params).id);
  const signup = signupId ? await organizerSignup(organizer.pool, signupId) : null;
  const sheet = signup ? await organizerView(organizer.pool, signup.sheetSlug) : null;
  if (!signup || !sheet) return notFound();
  return htmlResponse(200, removeOneShell(organizer.signedIn.organizer, signup, sheet, new Date()));
});
