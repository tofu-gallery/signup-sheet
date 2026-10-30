// GET /organizer/sheets/<slug>/edit: the sheet's form. POST: a sheet's words and settings. The slug stays; the time zone
// cannot change once anyone is signed up. A refusal shows the form again (400) with what was typed.
import { sheetFrom } from '../../../../../lib/forms';
import { guarded } from '../../../../../lib/guard';
import { editSheetResponse } from '../../../../../lib/pages/load';
import { sheetValuesFrom } from '../../../../../lib/pages/sheet-admin';
import { afterWrite, answering, done, notFound, organizerGet, organizerPost, pageContext, type Params, pathSlug, withCookies } from '../../../../../lib/routes';
import { editSheet } from '../../../../../lib/structure';

export const dynamic = 'force-dynamic';

export const POST = guarded(async (request: Request, context: Params<'slug'>) => {
  const slug = pathSlug((await context.params).slug);
  const post = await organizerPost(request);
  if (post instanceof Response) return post;
  if (!slug) return notFound(post);
  const again = async (code: string) =>
    withCookies(await editSheetResponse(post.pool, post.organizer!, slug, { values: sheetValuesFrom(post.form), code }, 400), post.cookies);
  const fields = sheetFrom(post.form);
  if (!fields.ok) return again(fields.code);
  const result = await editSheet(post.pool, { ...fields.value, slug }, post.ctx);
  if (result.kind === 'missing') return notFound(post);
  if (result.kind === 'refused') return again('timezoneLocked');
  await afterWrite(post);
  return done(post, `/organizer/sheets/${slug}?saved=1`);
});

export const GET = answering('edit sheet page', async (request: Request, context: Params<'slug'>) => {
  const organizer = await organizerGet(request);
  if (organizer instanceof Response) return organizer;
  const slug = pathSlug((await context.params).slug);
  if (!slug) return notFound();
  return editSheetResponse(organizer.pool, organizer.signedIn.organizer, slug, { values: null, code: pageContext(request).query.get('e') });
});
