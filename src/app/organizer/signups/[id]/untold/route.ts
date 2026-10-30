// POST /organizer/signups/<id>/untold: the Undo of "Told them": the sign-up is back in Needs attention.
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
  const result = await markTold(post.pool, { signupId, told: false }, post.ctx);
  if (result.kind === 'missing') return notFound(post);
  await afterWrite(post);
  return done(post, field(post.form, 'from') === 'sheet' ? `/organizer/sheets/${result.slug}` : '/organizer#attention');
});
