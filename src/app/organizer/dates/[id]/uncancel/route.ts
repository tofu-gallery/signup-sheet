// POST /organizer/dates/<id>/uncancel: the date takes claims again, and waiting people move up into free places.
import { guarded } from '../../../../../lib/guard';
import { afterWrite, done, notFound, organizerPost, type Params, pathId } from '../../../../../lib/routes';
import { setDateCancelled } from '../../../../../lib/structure';

export const dynamic = 'force-dynamic';

export const POST = guarded(async (request: Request, context: Params<'id'>) => {
  const dateId = pathId((await context.params).id);
  const post = await organizerPost(request);
  if (post instanceof Response) return post;
  if (!dateId) return notFound(post);
  const result = await setDateCancelled(post.pool, { dateId, cancelled: false }, post.ctx);
  if (result.kind === 'missing') return notFound(post);
  await afterWrite(post);
  return done(post, `/organizer/sheets/${result.slug}?saved=1`);
});
