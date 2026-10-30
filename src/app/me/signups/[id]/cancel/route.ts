// GET /me/signups/<id>/cancel: "Cancel … ? If someone is waiting, they move up.", with a message asking the group to swap
// instead. POST /me/signups/<id>/cancel: the member cancels one of their own sign-ups (W2); the first person waiting moves up.
// Another person's sign-up id finds nothing (G6): 404, and nothing changes. When nobody moved into a place in the next 7
// days, /me offers the message asking the group to take it (`open=<slot id>`); when someone did, it says so (`up=1`);
// either way it links the sheet again (`sheet=<slug>`). Once the sheet is closed, or the date is cancelled or has
// started, nothing changes and /me says so (`e=locked`), as the confirmation page already does.
import { guarded } from '../../../../../lib/guard';
import { htmlResponse } from '../../../../../lib/page';
import { cancelShell, noCookieShell } from '../../../../../lib/pages/member';
import { sentencePage } from '../../../../../lib/responses';
import {
  afterWrite,
  answering,
  done,
  memberPage,
  memberPost,
  notFound,
  type Params,
  notYours,
  pathId,
  rememberedMember,
  unknownMember
} from '../../../../../lib/routes';
import { cancelSignup } from '../../../../../lib/signups';
import { meView } from '../../../../../lib/views';
import { words } from '../../../../../words';

export const dynamic = 'force-dynamic';

export const POST = guarded(async (request: Request, context: Params<'id'>) => {
  const signupId = pathId((await context.params).id);
  if (!signupId) return notFound();
  const post = await memberPost(request);
  if (post instanceof Response) return post;
  const owner = await rememberedMember(post);
  if (!owner) return unknownMember(post);
  const result = await cancelSignup(post.pool, { signupId, owner }, post.ctx);
  if (result.kind === 'missing') return notYours(post);
  if (result.kind === 'locked') return done(post, '/me?e=locked');
  await afterWrite(post);
  // /me says whether someone moved up into the place, and offers the sheet again to pick another date.
  const after = result.askGroup ? `&open=${result.slotId}` : result.promoted > 0 ? '&up=1' : '';
  return done(post, `/me?cancelled=1${after}&sheet=${result.slug}`);
});

export const GET = answering('cancel page', async (request: Request, context: Params<'id'>) => {
  const signupId = pathId((await context.params).id);
  if (!signupId) return notFound();
  const member = await memberPage(request);
  if (member instanceof Response) return member;
  if (!member) return htmlResponse(200, noCookieShell());
  // Only this person's own sign-ups (G6): another person's id is the unknown-link 404.
  const view = await meView(member.pool, member.personId);
  const signup = view?.signups.find((each) => each.id === signupId);
  if (!view || !signup) return sentencePage(404, words.member.unknownLink);
  return htmlResponse(200, cancelShell(signup, view.signups, member.origin, view.organizerName, member.now));
});
