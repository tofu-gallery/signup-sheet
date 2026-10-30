// GET /organizer/slots/<id>/delete: the confirmation, listing who to tell with each one's message, and `seen`. POST:
// deletes a slot and its sign-ups (W7), with `confirm=yes` and that `seen`. If anyone signed up or left since the
// confirmation, nothing is deleted and the confirmation is shown again with the new list.
import { guarded } from '../../../../../lib/guard';
import { path } from '../../../../../lib/html';
import { htmlResponse } from '../../../../../lib/page';
import { deleteShell } from '../../../../../lib/pages/sheet-admin';
import { field } from '../../../../../lib/request';
import { afterWrite, answering, done, notFound, organizerGet, organizerPost, pageContext, type Params, pathId } from '../../../../../lib/routes';
import { deleteTarget, deletionPreview } from '../../../../../lib/structure';
import { formatWhen } from '../../../../../lib/time';
import { organizerSlot } from '../../../../../lib/views';
import { words } from '../../../../../words';

export const dynamic = 'force-dynamic';

export const POST = guarded(async (request: Request, context: Params<'id'>) => {
  const id = pathId((await context.params).id);
  const post = await organizerPost(request);
  if (post instanceof Response) return post;
  if (!id) return notFound(post);
  const confirm = `/organizer/slots/${id}/delete`;
  if (field(post.form, 'confirm') !== 'yes') return done(post, confirm);
  const result = await deleteTarget(post.pool, { target: { kind: 'slot', id }, seen: field(post.form, 'seen') }, post.ctx);
  if (result.kind === 'missing') return notFound(post);
  if (result.kind === 'changed') return done(post, `${confirm}?changed=1`);
  await afterWrite(post);
  return done(post, `/organizer/sheets/${result.slug}?deleted=1`);
});

export const GET = answering('delete place page', async (request: Request, context: Params<'id'>) => {
  const organizer = await organizerGet(request);
  if (organizer instanceof Response) return organizer;
  const id = pathId((await context.params).id);
  const slot = id ? await organizerSlot(organizer.pool, id) : null;
  const preview = slot ? await deletionPreview(organizer.pool, { kind: 'slot', id: slot.slotId }) : null;
  if (!slot || !preview) return notFound();
  const page = pageContext(request);
  return htmlResponse(
    200,
    deleteShell(organizer.signedIn.organizer, {
      question: words.org.deleteSlotQuestion(slot.slotLabel, formatWhen(slot.onDate, slot.startsAt)),
      action: path(`/organizer/slots/${slot.slotId}/delete`),
      back: path(`/organizer/sheets/${slot.sheetSlug}`),
      preview,
      sheetTitle: slot.sheetTitle,
      origin: page.origin,
      changed: page.query.has('changed')
    })
  );
});
