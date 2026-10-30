// POST /me/profile: the member changes their own name and contact (W5), with the link in their cookie.
import { guarded } from '../../../lib/guard';
import { changeProfile } from '../../../lib/people';
import { field } from '../../../lib/request';
import { afterWrite, done, memberPost, rememberedMember, textCode, unknownMember } from '../../../lib/routes';
import { checkContact, checkName } from '../../../lib/validation';

export const dynamic = 'force-dynamic';

export const POST = guarded(async (request: Request) => {
  const post = await memberPost(request);
  if (post instanceof Response) return post;
  const owner = await rememberedMember(post);
  if (!owner) return unknownMember(post);
  const name = checkName(field(post.form, 'name'));
  if (!name.ok) return done(post, `/me?e=${textCode('name', name.error)}`);
  const contact = checkContact(field(post.form, 'contact'));
  if (!contact.ok) return done(post, `/me?e=${textCode('contact', contact.error)}`);
  const result = await changeProfile(post.pool, { owner, name: name.value, contact: contact.value }, post.ctx);
  if (result.kind === 'missing') return unknownMember(post);
  await afterWrite(post);
  return done(post, '/me?saved=1');
});
