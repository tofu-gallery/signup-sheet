// POST /organizer/people/<id>/delete: removes someone from the roster, only when they have no sign-ups.
import { guarded } from '../../../../../lib/guard';
import { deletePerson } from '../../../../../lib/people';
import { afterWrite, done, notFound, organizerPost, type Params, pathId } from '../../../../../lib/routes';

export const dynamic = 'force-dynamic';

export const POST = guarded(async (request: Request, context: Params<'id'>) => {
  const personId = pathId((await context.params).id);
  const post = await organizerPost(request);
  if (post instanceof Response) return post;
  if (!personId) return notFound(post);
  const result = await deletePerson(post.pool, personId, post.ctx);
  if (result.kind === 'missing') return notFound(post);
  if (result.kind === 'refused') return done(post, `/organizer/people/${personId}?e=hasSignups`);
  await afterWrite(post);
  return done(post, '/organizer/people?deleted=1');
});
