// GET /me/new-link: "Make a new private link? The old one stops working on every phone." POST: the member replaces their
// own private link (W8). The old one stops working on every phone; this browser's cookie moves to the new one, which the
// answer shows once (200, never in an address), with a way to send it to themselves and a way back to their page.
import { MAX_AGE, setCookie } from '../../../lib/cookies';
import { absoluteUrl, guarded } from '../../../lib/guard';
import { path } from '../../../lib/html';
import { logFailure } from '../../../lib/log';
import { htmlResponse } from '../../../lib/page';
import { newLinkConfirmShell, noCookieShell, sendLinkAfter } from '../../../lib/pages/member';
import { makeNewLink } from '../../../lib/people';
import { linkPage } from '../../../lib/responses';
import { afterWrite, answering, memberPage, memberPost, rememberedMember, unknownMember } from '../../../lib/routes';
import { meView } from '../../../lib/views';
import { words } from '../../../words';

export const dynamic = 'force-dynamic';

export const POST = guarded(async (request: Request) => {
  const post = await memberPost(request);
  if (post instanceof Response) return post;
  const owner = await rememberedMember(post);
  if (!owner) return unknownMember(post);
  const result = await makeNewLink(post.pool, { owner }, post.ctx);
  if (result.kind === 'missing') return unknownMember(post);
  await afterWrite(post);
  const link = absoluteUrl(post.headers, `/me/${result.token}`) ?? `/me/${result.token}`;
  // Their own saved contact, which their page shows them: "Send it to myself" is addressed to it. The new link is made
  // and the old one gone already, so a failure reading it never undoes this answer: the box goes to nobody then.
  let contact = '';
  try {
    contact = (await meView(post.pool, owner.personId))?.contact ?? '';
  } catch (error) {
    logFailure('new link contact', error);
  }
  return linkPage(
    [words.member.newLinkMade],
    link,
    [...post.cookies, setCookie('ss_me', result.token, MAX_AGE.member, post.scheme)],
    { title: words.me.newLinkTitle, heading: words.member.yourLink, nav: { kind: 'member' }, next: { href: path('/me'), label: words.nav.mySignups } },
    { after: sendLinkAfter('', link, contact) }
  );
});

export const GET = answering('new link page', async (request: Request) => {
  const member = await memberPage(request);
  if (member instanceof Response) return member;
  return htmlResponse(200, member ? newLinkConfirmShell() : noCookieShell());
});
