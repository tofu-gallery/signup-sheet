// GET /organizer/slots/<id>/edit: a place's form. POST: its label, description and capacity (W6). A capacity below the
// people confirmed there is refused; a larger one moves waiting people up, earliest first. A refusal (a field, a name the
// date already has, a capacity too small) shows the form again (400) with what was typed.
import { slotFrom } from '../../../../../lib/forms';
import { guarded } from '../../../../../lib/guard';
import { editSlotResponse } from '../../../../../lib/pages/load';
import { slotValuesFrom } from '../../../../../lib/pages/sheet-admin';
import { afterWrite, answering, done, notFound, organizerGet, organizerPost, pageContext, type Params, pathId, withCookies } from '../../../../../lib/routes';
import { editSlot } from '../../../../../lib/structure';

export const dynamic = 'force-dynamic';

export const POST = guarded(async (request: Request, context: Params<'id'>) => {
  const slotId = pathId((await context.params).id);
  const post = await organizerPost(request);
  if (post instanceof Response) return post;
  if (!slotId) return notFound(post);
  const again = async (code: string, n: string | null = null) =>
    withCookies(await editSlotResponse(post.pool, post.organizer!, slotId, { values: slotValuesFrom(post.form), code, n }, 400), post.cookies);
  const fields = slotFrom(post.form);
  if (!fields.ok) return again(fields.code);
  const result = await editSlot(post.pool, { slotId, slot: fields.value }, post.ctx);
  if (result.kind === 'missing') return notFound(post);
  if (result.kind === 'refused' && result.reason === 'capacity') return again('capacity', String(result.confirmed));
  if (result.kind === 'refused') return again(result.reason);
  await afterWrite(post);
  return done(post, `/organizer/sheets/${result.slug}?saved=1#p${slotId}`);
});

export const GET = answering('edit place page', async (request: Request, context: Params<'id'>) => {
  const organizer = await organizerGet(request);
  if (organizer instanceof Response) return organizer;
  const slotId = pathId((await context.params).id);
  if (!slotId) return notFound();
  const query = pageContext(request).query;
  return editSlotResponse(organizer.pool, organizer.signedIn.organizer, slotId, { values: null, code: query.get('e'), n: query.get('n') });
});
