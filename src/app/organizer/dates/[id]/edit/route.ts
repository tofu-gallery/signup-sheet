// GET /organizer/dates/<id>/edit: a date's form. POST: its day, times, label and place. A new day, time or place marks
// everyone on it to tell: the sheet page then lists them, each with the message naming the old and the new day. A
// refused field, or another date's day and start time, shows the form again (400) with what was typed.
import { dateFrom } from '../../../../../lib/forms';
import { guarded } from '../../../../../lib/guard';
import { editDateResponse } from '../../../../../lib/pages/load';
import { dateValuesFrom } from '../../../../../lib/pages/sheet-admin';
import { afterWrite, answering, done, notFound, organizerGet, organizerPost, pageContext, type Params, pathId, withCookies } from '../../../../../lib/routes';
import { editDate } from '../../../../../lib/structure';
import { organizerDate } from '../../../../../lib/views';

export const dynamic = 'force-dynamic';

export const POST = guarded(async (request: Request, context: Params<'id'>) => {
  const dateId = pathId((await context.params).id);
  const post = await organizerPost(request);
  if (post instanceof Response) return post;
  if (!dateId) return notFound(post);
  const again = async (code: string) =>
    withCookies(await editDateResponse(post.pool, post.organizer!, dateId, { values: dateValuesFrom(post.form), code }, 400), post.cookies);
  const fields = dateFrom(post.form);
  if (!fields.ok) return again(fields.code);
  // The day and time before the change, for the message to the people on it.
  const before = await organizerDate(post.pool, dateId);
  const result = await editDate(post.pool, { dateId, date: fields.value }, post.ctx);
  if (result.kind === 'missing') return notFound(post);
  if (result.kind === 'refused') return again(result.reason);
  await afterWrite(post);
  if (result.changed > 0 && before) {
    const wasAt = before.startsAt ? `&wasAt=${before.startsAt.slice(0, 5)}` : '';
    return done(post, `/organizer/sheets/${result.slug}?moved=${dateId}&was=${before.onDate}${wasAt}`);
  }
  return done(post, `/organizer/sheets/${result.slug}?saved=1#d${dateId}`);
});

export const GET = answering('edit date page', async (request: Request, context: Params<'id'>) => {
  const organizer = await organizerGet(request);
  if (organizer instanceof Response) return organizer;
  const dateId = pathId((await context.params).id);
  if (!dateId) return notFound();
  return editDateResponse(organizer.pool, organizer.signedIn.organizer, dateId, { values: null, code: pageContext(request).query.get('e') });
});
