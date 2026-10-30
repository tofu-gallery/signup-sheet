// POST /organizer/people/<id>/paid: paid or not (`paid=1`), the amount and a note (W9). A record only: the app takes
// no payments. From the unpaid list (`back=unpaid`, an exact word, never a path), only paid or not changes, the amount
// and note stay, and the answer is the unpaid list again with "Marked … paid." and its Undo.
import { paidFrom } from '../../../../../lib/forms';
import { guarded } from '../../../../../lib/guard';
import { markPaid, setPaid } from '../../../../../lib/people';
import { field } from '../../../../../lib/request';
import { afterWrite, done, notFound, organizerPost, type Params, pathId } from '../../../../../lib/routes';

export const dynamic = 'force-dynamic';

export const POST = guarded(async (request: Request, context: Params<'id'>) => {
  const personId = pathId((await context.params).id);
  const post = await organizerPost(request);
  if (post instanceof Response) return post;
  if (!personId) return notFound(post);
  if (field(post.form, 'back') === 'unpaid') {
    const paid = field(post.form, 'paid') === '1';
    const marked = await markPaid(post.pool, { personId, paid }, post.ctx);
    if (marked.kind === 'missing') return notFound(post);
    await afterWrite(post);
    return done(post, paid ? `/organizer/people?unpaid=1&paid=${personId}` : '/organizer/people?unpaid=1');
  }
  const fields = paidFrom(post.form);
  if (!fields.ok) return done(post, `/organizer/people/${personId}?e=${fields.code}`);
  const result = await setPaid(post.pool, { personId, ...fields.value }, post.ctx);
  if (result.kind === 'missing') return notFound(post);
  await afterWrite(post);
  return done(post, `/organizer/people/${personId}?saved=1`);
});
