// GET /organizer/slots/<id>/add: "Add someone": a person on the list, or a new name (and contact), and the note. POST:
// the organizer signs someone up (W1 with the organizer's rules: any sheet status). `personId` names someone on the
// roster; otherwise `name` (and `contact`) make a new person with no private link yet. The form carries a request id
// like the public one, so a repeated press adds nobody twice. A refusal shows the form again (400) with what was typed.
import { guarded } from '../../../../../lib/guard';
import { addSomeoneResponse } from '../../../../../lib/pages/load';
import { addValuesFrom } from '../../../../../lib/pages/sheet-admin';
import { field } from '../../../../../lib/request';
import { sentencePage } from '../../../../../lib/responses';
import { afterWrite, answering, done, notFound, organizerGet, organizerPost, pageContext, type Params, pathId, textCode, withCookies } from '../../../../../lib/routes';
import { claim, type ClaimWho } from '../../../../../lib/signups';
import { requestIdFrom } from '../../../../../lib/tokens';
import { checkContact, checkName, checkNote } from '../../../../../lib/validation';
import { words } from '../../../../../words';

export const dynamic = 'force-dynamic';

export const POST = guarded(async (request: Request, context: Params<'id'>) => {
  const slotId = pathId((await context.params).id);
  const post = await organizerPost(request);
  if (post instanceof Response) return post;
  if (!slotId) return notFound(post);
  const again = async (code: string, rid: string | null) =>
    withCookies(await addSomeoneResponse(post.pool, post.organizer!, slotId, { rid, values: addValuesFrom(post.form), code }, 400), post.cookies);

  const requestId = requestIdFrom(field(post.form, 'rid'));
  if (!requestId) return again('form', null);
  const note = checkNote(field(post.form, 'note'));
  if (!note.ok) return again(textCode('note', note.error), requestId);
  let who: ClaimWho;
  const personId = pathId(field(post.form, 'personId'));
  if (personId) {
    who = { kind: 'person', personId };
  } else {
    if (field(post.form, 'name').trim() === '') return again('nobodyPicked', requestId);
    const name = checkName(field(post.form, 'name'));
    if (!name.ok) return again(textCode('name', name.error), requestId);
    const contact = checkContact(field(post.form, 'contact'));
    if (!contact.ok) return again(textCode('contact', contact.error), requestId);
    who = { kind: 'organizer-new', name: name.value, contact: contact.value };
  }

  const result = await claim(post.pool, post.settings, { slug: null, slotId, requestId, who, note: note.value, rules: 'organizer' }, post.ctx);
  if (result.kind === 'reused') return sentencePage(409, words.member.formReused, {}, post.cookies);
  if (result.kind === 'link-replaced') return done(post, `/organizer/sheets/${result.slug}`);
  if (result.kind === 'refused') return again(result.reason, requestId);
  if (!result.replay) await afterWrite(post);
  return done(post, `/organizer/sheets/${result.slug}?added=${result.signupId}#p${slotId}`);
});

export const GET = answering('add someone page', async (request: Request, context: Params<'id'>) => {
  const organizer = await organizerGet(request);
  if (organizer instanceof Response) return organizer;
  const slotId = pathId((await context.params).id);
  if (!slotId) return notFound();
  const values = { personId: '', name: '', contact: '', note: '' };
  return addSomeoneResponse(organizer.pool, organizer.signedIn.organizer, slotId, { rid: null, values, code: pageContext(request).query.get('e') });
});
