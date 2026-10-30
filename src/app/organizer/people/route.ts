// GET /organizer/people: the roster (pages/people.ts): name, contact, sign-ups, private link made or not, a same-name
// marker, and paid state once there are dues (`?unpaid=1` shows only the unpaid). POST: adds a person to the roster
// (name, contact), with no private link until the organizer makes one; a refused field shows the roster again (400).
import { personFrom } from '../../../lib/forms';
import { guarded } from '../../../lib/guard';
import { rosterResponse } from '../../../lib/pages/load';
import { addPerson } from '../../../lib/people';
import { afterWrite, answering, done, organizerGet, organizerPost, pageContext, withCookies } from '../../../lib/routes';

export const dynamic = 'force-dynamic';

export const POST = guarded(async (request: Request) => {
  const post = await organizerPost(request);
  if (post instanceof Response) return post;
  const fields = personFrom(post.form);
  if (!fields.ok) {
    const values = { name: post.form.get('name') ?? '', contact: post.form.get('contact') ?? '' };
    return withCookies(await rosterResponse(post.pool, post.organizer!, new URLSearchParams(), { values, code: fields.code }, 400), post.cookies);
  }
  const result = await addPerson(post.pool, fields.value, post.ctx);
  await afterWrite(post);
  return done(post, `/organizer/people/${result.personId}`);
});

export const GET = answering('people page', async (request: Request) => {
  const organizer = await organizerGet(request);
  if (organizer instanceof Response) return organizer;
  const query = pageContext(request).query;
  return rosterResponse(organizer.pool, organizer.signedIn.organizer, query, { values: { name: '', contact: '' }, code: query.get('e') });
});
