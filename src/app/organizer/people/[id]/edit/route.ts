// POST /organizer/people/<id>/edit: a person's name and contact.
import { personFrom } from '../../../../../lib/forms';
import { guarded } from '../../../../../lib/guard';
import { editPerson } from '../../../../../lib/people';
import { afterWrite, done, notFound, organizerPost, type Params, pathId } from '../../../../../lib/routes';

export const dynamic = 'force-dynamic';

export const POST = guarded(async (request: Request, context: Params<'id'>) => {
  const personId = pathId((await context.params).id);
  const post = await organizerPost(request);
  if (post instanceof Response) return post;
  if (!personId) return notFound(post);
  const fields = personFrom(post.form);
  if (!fields.ok) return done(post, `/organizer/people/${personId}?e=${fields.code}`);
  const result = await editPerson(post.pool, { personId, ...fields.value }, post.ctx);
  if (result.kind === 'missing') return notFound(post);
  await afterWrite(post);
  return done(post, `/organizer/people/${personId}?saved=1`);
});
