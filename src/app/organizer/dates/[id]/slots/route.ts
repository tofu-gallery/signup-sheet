// GET /organizer/dates/<id>/slots: the form to add a place to one date. POST: adds it (label, capacity, description). A
// refused field, or a name the date already has, shows the form again (400) with what was typed.
import { slotFrom } from '../../../../../lib/forms';
import { guarded } from '../../../../../lib/guard';
import { addSlotResponse } from '../../../../../lib/pages/load';
import { slotValuesFrom } from '../../../../../lib/pages/sheet-admin';
import { afterWrite, answering, done, notFound, organizerGet, organizerPost, pageContext, type Params, pathId, withCookies } from '../../../../../lib/routes';
import { addSlot } from '../../../../../lib/structure';

export const dynamic = 'force-dynamic';

export const POST = guarded(async (request: Request, context: Params<'id'>) => {
  const dateId = pathId((await context.params).id);
  const post = await organizerPost(request);
  if (post instanceof Response) return post;
  if (!dateId) return notFound(post);
  const again = async (code: string) =>
    withCookies(await addSlotResponse(post.pool, post.organizer!, dateId, { values: slotValuesFrom(post.form), code }, 400), post.cookies);
  const fields = slotFrom(post.form);
  if (!fields.ok) return again(fields.code);
  const result = await addSlot(post.pool, { dateId, slot: fields.value }, post.ctx);
  if (result.kind === 'missing') return notFound(post);
  if (result.kind === 'refused') return again(result.reason);
  await afterWrite(post);
  return done(post, `/organizer/sheets/${result.slug}?saved=1#d${dateId}`);
});

export const GET = answering('add place page', async (request: Request, context: Params<'id'>) => {
  const organizer = await organizerGet(request);
  if (organizer instanceof Response) return organizer;
  const dateId = pathId((await context.params).id);
  if (!dateId) return notFound();
  const values = { label: '', capacity: '1', description: '' };
  return addSlotResponse(organizer.pool, organizer.signedIn.organizer, dateId, { values, code: pageContext(request).query.get('e') });
});
