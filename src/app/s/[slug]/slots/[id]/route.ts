// GET /s/<slug>/slots/<id>: the claim form (pages/public.ts), with a new request id in each of its forms. A place that is
// gone sends the browser back to the sheet. A sheet that is not open, a date that is cancelled or has started shows why.
import { claimResponse } from '../../../../../lib/pages/load';
import { seeOther } from '../../../../../lib/responses';
import { answering, notFound, pageContext, type Params, pathId, pathSlug } from '../../../../../lib/routes';

export const dynamic = 'force-dynamic';

// The page itself says when a sheet is closed or a date has passed or is cancelled; only other codes are repeated.
const SHOWN_BY_THE_PAGE = new Set(['closed', 'past', 'cancelled']);

export const GET = answering('claim page', async (request: Request, context: Params<'slug' | 'id'>) => {
  const params = await context.params;
  const slug = pathSlug(params.slug);
  const slotId = pathId(params.id);
  if (!slug || !slotId) return notFound();
  const page = pageContext(request);
  const code = page.query.get('e');
  if (code === 'gone') return seeOther(`/s/${slug}?e=gone`);
  const values = { name: '', contact: '', note: '' };
  return claimResponse(page, { slug, slotId, sent: null, rid: null, values, code: code && !SHOWN_BY_THE_PAGE.has(code) ? code : null }, 200);
});
