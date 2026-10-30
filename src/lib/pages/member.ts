// A person's own pages (see TOFU.md, Members and their links): /me with every sign-up of theirs, the after-claim panel,
// and the confirmations to cancel, move and make a new link. Only that person's data (views.ts meView): their own
// name and contact, their own sign-ups and the public words of those places. Titles are generic ("Your sign-ups"), and
// a link preview reads "Private sign-up link (for one person)", so neither names anyone.
import { words } from '../../words';
import { anchor, flag, html, type Html, path, shareHref } from '../html';
import { type EventLinks, googleCalendarUrl } from '../ics';
import type { Notice, Shell } from '../page';
import { inviteText, personLinks, reachOf, type ShareText, shareLinks } from '../share';
import { civilToday, dateWords, formatDate, formatMomentDate, formatWhen, isOpenForClaims } from '../time';
import { button, dateStrip, fieldError, hidden, input, linkBox, linkButton, postForm, roomFor, shareBox, textarea } from '../ui';
import { isSlug, MAX_LENGTH } from '../validation';
import type { CalendarEntry, MeView, MySignup, PublicSheet, SlotWords } from '../views';
import { codeNotice, noteNotice, privateLink, publicFooter, sheetLink } from './common';

const PAGE = { title: words.member.pageTitle, previewTitle: words.me.previewTitle } as const;

/**
 * /me without a cookie: how to get back in (200, so a link preview or a cookie-less in-app browser gets a page): where
 * the link already is (their calendar event's notes, a message they sent themselves), the way back to the sheet, and the
 * public footer (the organizer's name and the lost-link lines). `organizerName`: '' where the page did not read it.
 */
export function noCookieShell(organizerName = ''): Shell {
  const m = words.member;
  return {
    ...PAGE,
    nav: { kind: 'member' },
    main: html`<h1>${m.pageTitle}</h1>
<p>${m.noCookie}</p>
<p>${m.whereIsLink}</p>
<p class="hint">${m.accessCode}</p>
<div class="actions">${linkButton(path('/'), m.seeSheet, 'secondary')}</div>`,
    footer: publicFooter(organizerName)
  };
}

/** Why a sign-up can no longer change here: a closed sheet, or a date that has started (a cancelled date says so itself). */
function lockedReason(signup: MySignup): string {
  return signup.sheetStatus !== 'open' ? words.me.lockedClosed : words.me.lockedStarted;
}

/** How a sentence names a sign-up's date: with its time when the person has another date of that sheet on that day. */
function sameDayWords(signup: MySignup, all: readonly MySignup[]): string {
  const dates = new Map<string, { onDate: string; startsAt: string | null }>();
  for (const other of all) if (other.sheetSlug === signup.sheetSlug) dates.set(`${other.onDate} ${other.startsAt ?? ''}`, other);
  return dateWords([...dates.values()], signup);
}

/**
 * "Send it to myself": the private link in a message to the person's own saved contact when it reads only one way (mail
 * to their own address, or a text and WhatsApp to their own number written with its country code), which their page
 * shows them already. A number without one may be another country's, and reading it as a US number would send the link
 * to a stranger (155 1234 5678, a mobile number in China, reads as a US number in area code 551). With that, or no
 * contact a link can reach, Messages and Mail addressed to nobody, for them to type their own. Never WhatsApp's list
 * of chats nor the share sheet: both offer the chats used last first, the group chat the sheet came from among them.
 */
function toMyselfBox(id: string, text: ShareText, contact: string): Html {
  const sure = reachOf(contact).email !== null || contact.trim().startsWith('+');
  const own = personLinks(text, sure ? contact : '');
  const links = own.sms || own.email ? own : { ...shareLinks(text), whatsapp: null };
  return shareBox({ id, label: words.me.sendToMyself, text, links, share: false });
}

/** Whether a member can still change this sign-up themselves: open sheet, a date not cancelled and not started. */
export function changeable(signup: MySignup, now: Date): boolean {
  return signup.sheetStatus === 'open' && !signup.dateCancelled && isOpenForClaims(signup.onDate, signup.startsAt, signup.sheetTimezone, now);
}

function calendarButtons(signup: MySignup, token: string, entry: CalendarEntry | undefined, links: EventLinks, android: boolean): Html | null {
  if (signup.status !== 'confirmed') return null;
  const m = words.me;
  const ics = html`<a class="button secondary" href="${path(`/me/${token}/calendar/${signup.id}.ics`)}">${signup.dateCancelled ? m.updateCalendar : m.addCalendar}</a>`;
  const google = entry ? googleCalendarUrl(entry, links) : null;
  const googleButton = google ? html`<a class="button secondary" href="${shareHref(google)}">${m.addGoogle}</a>` : null;
  return html`<div class="actions">${android ? [googleButton, ics] : [ics, googleButton]}</div>`;
}

function signupItem(
  signup: MySignup,
  options: { token: string; calendar: Map<string, CalendarEntry>; links: (signup: MySignup) => EventLinks; android: boolean; now: Date; error: string | null; fresh: boolean }
): Html {
  const m = words.me;
  // A cancelled date carries its own "Cancelled" in the date strip: no "Confirmed" beside it.
  const status = signup.dateCancelled
    ? null
    : signup.status === 'waiting'
      ? html`<span class="tag">${m.waiting(signup.position ?? 1)}</span>`
      : html`<span class="tag ok">${m.confirmed}</span>`;
  const notes: Html[] = [];
  if (signup.promotedAt && signup.status === 'confirmed') notes.push(html`<p class="meta">${m.movedUp(formatMomentDate(signup.promotedAt, signup.sheetTimezone))}</p>`);
  if (signup.changedAt) notes.push(html`<p class="meta">${m.changed(formatMomentDate(signup.changedAt, signup.sheetTimezone))}</p>`);
  if (signup.dateCancelled) notes.push(html`<p class="meta">${m.dateCancelled}</p>`);
  else if (signup.status === 'waiting') notes.push(html`<p class="meta">${m.waitingHow}</p>`);
  const open = changeable(signup, options.now);
  const noteLabel = signup.noteLabel || m.noteLabel;
  const noteForm = open
    ? html`<details${flag('open', Boolean(options.error))}><summary>${noteLabel}</summary>${postForm(
        path(`/me/signups/${signup.id}/note`),
        html`${textarea({ name: 'note', id: `note-${signup.id}`, label: noteLabel, hint: words.claim.noteHealth, value: signup.note, error: options.error, rows: 2, maxLength: MAX_LENGTH.note, required: signup.noteRequired })}${button(words.ui.save, 'secondary')}`
      )}</details>`
    : null;
  return html`<li id="${`s${signup.id}`}">
${dateStrip({ onDate: signup.onDate, startsAt: signup.startsAt, endsAt: signup.endsAt, label: signup.dateLabel, place: signup.datePlace || signup.sheetPlace, cancelled: signup.dateCancelled }, { heading: 'h3', extra: status })}
<p class="person-line"><span class="name">${signup.slotLabel}</span><a class="meta" href="${path(`/s/${signup.sheetSlug}`)}">${signup.sheetTitle}</a></p>
${notes}
${signup.note ? html`<p>${noteLabel}: ${signup.note}</p>` : null}
${options.fresh ? null : calendarButtons(signup, options.token, options.calendar.get(signup.id), options.links(signup), options.android)}
${noteForm}
${open
  ? html`<div class="actions">${signup.status === 'confirmed' ? linkButton(path(`/me/signups/${signup.id}/move`), m.move, 'secondary') : null}${linkButton(path(`/me/signups/${signup.id}/cancel`), signup.status === 'waiting' ? m.leaveWaitlist : m.cancel, 'danger')}</div>`
  : !signup.dateCancelled && signup.onDate >= civilToday(signup.sheetTimezone, options.now)
    ? html`<p class="hint">${lockedReason(signup)}</p>`
    : null}
</li>`;
}

export type MePageInput = {
  view: MeView;
  /** The person's link token (from their own cookie): their link, their calendar files. */
  token: string;
  origin: string;
  query: URLSearchParams;
  calendar: CalendarEntry[];
  android: boolean;
  /** A place they just left in the next 7 days that nobody moved into (`open=`). */
  askGroup: SlotWords | null;
  now: Date;
};

/** /me: the after-claim panel when `new=`, then every sign-up, their details, and their private link. */
export function meShell(page: MePageInput): Shell {
  const m = words.me;
  const { view, token, origin, now } = page;
  const link = privateLink(origin, token);
  const calendar = new Map(page.calendar.map((entry) => [entry.signupId, entry]));
  const links = (signup: MySignup): EventLinks => ({ host: origin.replace(/^https?:\/\//, ''), privateLink: link, sheetLink: sheetLink(origin, signup.sheetSlug) });
  const fresh = page.query.get('new');
  const just = fresh ? view.signups.find((signup) => signup.id === fresh) : undefined;
  const code = page.query.get('e');
  const noteFor = page.query.get('s');
  const upcoming = view.signups.filter((signup) => signup.onDate >= civilToday(signup.sheetTimezone, now));
  const earlier = view.signups.filter((signup) => signup.onDate < civilToday(signup.sheetTimezone, now));
  const firstTitle = (just ?? upcoming[0] ?? view.signups[0])?.sheetTitle ?? view.groupName ?? words.appName;
  const item = (signup: MySignup) =>
    signupItem(signup, {
      token,
      calendar,
      links,
      android: page.android,
      now,
      error:
        signup.id === noteFor && code?.startsWith('note')
          ? code === 'note'
            ? signup.noteLabel
              ? words.formErrors.noteLabelled(signup.noteLabel)
              : words.formErrors.note
            : fieldError(code, 'note')
          : null,
      // The sign-up just made has its calendar buttons in the panel above it, once.
      fresh: signup.id === just?.id
    });

  const toMyself: ShareText = { subject: words.share.toMyselfSubject, text: words.share.toMyself(firstTitle || words.appName, link) };
  // The heading names the box; its field's label says it again only to a screen reader.
  const privateBox = html`<section class="private" id="link">
<h2>${words.member.yourLink}</h2>
<p>${m.keepLink}</p>
${linkBox({ id: 'my-link', label: html`<span class="sr">${words.member.yourLink}</span>`, link, copyLabel: m.copyLink })}
<p class="hint">${words.member.accessCode}</p>
<details><summary>${m.sendToMyself}</summary><p class="hint">${m.sendToMyselfHint}</p>${toMyselfBox('to-myself', toMyself, view.contact)}</details>
</section>`;

  let panel: Html | null = null;
  if (just) {
    const when = sameDayWords(just, view.signups);
    const invite = inviteText(just.sheetTitle, sheetLink(origin, just.sheetSlug));
    panel = html`<section class="after">
${just.status === 'confirmed'
  ? html`<p class="done-line" role="status">${m.confirmedNew(just.slotLabel, when)}</p>${calendarButtons(just, token, calendar.get(just.id), links(just), page.android)}<p class="hint">${m.calendarHint} ${m.googleHint}</p>`
  : html`<p class="done-line waiting" role="status">${m.waitingNew(just.position ?? 1)}</p><p>${m.waitingHow}</p>${view.contact ? null : html`<p><a class="go" href="${anchor('details')}">${m.addContact}</a></p>`}`}
${privateBox}
<details><summary>${m.shareSheet}</summary>${shareBox({ id: 'invite', label: m.shareSheet, text: invite, links: shareLinks(invite) })}</details>
</section>`;
  }

  let ask: Html | null = null;
  if (page.askGroup) {
    const a = page.askGroup;
    const when = a.sameDay > 1 ? formatWhen(a.onDate, a.startsAt) : formatDate(a.onDate);
    const sheetUrl = sheetLink(origin, a.sheetSlug);
    const take: ShareText = { subject: words.share.askGroupSubject(a.sheetTitle), text: words.share.askGroupToTake(a.slotLabel, when, sheetUrl) };
    const organizer = view.organizerName || words.share.theOrganizer;
    const tell: ShareText = { subject: words.share.changedSubject(a.sheetTitle), text: words.share.tellOrganizer(organizer, a.slotLabel, when, a.sheetTitle, sheetUrl) };
    ask = html`<section class="box">
<h2>${m.askGroupHeading}</h2>
${shareBox({ id: 'ask-group', label: m.askGroupLine, text: take, links: shareLinks(take) })}
${shareBox({ id: 'tell-organizer', label: m.tellOrganizerLine, text: tell, links: view.organizerContact ? personLinks(tell, view.organizerContact) : shareLinks(tell) })}
</section>`;
  }

  // After a cancel: whether someone moved up into the place, and the way back to the sheet to pick another date.
  const leftSheet = page.query.get('sheet') ?? '';
  // A note refused for one sign-up (`s=`): the notice names it as that sheet does, as the field beside it does.
  const noted = code?.startsWith('note') ? view.signups.find((signup) => signup.id === noteFor) : undefined;
  const notices: (Notice | null)[] = [
    page.query.has('saved') ? { kind: 'done', body: m.saved } : null,
    page.query.has('cancelled')
      ? {
          kind: 'done',
          body: page.query.get('up') === '1' ? m.cancelledUp : m.cancelled,
          after: isSlug(leftSheet) ? html`<div class="actions">${linkButton(path(`/s/${leftSheet}`), m.pickAnother, 'secondary')}</div>` : undefined
        }
      : null,
    page.query.has('moved') ? { kind: 'done', body: m.moved } : null,
    noteNotice(page.query, noted?.noteLabel ?? '')
  ];
  const nameError = fieldError(code, 'name');
  const contactError = fieldError(code, 'contact');
  // The file with every sign-up, once there is more than the one each sign-up's own button gives.
  const calendarCount = page.calendar.filter((entry) => !entry.cancelled).length;

  const main = html`<h1>${words.member.pageTitle}</h1>
${panel}
${ask}
${upcoming.length > 0
  ? html`<h2>${m.placesHeading}</h2><ul class="rows">${upcoming.map(item)}</ul>`
  : html`<p>${m.none}</p><p><a class="go" href="${path('/')}">${words.member.seeSheet}</a></p>`}
${calendarCount > 1 ? html`<p><a class="button secondary" href="${path(`/me/${token}/calendar.ics`)}">${m.allCalendar}</a></p><p class="hint">${m.calendarHint}</p>` : null}
${earlier.length > 0 ? html`<details><summary>${m.earlier(earlier.length)}</summary><ul class="rows">${earlier.map(item)}</ul></details>` : null}
<section id="details">
<h2>${m.detailsHeading}</h2>
${postForm(
  path('/me/profile'),
  html`${input({ name: 'name', label: words.claim.name, value: view.name, required: true, maxLength: MAX_LENGTH.name, autocomplete: 'name', error: nameError })}
${input({ name: 'contact', label: words.claim.contact, hint: m.contactHint, value: view.contact, maxLength: MAX_LENGTH.contact, autocomplete: 'email', error: contactError, plain: true })}
${button(words.ui.save, 'secondary')}`
)}
</section>
${just ? null : privateBox}
<section class="box">
<h2>${m.newLink}</h2>
<p class="hint">${m.newLinkHint}</p>
${linkButton(path('/me/new-link'), m.newLink, 'secondary')}
</section>
<section>
${postForm(path('/forget'), html`${hidden('to', '/')}${button(m.forget, 'quiet')}`, 'inline')}
<p class="hint">${m.forgetHint}</p>
</section>`;

  const footer = view.organizerName
    ? html`<p>${m.questions(view.organizerName)} ${view.organizerContact}</p>`
    : null;
  return { ...PAGE, nav: { kind: 'member' }, notices, main, footer };
}

/** Why a sign-up's confirmation page has no form: the date cancelled, the sheet closed, or the date started. */
function lockedNotice(signup: MySignup): Notice {
  return { kind: 'info', body: signup.dateCancelled ? words.me.dateCancelled : lockedReason(signup) };
}

/** The cancel confirmation, with the message asking the group to swap instead. */
export function cancelShell(signup: MySignup, all: readonly MySignup[], origin: string, organizerName: string, now: Date): Shell {
  const m = words.me;
  const when = sameDayWords(signup, all);
  const question = signup.status === 'waiting' ? m.leaveQuestion(signup.slotLabel, when) : m.cancelQuestion(signup.slotLabel, when);
  const page = { ...PAGE, title: m.cancelTitle, nav: { kind: 'member' } } as const;
  if (!changeable(signup, now)) {
    return { ...page, notices: [lockedNotice(signup)], main: html`<h1>${signup.slotLabel}</h1><p><a class="go" href="${path('/me')}">${words.ui.back}</a></p>` };
  }
  const swap: ShareText = {
    subject: words.share.askGroupSubject(signup.sheetTitle),
    text: words.share.askGroupToSwap(signup.slotLabel, when, organizerName || words.share.theOrganizer, sheetLink(origin, signup.sheetSlug))
  };
  return {
    ...page,
    main: html`<h1>${question}</h1>
${dateStrip({ onDate: signup.onDate, startsAt: signup.startsAt, endsAt: signup.endsAt, label: signup.dateLabel, place: signup.datePlace || signup.sheetPlace })}
<div class="actions">${postForm(path(`/me/signups/${signup.id}/cancel`), button(m.yesCancel, 'danger'), 'inline')}${linkButton(path('/me'), m.keepIt, 'secondary')}</div>
${signup.status === 'confirmed' ? shareBox({ id: 'swap', label: m.swapInstead, text: swap, links: shareLinks(swap) }) : null}`
  };
}

/** The move page: places on the same sheet with room (after the people already waiting), ahead and not cancelled. */
export function moveShell(signup: MySignup, all: readonly MySignup[], sheet: PublicSheet, heldSlots: ReadonlySet<string>, query: URLSearchParams, now: Date): Shell {
  const m = words.me;
  const when = sameDayWords(signup, all);
  const page = { ...PAGE, title: m.moveTitle, nav: { kind: 'member' } } as const;
  if (!changeable(signup, now) || signup.status !== 'confirmed') {
    return {
      ...page,
      notices: [changeable(signup, now) ? { kind: 'info', body: words.formErrors.locked } : lockedNotice(signup)],
      main: html`<h1>${m.moveHeading(signup.slotLabel, when)}</h1><p><a class="go" href="${path('/me')}">${words.ui.back}</a></p>`
    };
  }
  const choices: Html[] = [];
  for (const date of sheet.dates) {
    if (date.cancelled || !isOpenForClaims(date.onDate, date.startsAt, sheet.timezone, now)) continue;
    const options = date.slots
      .filter((slot) => slot.id !== signup.slotId && !heldSlots.has(slot.id) && roomFor(slot) > 0)
      .map(
        (slot) =>
          html`<label class="choice"><input type="radio" name="to" value="${slot.id}" required><span>${slot.label}, ${dateWords(sheet.dates, date)}<span class="hint">${words.sheet.countLeft(roomFor(slot))}</span></span></label>`
      );
    if (options.length > 0) choices.push(...options);
  }
  return {
    ...page,
    notices: [codeNotice(query)],
    main: html`<h1>${m.moveHeading(signup.slotLabel, when)}</h1>
<p class="hint">${m.moveHint}</p>
${choices.length > 0
  ? postForm(path(`/me/signups/${signup.id}/move`), html`<fieldset class="choices"><legend>${m.moveLegend}</legend>${choices}</fieldset>${button(m.moveHere)}`)
  : html`<p>${m.noRoom}</p>`}
<p><a class="go" href="${path('/me')}">${words.ui.back}</a></p>`
  };
}

/** "Make a new private link?" */
export function newLinkConfirmShell(): Shell {
  const m = words.me;
  return {
    ...PAGE,
    title: m.newLinkTitle,
    nav: { kind: 'member' },
    main: html`<h1>${words.member.newLinkConfirm}</h1>
<div class="actions">${postForm(path('/me/new-link'), button(m.makeNewLink), 'inline')}${linkButton(path('/me'), m.keepMine, 'secondary')}</div>`
  };
}

/** After the member made a new link: send it to themselves (to their own saved contact, as on their page). */
export function sendLinkAfter(title: string, link: string, contact: string): Html {
  return toMyselfBox('send-link', { subject: words.share.toMyselfSubject, text: words.share.toMyself(title, link) }, contact);
}
