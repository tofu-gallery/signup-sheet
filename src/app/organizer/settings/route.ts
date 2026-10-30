// GET /organizer/settings: the group's settings. POST: the group's name, the organizer's name and contact (the public
// footer names the organizer without the contact), and dues (an empty label means no dues and no paid list). A refused
// field shows the form again (400) with what was typed.
import { settingsFrom } from '../../../lib/forms';
import { guarded } from '../../../lib/guard';
import { settingsValuesFrom } from '../../../lib/pages/group';
import { settingsResponse } from '../../../lib/pages/load';
import { afterWrite, answering, done, organizerGet, organizerPost, pageContext, withCookies } from '../../../lib/routes';
import { saveSettings } from '../../../lib/structure';

export const dynamic = 'force-dynamic';

export const POST = guarded(async (request: Request) => {
  const post = await organizerPost(request);
  if (post instanceof Response) return post;
  const fields = settingsFrom(post.form);
  if (!fields.ok) {
    return withCookies(await settingsResponse(post.pool, post.organizer!, { values: settingsValuesFrom(post.form), code: fields.code, saved: false }, 400), post.cookies);
  }
  await saveSettings(post.pool, fields.value, post.ctx);
  await afterWrite(post);
  return done(post, '/organizer/settings?saved=1');
});

export const GET = answering('settings page', async (request: Request) => {
  const organizer = await organizerGet(request);
  if (organizer instanceof Response) return organizer;
  const query = pageContext(request).query;
  return settingsResponse(organizer.pool, organizer.signedIn.organizer, { values: null, code: query.get('e'), saved: query.has('saved') });
});
