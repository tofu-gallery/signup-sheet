// GET /organizer/people/<id>/remove-everywhere: "Remove … from every place, and from the list?", listing every sign-up.
// POST: removes a person and every sign-up they hold (W11), with `confirm=yes`. Waiting people move up into the
// confirmed places they leave.
import { guarded } from '../../../../../lib/guard';
import { htmlResponse } from '../../../../../lib/page';
import { removeEverywhereShell } from '../../../../../lib/pages/people';
import { removePersonEverywhere } from '../../../../../lib/people';
import { field } from '../../../../../lib/request';
import { afterWrite, answering, done, notFound, organizerGet, organizerPost, type Params, pathId } from '../../../../../lib/routes';
import { personView } from '../../../../../lib/views';

export const dynamic = 'force-dynamic';

export const POST = guarded(async (request: Request, context: Params<'id'>) => {
  const personId = pathId((await context.params).id);
  const post = await organizerPost(request);
  if (post instanceof Response) return post;
  if (!personId) return notFound(post);
  if (field(post.form, 'confirm') !== 'yes') return done(post, `/organizer/people/${personId}/remove-everywhere`);
  const result = await removePersonEverywhere(post.pool, personId, post.ctx);
  if (result.kind === 'missing') return notFound(post);
  await afterWrite(post);
  // `removed=<n>`: how many waiting people moved up into the places they left, to tell.
  return done(post, `/organizer/people?removed=${result.promoted}`);
});

export const GET = answering('remove everywhere page', async (request: Request, context: Params<'id'>) => {
  const organizer = await organizerGet(request);
  if (organizer instanceof Response) return organizer;
  const personId = pathId((await context.params).id);
  const person = personId ? await personView(organizer.pool, personId) : null;
  if (!person) return notFound();
  return htmlResponse(200, removeEverywhereShell(organizer.signedIn.organizer, person));
});
