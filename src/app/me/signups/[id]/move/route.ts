// GET /me/signups/<id>/move: the places with room on the same sheet. POST /me/signups/<id>/move: the member moves one of their own sign-ups to a place with room on the same sheet (W3),
// field `to` (a slot id). Another person's sign-up id finds nothing (G6): 404, and nothing changes. A refusal goes back
// to the move page with its code; "taken" says the place was just taken and nothing changed.
import { guarded } from '../../../../../lib/guard';
import { htmlResponse } from '../../../../../lib/page';
import { moveShell, noCookieShell } from '../../../../../lib/pages/member';
import { field } from '../../../../../lib/request';
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
import { moveSignup } from '../../../../../lib/signups';
import { meView, publicSheetView } from '../../../../../lib/views';
import { words } from '../../../../../words';

export const dynamic = 'force-dynamic';

export const POST = guarded(async (request: Request, context: Params<'id'>) => {
  const signupId = pathId((await context.params).id);
  if (!signupId) return notFound();
  const post = await memberPost(request);
  if (post instanceof Response) return post;
  const owner = await rememberedMember(post);
  if (!owner) return unknownMember(post);
  const toSlotId = pathId(field(post.form, 'to'));
  if (!toSlotId) return done(post, `/me/signups/${signupId}/move?e=gone`);
  const result = await moveSignup(post.pool, { signupId, toSlotId, owner }, post.ctx);
  if (result.kind === 'missing') return notYours(post);
  if (result.kind === 'refused') return done(post, `/me/signups/${signupId}/move?e=${result.reason}`);
  await afterWrite(post);
  return done(post, '/me?moved=1');
});

export const GET = answering('move page', async (request: Request, context: Params<'id'>) => {
  const signupId = pathId((await context.params).id);
  if (!signupId) return notFound();
  const member = await memberPage(request);
  if (member instanceof Response) return member;
  if (!member) return htmlResponse(200, noCookieShell());
  // Only this person's own sign-ups (G6): another person's id is the unknown-link 404.
  const view = await meView(member.pool, member.personId);
  const signup = view?.signups.find((each) => each.id === signupId);
  if (!view || !signup) return sentencePage(404, words.member.unknownLink);
  const sheet = await publicSheetView(member.pool, signup.sheetSlug, { draft: false });
  if (!sheet) return sentencePage(404, words.member.unknownLink);
  const held = new Set(view.signups.filter((each) => each.sheetSlug === signup.sheetSlug).map((each) => each.slotId));
  return htmlResponse(200, moveShell(signup, view.signups, sheet, held, member.query, member.now));
});
