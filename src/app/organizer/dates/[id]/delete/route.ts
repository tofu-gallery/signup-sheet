// GET /organizer/dates/<id>/delete: the confirmation, listing who to tell with each one's message, and `seen`; for a
// date still ahead, the way to cancel it instead (people stay on it, and it can be undone). POST:
// deletes a date, its slots and their sign-ups (W7), with `confirm=yes` and that `seen`. If anyone signed up or left
// since the confirmation, nothing is deleted and it is shown again with the new list.
import { guarded } from '../../../../../lib/guard';
import { path } from '../../../../../lib/html';
import { htmlResponse } from '../../../../../lib/page';
import { cancelInstead, deleteShell } from '../../../../../lib/pages/sheet-admin';
import { field } from '../../../../../lib/request';
import { afterWrite, answering, done, notFound, organizerGet, organizerPost, pageContext, type Params, pathId } from '../../../../../lib/routes';
import { deleteTarget, deletionPreview } from '../../../../../lib/structure';
import { formatWhen, isOpenForClaims } from '../../../../../lib/time';
import { organizerDate } from '../../../../../lib/views';
import { words } from '../../../../../words';

export const dynamic = 'force-dynamic';

export const POST = guarded(async (request: Request, context: Params<'id'>) => {
  const id = pathId((await context.params).id);
  const post = await organizerPost(request);
  if (post instanceof Response) return post;
  if (!id) return notFound(post);
  const confirm = `/organizer/dates/${id}/delete`;
  if (field(post.form, 'confirm') !== 'yes') return done(post, confirm);
  const result = await deleteTarget(post.pool, { target: { kind: 'date', id }, seen: field(post.form, 'seen') }, post.ctx);
  if (result.kind === 'missing') return notFound(post);
  if (result.kind === 'changed') return done(post, `${confirm}?changed=1`);
  await afterWrite(post);
  return done(post, `/organizer/sheets/${result.slug}?deleted=1`);
});

export const GET = answering('delete date page', async (request: Request, context: Params<'id'>) => {
  const organizer = await organizerGet(request);
  if (organizer instanceof Response) return organizer;
  const id = pathId((await context.params).id);
  const date = id ? await organizerDate(organizer.pool, id) : null;
  const preview = date ? await deletionPreview(organizer.pool, { kind: 'date', id: date.id }) : null;
  if (!date || !preview) return notFound();
  const page = pageContext(request);
  // A date still ahead (a rain-out, say) is better cancelled than deleted: the page says so, with the way to do it.
  const ahead = !date.cancelled && isOpenForClaims(date.onDate, date.startsAt, date.sheetTimezone, page.now);
  return htmlResponse(
    200,
    deleteShell(organizer.signedIn.organizer, {
      question: words.org.deleteDateQuestion(formatWhen(date.onDate, date.startsAt)),
      action: path(`/organizer/dates/${date.id}/delete`),
      back: path(`/organizer/sheets/${date.sheetSlug}`),
      preview,
      sheetTitle: date.sheetTitle,
      origin: page.origin,
      changed: page.query.has('changed'),
      instead: ahead ? cancelInstead(date) : null
    })
  );
});
