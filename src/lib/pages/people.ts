// The organizer's people pages (see TOFU.md, Pages): the roster (with unpaid only, once there are dues), one person
// with their contact, sign-ups, paid state and private-link state, and the confirmations for a new link and for removing
// someone from every place. A new link is shown once, after its POST, with ways to send it to that person only.
import { words } from '../../words';
import type { Organizer } from '../access';
import { html, type Html, path } from '../html';
import type { Notice, Shell } from '../page';
import { personLinks, type ShareText } from '../share';
import { DEFAULT_TIME_ZONE, formatMomentDate } from '../time';
import { button, checkbox, fieldError, hidden, input, linkButton, postButton, postForm, shareBox, whenText } from '../ui';
import { formatCents, MAX_LENGTH } from '../validation';
import type { GroupView, PersonView, RosterPerson } from '../views';
import { codeNotice, flagNotice } from './common';
import { orgShell } from './organizer';

const o = words.org;

function linkState(person: RosterPerson): string {
  return person.hasLink && person.linkMadeAt ? o.linkMade(formatMomentDate(person.linkMadeAt, DEFAULT_TIME_ZONE)) : o.noLink;
}

function paidState(person: RosterPerson): string {
  if (!person.paid) return o.notPaid;
  return person.paidAmountCents !== null ? `${o.paid}, ${formatCents(person.paidAmountCents)}` : o.paid;
}

export type PersonValues = { name: string; contact: string };

/** The notice after removing someone everywhere: how many waiting people moved up, and where to tell them. */
function removedNotice(query: URLSearchParams): Notice | null {
  const up = query.get('removed');
  if (up === null || !/^[0-9]{1,4}$/.test(up)) return null;
  const n = Number(up);
  return { kind: 'done', body: o.removedUp(n), after: n > 0 ? html`<p><a class="go" href="${path('/organizer')}">${o.tellOnHome}</a></p>` : undefined };
}

export function rosterShell(
  organizer: Organizer,
  people: readonly RosterPerson[],
  group: GroupView,
  query: URLSearchParams,
  values: PersonValues = { name: '', contact: '' },
  code: string | null = query.get('e')
): Shell {
  const dues = group.duesLabel !== '';
  const unpaidOnly = dues && query.get('unpaid') === '1';
  const shown = unpaidOnly ? people.filter((person) => !person.paid) : people;
  // On the unpaid list, one tap marks someone paid (their amount and note stay) and the list comes back without them.
  const markPaid = (person: RosterPerson) =>
    postButton(path(`/organizer/people/${person.id}/paid`), html`${o.markPaid}<span class="sr">: ${person.name}</span>`, 'secondary', { paid: '1', back: 'unpaid' });
  const items = shown.map(
    (person) => html`<li>
<p class="person-line"><a class="name" href="${path(`/organizer/people/${person.id}`)}">${person.name}</a>${person.sameName ? html`<span class="tag">${o.sameName}</span>` : null}${dues ? html`<span class="${person.paid ? 'tag ok' : 'tag'}">${paidState(person)}</span>` : null}</p>
${person.contact ? html`<p class="meta">${person.contact}</p>` : null}
<p class="meta">${o.signupCount(person.signups)} · ${linkState(person)}</p>
${unpaidOnly ? markPaid(person) : null}
</li>`
  );
  // "Marked … paid." only while they are paid: the address comes back after an Undo with Back.
  const marked = query.get('paid');
  const markedPerson = marked ? people.find((person) => person.id === marked && person.paid) : undefined;
  const notices: (Notice | null)[] = [
    flagNotice(query, 'deleted', o.deleted),
    removedNotice(query),
    markedPerson
      ? {
          kind: 'done',
          body: html`${o.markedPaid(markedPerson.name)} ${postButton(path(`/organizer/people/${markedPerson.id}/paid`), o.undo, 'quiet', { paid: '0', back: 'unpaid' })}`
        }
      : null,
    codeNotice(query)
  ];
  return orgShell(
    organizer,
    o.peopleHeading,
    html`<h1>${o.peopleHeading}</h1>
${dues
  ? html`<p class="hint">${group.duesLabel}${group.duesAmountCents !== null ? `, ${formatCents(group.duesAmountCents)}` : ''} · ${o.paidHint}</p>
<div class="actions">${unpaidOnly ? linkButton(path('/organizer/people'), o.showEveryone, 'secondary') : linkButton(path('/organizer/people?unpaid=1'), o.onlyUnpaid, 'secondary')}</div>`
  : null}
${shown.length > 0 ? html`<ul class="rows">${items}</ul>` : html`<p>${unpaidOnly ? o.noUnpaid : o.noPeople}</p>`}
<section class="box" id="add">
<h2>${o.addPerson}</h2>
<p class="hint">${o.addPersonHint}</p>
${postForm(
  path('/organizer/people'),
  html`${input({ name: 'name', label: words.fields.name, value: values.name, required: true, maxLength: MAX_LENGTH.name, error: fieldError(code, 'name') })}
${input({ name: 'contact', label: words.claim.contact, hint: words.claim.contactHint, value: values.contact, maxLength: MAX_LENGTH.contact, error: fieldError(code, 'contact'), plain: true })}
${button(o.addPerson, 'secondary')}`
)}
</section>`,
    notices
  );
}

export function personShell(organizer: Organizer, person: PersonView, group: GroupView, query: URLSearchParams): Shell {
  const code = query.get('e');
  const dues = group.duesLabel !== '';
  const signups = person.signupList.map(
    (signup) => html`<li>
<p class="person-line"><span class="name">${signup.slotLabel}, ${whenText(signup)}</span>${signup.status === 'waiting' ? html`<span class="tag">${o.waitingNumber(signup.position ?? 1)}</span>` : null}${signup.cancelled ? html`<span class="tag cancelled">${words.sheet.cancelled}</span>` : null}</p>
<p class="meta"><a href="${path(`/organizer/sheets/${signup.sheetSlug}`)}">${signup.sheetTitle}</a>${signup.note ? html` · ${signup.note}` : null}</p>
</li>`
  );
  const notices: (Notice | null)[] = [flagNotice(query, 'saved', words.ui.saved), codeNotice(query)];
  return orgShell(
    organizer,
    o.personHeading,
    html`<p class="group"><a class="go" href="${path('/organizer/people')}">${o.peopleHeading}</a></p>
<h1>${person.name}</h1>
${person.sameName ? html`<p><span class="tag">${o.sameName}</span></p>` : null}
<section>
<h2>${o.personSignups}</h2>
${signups.length > 0 ? html`<ul class="rows">${signups}</ul>` : html`<p>${o.personNone}</p>`}
</section>
<section>
<h2>${o.personDetails}</h2>
${postForm(
  path(`/organizer/people/${person.id}/edit`),
  html`${input({ name: 'name', label: words.fields.name, value: person.name, required: true, maxLength: MAX_LENGTH.name, error: fieldError(code, 'name') })}
${input({ name: 'contact', label: words.claim.contact, hint: words.claim.contactHint, value: person.contact, maxLength: MAX_LENGTH.contact, error: fieldError(code, 'contact'), plain: true })}
${button(words.ui.save, 'secondary')}`
)}
</section>
${dues
  ? html`<section class="box" id="paid">
<h2>${group.duesLabel}${group.duesAmountCents !== null ? `, ${formatCents(group.duesAmountCents)}` : ''}</h2>
<p class="hint">${o.paidHint}</p>
${postForm(
  path(`/organizer/people/${person.id}/paid`),
  html`${checkbox({ name: 'paid', label: o.paid, checked: person.paid })}
${input({ name: 'amount', label: o.paidAmount, value: person.paidAmountCents !== null ? (person.paidAmountCents / 100).toFixed(2) : '', inputMode: 'decimal', maxLength: 12, error: fieldError(code, 'amount') })}
${input({ name: 'note', label: o.paidNote, value: person.paidNote, maxLength: MAX_LENGTH.paidNote, error: fieldError(code, 'note', null, { note: MAX_LENGTH.paidNote }) })}
${button(o.paidSave, 'secondary')}`
)}
</section>`
  : null}
<section>
<h2>${o.linkHeading}</h2>
<p>${linkState(person)}</p>
<div class="actions">${linkButton(path(`/organizer/people/${person.id}/new-link`), person.hasLink ? o.newLink : o.firstLink, 'secondary')}</div>
</section>
<section class="danger-zone">
${person.signups > 0
  ? html`<div class="actions">${linkButton(path(`/organizer/people/${person.id}/remove-everywhere`), o.removeEverywhere, 'danger')}</div><p class="hint">${o.removeLine}</p>`
  : html`<div class="actions">${postForm(path(`/organizer/people/${person.id}/delete`), button(o.deletePerson, 'danger'), 'inline')}</div><p class="hint">${o.deletePersonHint}</p>`}
</section>`,
    notices
  );
}

/** "Make a new link for …?", or, for someone who never had one, "Make a private link for …?". */
export function newLinkQuestionShell(organizer: Organizer, person: PersonView): Shell {
  const first = !person.hasLink;
  return orgShell(
    organizer,
    o.newLink,
    html`<h1>${first ? o.firstLinkQuestion(person.name) : o.newLinkQuestion(person.name)}</h1>
<div class="actions">${postForm(path(`/organizer/people/${person.id}/new-link`), button(first ? o.firstLink : o.newLinkYes), 'inline')}${linkButton(path(`/organizer/people/${person.id}`), first ? o.notNow : o.keepIt, 'secondary')}</div>`
  );
}

/**
 * Below a link the organizer just made: the message to that person, to their own contact only (never a group share).
 * Without a contact, the message in a box to copy, for the organizer to send them directly. `first`: the person never
 * had a link, so the message does not speak of an old one.
 */
export function newLinkSend(name: string, contact: string, title: string, link: string, first: boolean): Html {
  const s = words.share;
  const text: ShareText = first
    ? { subject: s.firstLinkSubject(title), text: s.firstLink(title, link) }
    : { subject: s.newLinkSubject(title), text: s.newLink(title, link) };
  if (!contact) {
    return html`<p>${o.newLinkNoContact}</p>
${shareBox({ id: 'send-new-link', label: o.newLinkMessage, text, links: { whatsapp: null, sms: null, email: null }, share: false })}`;
  }
  return shareBox({ id: 'send-new-link', label: o.newLinkTo(name), text, links: personLinks(text, contact), share: false });
}

export function removeEverywhereShell(organizer: Organizer, person: PersonView): Shell {
  return orgShell(
    organizer,
    o.removeEverywhere,
    html`<h1>${o.removeQuestion(person.name)}</h1>
<p>${o.removeLine}</p>
${person.signupList.length > 0
  ? html`<ul class="rows">${person.signupList.map((signup) => html`<li>${signup.slotLabel}, ${whenText(signup)} · ${signup.sheetTitle}${signup.status === 'waiting' ? html` (${o.waitlist})` : null}</li>`)}</ul>`
  : null}
<div class="actions">${postForm(path(`/organizer/people/${person.id}/remove-everywhere`), html`${hidden('confirm', 'yes')}${button(o.removeYes, 'danger')}`, 'inline')}${linkButton(path(`/organizer/people/${person.id}`), o.keepIt, 'secondary')}</div>`
  );
}
