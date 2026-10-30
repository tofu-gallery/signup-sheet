// POST /organizer/sheets: a new sheet (title, slug, description, time zone, place, names, note label, status, listed).
// A refused field, or a web address another sheet has, shows the form again (400) with what was typed.
import { newSheetFrom } from '../../../lib/forms';
import { guarded } from '../../../lib/guard';
import { htmlResponse } from '../../../lib/page';
import { newSheetShell, sheetValuesFrom } from '../../../lib/pages/sheet-admin';
import { seeOther } from '../../../lib/responses';
import { afterWrite, answering, done, organizerGet, organizerPost } from '../../../lib/routes';
import { createSheet } from '../../../lib/structure';

export const dynamic = 'force-dynamic';

export const POST = guarded(async (request: Request) => {
  const post = await organizerPost(request);
  if (post instanceof Response) return post;
  const again = (code: string) => htmlResponse(400, newSheetShell(post.organizer!, sheetValuesFrom(post.form), code), { cookies: post.cookies });
  const fields = newSheetFrom(post.form);
  if (!fields.ok) return again(fields.code);
  const result = await createSheet(post.pool, fields.value, post.ctx);
  if (result.kind === 'refused') return again('slug');
  await afterWrite(post);
  return done(post, `/organizer/sheets/${result.slug}`);
});

export const GET = answering('sheets address', async (request: Request) => {
  const organizer = await organizerGet(request);
  if (organizer instanceof Response) return organizer;
  return seeOther('/organizer#sheets');
});
