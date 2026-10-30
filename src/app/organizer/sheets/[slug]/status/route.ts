// POST /organizer/sheets/<slug>/status: draft, open or closed. It waits for the claims in flight on the sheet.
import { statusFrom } from '../../../../../lib/forms';
import { guarded } from '../../../../../lib/guard';
import { afterWrite, done, notFound, organizerPost, type Params, pathSlug } from '../../../../../lib/routes';
import { setSheetStatus } from '../../../../../lib/structure';

export const dynamic = 'force-dynamic';

export const POST = guarded(async (request: Request, context: Params<'slug'>) => {
  const slug = pathSlug((await context.params).slug);
  const post = await organizerPost(request);
  if (post instanceof Response) return post;
  if (!slug) return notFound(post);
  const status = statusFrom(post.form);
  if (!status.ok) return done(post, `/organizer/sheets/${slug}?e=status`);
  const result = await setSheetStatus(post.pool, { slug, status: status.value }, post.ctx);
  if (result.kind === 'missing') return notFound(post);
  await afterWrite(post);
  return done(post, `/organizer/sheets/${slug}?saved=1`);
});
