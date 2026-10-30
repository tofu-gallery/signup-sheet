// POST /organizer/sheets/<slug>/slots-every-date: adds a slot (label, capacity, description) to every date from today
// on that has no slot with that label.
import { slotFrom } from '../../../../../lib/forms';
import { guarded } from '../../../../../lib/guard';
import { afterWrite, done, notFound, organizerPost, type Params, pathSlug } from '../../../../../lib/routes';
import { addSlotEveryDate } from '../../../../../lib/structure';

export const dynamic = 'force-dynamic';

export const POST = guarded(async (request: Request, context: Params<'slug'>) => {
  const slug = pathSlug((await context.params).slug);
  const post = await organizerPost(request);
  if (post instanceof Response) return post;
  if (!slug) return notFound(post);
  const fields = slotFrom(post.form);
  if (!fields.ok) return done(post, `/organizer/sheets/${slug}?e=${fields.code}`);
  const result = await addSlotEveryDate(post.pool, { slug, slot: fields.value }, post.ctx);
  if (result.kind === 'missing') return notFound(post);
  await afterWrite(post);
  return done(post, `/organizer/sheets/${slug}?saved=1`);
});
