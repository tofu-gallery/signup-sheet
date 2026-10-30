// GET /organizer/dates/<id>/cancel: "Cancel …?", listing who is on it, each with the message that it is cancelled.
// POST: "Cancel this date". Its sign-ups stay for the organizer to move; it takes no claims or moves, and calendar files
// mark it cancelled. The sheet page then lists the people to tell. /uncancel undoes it.
import { guarded } from '../../../../../lib/guard';
import { htmlResponse } from '../../../../../lib/page';
import { cancelDateShell } from '../../../../../lib/pages/sheet-admin';
import { seeOther } from '../../../../../lib/responses';
import { afterWrite, answering, done, notFound, organizerGet, organizerPost, pageContext, type Params, pathId } from '../../../../../lib/routes';
import { deletionPreview, setDateCancelled } from '../../../../../lib/structure';
import { organizerDate } from '../../../../../lib/views';

export const dynamic = 'force-dynamic';

export const POST = guarded(async (request: Request, context: Params<'id'>) => {
  const dateId = pathId((await context.params).id);
  const post = await organizerPost(request);
  if (post instanceof Response) return post;
  if (!dateId) return notFound(post);
  const result = await setDateCancelled(post.pool, { dateId, cancelled: true }, post.ctx);
  if (result.kind === 'missing') return notFound(post);
  await afterWrite(post);
  return done(post, `/organizer/sheets/${result.slug}?cancelled=${dateId}`);
});

export const GET = answering('cancel date page', async (request: Request, context: Params<'id'>) => {
  const organizer = await organizerGet(request);
  if (organizer instanceof Response) return organizer;
  const dateId = pathId((await context.params).id);
  const date = dateId ? await organizerDate(organizer.pool, dateId) : null;
  if (!date) return notFound();
  if (date.cancelled) return seeOther(`/organizer/sheets/${date.sheetSlug}#d${date.id}`);
  const preview = await deletionPreview(organizer.pool, { kind: 'date', id: date.id });
  if (!preview) return notFound();
  return htmlResponse(200, cancelDateShell(organizer.signedIn.organizer, date, preview, pageContext(request).origin));
});
