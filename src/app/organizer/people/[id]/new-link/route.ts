// GET /organizer/people/<id>/new-link: "Make a new link for …? Their old link stops working." (for someone who never
// had one: "Make a private link for …?"). POST: a new private link for one person (W8), shown once in a 200 answer so
// it never sits in an address, with the message to send it to that person's own contact (never a group share) and a
// way back to their page. Their old link stops working. The organizer's own cookies do not change.
import { absoluteUrl, guarded } from '../../../../../lib/guard';
import { path } from '../../../../../lib/html';
import { htmlResponse } from '../../../../../lib/page';
import { organizerNav } from '../../../../../lib/pages/organizer';
import { newLinkQuestionShell, newLinkSend } from '../../../../../lib/pages/people';
import { makeNewLink } from '../../../../../lib/people';
import { linkPage } from '../../../../../lib/responses';
import { afterWrite, answering, notFound, organizerGet, organizerPost, type Params, pathId } from '../../../../../lib/routes';
import { groupView, personView } from '../../../../../lib/views';
import { words } from '../../../../../words';

export const dynamic = 'force-dynamic';

export const POST = guarded(async (request: Request, context: Params<'id'>) => {
  const personId = pathId((await context.params).id);
  const post = await organizerPost(request);
  if (post instanceof Response) return post;
  if (!personId) return notFound(post);
  // Whether they ever had a link: the first one's page and message speak of no old one.
  const first = !(await personView(post.pool, personId))?.hasLink;
  const result = await makeNewLink(post.pool, { personId }, post.ctx);
  if (result.kind === 'missing') return notFound(post);
  await afterWrite(post);
  const link = absoluteUrl(post.headers, `/me/${result.token}`) ?? `/me/${result.token}`;
  const person = await personView(post.pool, personId);
  const group = await groupView(post.pool);
  const name = person?.name ?? '';
  const o = words.org;
  return linkPage(
    [first ? words.organizer.firstLinkShown : words.organizer.newLinkShown],
    link,
    post.cookies,
    {
      title: `${o.linkHeading} · ${o.title}`,
      heading: o.linkFor(name),
      nav: organizerNav(post.organizer!),
      next: { href: path(`/organizer/people/${personId}`), label: o.backToPerson(name) },
      hint: o.linkAccessCode
    },
    { after: newLinkSend(name, person?.contact ?? '', group.groupName || words.appName, link, first), label: o.linkFor(name) }
  );
});

export const GET = answering('new link page', async (request: Request, context: Params<'id'>) => {
  const organizer = await organizerGet(request);
  if (organizer instanceof Response) return organizer;
  const personId = pathId((await context.params).id);
  const person = personId ? await personView(organizer.pool, personId) : null;
  if (!person) return notFound();
  return htmlResponse(200, newLinkQuestionShell(organizer.signedIn.organizer, person));
});
