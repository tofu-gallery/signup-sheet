// GET /organizer/sheets/<slug>/delete: the confirmation, listing everyone signed up with the message for each, and the
// hash of their sign-ups (`seen`). POST: deletes a sheet with everything on it (W7), with `confirm=yes` and that
// `seen`. If anyone signed up or left since the confirmation, nothing is deleted and it is shown again, with the new list.
import { guarded } from '../../../../../lib/guard';
import { path } from '../../../../../lib/html';
import { htmlResponse } from '../../../../../lib/page';
import { deleteShell } from '../../../../../lib/pages/sheet-admin';
import { field } from '../../../../../lib/request';
import { afterWrite, answering, done, notFound, organizerGet, organizerPost, pageContext, type Params, pathSlug } from '../../../../../lib/routes';
import { deleteTarget, deletionPreview } from '../../../../../lib/structure';
import { sheetHead } from '../../../../../lib/views';
import { words } from '../../../../../words';

export const dynamic = 'force-dynamic';

export const POST = guarded(async (request: Request, context: Params<'slug'>) => {
  const slug = pathSlug((await context.params).slug);
  const post = await organizerPost(request);
  if (post instanceof Response) return post;
  if (!slug) return notFound(post);
  const confirm = `/organizer/sheets/${slug}/delete`;
  if (field(post.form, 'confirm') !== 'yes') return done(post, confirm);
  const result = await deleteTarget(post.pool, { target: { kind: 'sheet', slug }, seen: field(post.form, 'seen') }, post.ctx);
  if (result.kind === 'missing') return notFound(post);
  if (result.kind === 'changed') return done(post, `${confirm}?changed=1`);
  await afterWrite(post);
  return done(post, '/organizer?deleted=1');
});

export const GET = answering('delete sheet page', async (request: Request, context: Params<'slug'>) => {
  const organizer = await organizerGet(request);
  if (organizer instanceof Response) return organizer;
  const slug = pathSlug((await context.params).slug);
  const sheet = slug ? await sheetHead(organizer.pool, slug) : null;
  const preview = sheet ? await deletionPreview(organizer.pool, { kind: 'sheet', slug: sheet.slug }) : null;
  if (!sheet || !preview) return notFound();
  const page = pageContext(request);
  return htmlResponse(
    200,
    deleteShell(organizer.signedIn.organizer, {
      question: words.org.deleteSheetQuestion(sheet.title),
      action: path(`/organizer/sheets/${sheet.slug}/delete`),
      back: path(`/organizer/sheets/${sheet.slug}`),
      preview,
      sheetTitle: sheet.title,
      origin: page.origin,
      changed: page.query.has('changed'),
      // Its address goes with it: the messages carry no link.
      sheetGone: true
    })
  );
});
