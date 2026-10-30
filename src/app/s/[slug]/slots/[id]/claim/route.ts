// POST /s/<slug>/slots/<id>/claim: a member signs up (W1). The answer is 303 to /me?new=<id> with the private link's
// cookie. A claim that makes a new person while this phone remembers someone else answers 200 with the new person's
// link instead, and the phone keeps its own person. The same form sent again gets the same answer, also when it comes
// with the cookie the first answer set. A filled honeypot goes back to the sheet and writes nothing. Something the
// person can fix (a name, a contact or a note refused, a form out of date) shows the form again, 400, with what they
// typed and the same request id; a place that can no longer be taken goes back to its page with why.
import { MAX_AGE, setCookie } from '../../../../../../lib/cookies';
import { absoluteUrl, guarded } from '../../../../../../lib/guard';
import { path } from '../../../../../../lib/html';
import { claimResponse } from '../../../../../../lib/pages/load';
import { field } from '../../../../../../lib/request';
import { linkPage, seeOther, sentencePage } from '../../../../../../lib/responses';
import { personLinks } from '../../../../../../lib/share';
import {
  afterWrite,
  answering,
  done,
  memberPost,
  notFound,
  type Params,
  pathId,
  pathSlug,
  rememberedMember,
  textCode
} from '../../../../../../lib/routes';
import { claim, type ClaimWho } from '../../../../../../lib/signups';
import { requestIdFrom } from '../../../../../../lib/tokens';
import { shareBox } from '../../../../../../lib/ui';
import { checkContact, checkName, checkNote } from '../../../../../../lib/validation';
import { words } from '../../../../../../words';

export const dynamic = 'force-dynamic';

export const POST = guarded(async (request: Request, context: Params<'slug' | 'id'>) => {
  const params = await context.params;
  const slug = pathSlug(params.slug);
  const slotId = pathId(params.id);
  if (!slug || !slotId) return notFound();
  const post = await memberPost(request);
  if (post instanceof Response) return post;
  if (field(post.form, 'ss_hp') !== '') return done(post, `/s/${slug}`);

  const sent = field(post.form, 'as') === 'me' ? 'me' : 'new';
  const values = { name: field(post.form, 'name'), contact: field(post.form, 'contact'), note: field(post.form, 'note') };
  // The form again, with what was typed; its request id when that was never used (null: a new one).
  const again = (code: string, rid: string | null) =>
    claimResponse({ pool: post.pool, headers: post.headers, scheme: post.scheme, now: new Date() }, { slug, slotId, sent, rid, values, code }, 400, post.cookies);

  const requestId = requestIdFrom(field(post.form, 'rid'));
  if (!requestId) return again('form', null);
  const note = checkNote(field(post.form, 'note'));
  if (!note.ok) return again(textCode('note', note.error), requestId);
  const contact = checkContact(field(post.form, 'contact'));
  if (!contact.ok) return again(textCode('contact', contact.error), requestId);

  const remembered = await rememberedMember(post);
  let who: ClaimWho;
  if (sent === 'me') {
    if (!remembered) return again('who', requestId);
    who = { kind: 'me', auth: remembered, contact: contact.value };
  } else {
    const name = checkName(field(post.form, 'name'));
    if (!name.ok) return again(textCode('name', name.error), requestId);
    who = { kind: 'new', name: name.value, contact: contact.value };
  }

  const result = await claim(post.pool, post.settings, { slug, slotId, requestId, who, note: note.value, rules: 'member' }, post.ctx);
  if (result.kind === 'reused') return sentencePage(409, words.member.formReused, {}, post.cookies);
  if (result.kind === 'link-replaced') return done(post, `/s/${slug}?signedup=1`);
  if (result.kind === 'refused') {
    // Refused before anything was written, so the request id is still unused.
    if (result.reason === 'note' || result.reason === 'who') return again(result.reason, requestId);
    return result.reason === 'gone' ? done(post, `/s/${slug}?e=gone`) : done(post, `/s/${slug}/slots/${slotId}?e=${result.reason}`);
  }

  if (!result.replay) await afterWrite(post);
  // Made for someone other than the person this phone remembers. The person a form made, sending it again with the
  // cookie its first answer set, is that same person: they get the first answer again.
  if (result.token && who.kind === 'new' && remembered && remembered.personId !== result.personId) {
    const link = absoluteUrl(post.headers, `/me/${result.token}`) ?? `/me/${result.token}`;
    const text = { subject: words.share.toMyselfSubject, text: words.share.theirLink(link) };
    const after = who.contact
      ? shareBox({ id: 'to-them', label: words.org.toPerson(who.name), text, links: personLinks(text, who.contact), share: false })
      : null;
    return linkPage(
      [words.member.madeForSomeoneElse(who.name), words.member.sendToThem],
      link,
      post.cookies,
      {
        title: words.claim.someoneElse,
        heading: words.org.linkFor(who.name),
        nav: { kind: 'public' },
        next: { href: path(`/s/${slug}`), label: words.claim.backToSheet },
        // The link is theirs: opening it on this phone would make the phone theirs too.
        hint: words.org.linkAccessCode
      },
      { after, label: words.org.linkFor(who.name) }
    );
  }
  const cookies = result.token ? [setCookie('ss_me', result.token, MAX_AGE.member, post.scheme)] : [];
  return done(post, `/me?new=${result.signupId}`, cookies);
});

// A browser that comes back to this address (after the form was shown again) gets the place's page.
export const GET = answering('claim address', async (_request: Request, context: Params<'slug' | 'id'>) => {
  const params = await context.params;
  const slug = pathSlug(params.slug);
  const slotId = pathId(params.id);
  if (!slug || !slotId) return notFound();
  return seeOther(`/s/${slug}/slots/${slotId}`);
});
