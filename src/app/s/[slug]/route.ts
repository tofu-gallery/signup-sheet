// GET /s/<slug>: a sheet's public page (pages/public.ts): names (or "Taken"), notes and counts, never a contact. A draft
// is the organizer's preview only; to anyone else, like an unknown sheet, it is 404.
import { sheetResponse } from '../../../lib/pages/load';
import { answering, notFound, pageContext, type Params, pathSlug } from '../../../lib/routes';

export const dynamic = 'force-dynamic';

export const GET = answering('sheet page', async (request: Request, context: Params<'slug'>) => {
  const slug = pathSlug((await context.params).slug);
  if (!slug) return notFound();
  return (await sheetResponse(pageContext(request), slug, { inPlace: false })) ?? notFound();
});
