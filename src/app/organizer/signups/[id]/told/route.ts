// POST /organizer/signups/<id>/told: "Told them" on a moved-up or changed sign-up; /untold undoes it. With `from=sheet`
// it goes back to the sheet's page, else to /organizer, either showing the Undo.
import { guarded } from '../../../../../lib/guard';
import { field } from '../../../../../lib/request';
import { afterWrite, done, notFound, organizerPost, type Params, pathId } from '../../../../../lib/routes';
import { markTold } from '../../../../../lib/signups';

export const dynamic = 'force-dynamic';

export const POST = guarded(async (request: Request, context: Params<'id'>) => {
  const signupId = pathId((await context.params).id);
  const post = await organizerPost(request);
  if (post instanceof Response) return post;
  if (!signupId) return notFound(post);
  const result = await markTold(post.pool, { signupId, told: true }, post.ctx);
  if (result.kind === 'missing') return notFound(post);
  await afterWrite(post);
  const fromSheet = field(post.form, 'from') === 'sheet';
  return done(post, fromSheet ? `/organizer/sheets/${result.slug}?told=${signupId}` : `/organizer?told=${signupId}`);
});
