// POST /me/signups/<id>/note: the member changes the public note on one of their own sign-ups (W5). Another person's
// sign-up id finds nothing (G6): 404, and nothing changes. Once the sheet is closed, or the date is cancelled or has
// started, nothing changes and /me says so (`e=locked`).
import { guarded } from '../../../../../lib/guard';
import { field } from '../../../../../lib/request';
import { afterWrite, done, memberPost, notFound, type Params, pathId, notYours, rememberedMember, textCode, unknownMember } from '../../../../../lib/routes';
import { changeNote } from '../../../../../lib/signups';
import { checkNote } from '../../../../../lib/validation';

export const dynamic = 'force-dynamic';

export const POST = guarded(async (request: Request, context: Params<'id'>) => {
  const signupId = pathId((await context.params).id);
  if (!signupId) return notFound();
  const post = await memberPost(request);
  if (post instanceof Response) return post;
  const owner = await rememberedMember(post);
  if (!owner) return unknownMember(post);
  const note = checkNote(field(post.form, 'note'));
  if (!note.ok) return done(post, `/me?e=${textCode('note', note.error)}&s=${signupId}#s${signupId}`);
  const result = await changeNote(post.pool, { signupId, owner, note: note.value }, post.ctx);
  if (result.kind === 'missing') return notYours(post);
  if (result.kind === 'locked') return done(post, '/me?e=locked');
  if (result.kind === 'refused') return done(post, `/me?e=note&s=${signupId}#s${signupId}`);
  await afterWrite(post);
  return done(post, '/me?saved=1');
});
