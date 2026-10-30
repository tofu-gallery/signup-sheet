// GET /organizer/sheets/<slug>/dates/weekly: "Add a date every week": the form, and with its fields the dates it would
// add (the days the sheet already has at that time are skipped). POST: adds them (structure.ts addWeeklyDates), at most
// 60; a second press adds nothing more.
import { weeklyFrom } from '../../../../../../lib/forms';
import { guarded } from '../../../../../../lib/guard';
import { htmlResponse } from '../../../../../../lib/page';
import { weeklyPreview, weeklyShell } from '../../../../../../lib/pages/sheet-admin';
import { afterWrite, answering, done, notFound, organizerGet, organizerPost, pageContext, type Params, pathSlug } from '../../../../../../lib/routes';
import { addWeeklyDates } from '../../../../../../lib/structure';
import { organizerView } from '../../../../../../lib/views';

export const dynamic = 'force-dynamic';

const FIELDS = ['from', 'until', 'start', 'end', 'place', 'withSlots'] as const;

export const POST = guarded(async (request: Request, context: Params<'slug'>) => {
  const slug = pathSlug((await context.params).slug);
  const post = await organizerPost(request);
  if (post instanceof Response) return post;
  if (!slug) return notFound(post);
  const parsed = weeklyFrom(post.form);
  if (!parsed.ok) {
    // Back to the form with what was typed (dates, times and a place: nothing private) and why.
    const query = new URLSearchParams();
    for (const name of FIELDS) query.set(name, (post.form.get(name) ?? '').slice(0, 200));
    query.set('e', parsed.code);
    return done(post, `/organizer/sheets/${slug}/dates/weekly?${query.toString()}`);
  }
  const result = await addWeeklyDates(post.pool, { slug, ...parsed.value }, post.ctx);
  if (result.kind === 'missing') return notFound(post);
  if (result.added > 0) await afterWrite(post);
  return done(post, `/organizer/sheets/${slug}?weekly=${result.added}`);
});

export const GET = answering('weekly dates page', async (request: Request, context: Params<'slug'>) => {
  const organizer = await organizerGet(request);
  if (organizer instanceof Response) return organizer;
  const slug = pathSlug((await context.params).slug);
  const sheet = slug ? await organizerView(organizer.pool, slug) : null;
  if (!sheet) return notFound();
  const page = pageContext(request);
  let code = page.query.get('e');
  let preview = null;
  if (!code && page.query.has('from')) {
    const parsed = weeklyFrom(page.query);
    if (parsed.ok) preview = weeklyPreview(sheet, parsed.value.days, parsed.value.startsAt);
    else code = parsed.code;
  }
  return htmlResponse(200, weeklyShell(organizer.signedIn.organizer, sheet, page.query, preview, code));
});
