// POST /organizer/sheets/<slug>/dates: "Add a date" (date, start, end, label, place); `withSlots=1` gives it the same
// slots as the sheet's latest date. A refused field, or a day and start time the sheet already has, shows the form again
// (400) with what was typed.
import { dateFrom } from '../../../../../lib/forms';
import { guarded } from '../../../../../lib/guard';
import { field } from '../../../../../lib/request';
import { addDateResponse } from '../../../../../lib/pages/load';
import { dateValuesFrom } from '../../../../../lib/pages/sheet-admin';
import { seeOther } from '../../../../../lib/responses';
import { afterWrite, answering, done, notFound, organizerGet, organizerPost, type Params, pathSlug, withCookies } from '../../../../../lib/routes';
import { addDate } from '../../../../../lib/structure';

export const dynamic = 'force-dynamic';

export const POST = guarded(async (request: Request, context: Params<'slug'>) => {
  const slug = pathSlug((await context.params).slug);
  const post = await organizerPost(request);
  if (post instanceof Response) return post;
  if (!slug) return notFound(post);
  const again = async (code: string) =>
    withCookies(await addDateResponse(post.pool, post.organizer!, slug, { values: dateValuesFrom(post.form), code }, 400), post.cookies);
  const fields = dateFrom(post.form);
  if (!fields.ok) return again(fields.code);
  const result = await addDate(post.pool, { slug, date: fields.value, withSlots: field(post.form, 'withSlots') === '1' }, post.ctx);
  if (result.kind === 'missing') return notFound(post);
  if (result.kind === 'refused') return again(result.reason);
  await afterWrite(post);
  return done(post, `/organizer/sheets/${slug}?saved=1#d${result.dateId}`);
});

export const GET = answering('dates address', async (request: Request, context: Params<'slug'>) => {
  const organizer = await organizerGet(request);
  if (organizer instanceof Response) return organizer;
  const slug = pathSlug((await context.params).slug);
  return slug ? seeOther(`/organizer/sheets/${slug}#new-date`) : notFound();
});
