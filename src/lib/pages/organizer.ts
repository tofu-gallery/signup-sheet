// The organizer's front page (see TOFU.md, Organizer access): the page for each access state, and, once signed in, the
// dashboard: Needs attention first (people moved up or changed who have not been told, waitlists, open places this
// week, unpaid dues), then what is coming up with notes and contact buttons, the sheets, the group invite, and the
// weekly reminder. Organizer pages carry contacts and paid state; they are never public and never cached.
import { words } from '../../words';
import type { Organizer, OrganizerAccess } from '../access';
import { html, type Html, path } from '../html';
import type { Nav, Notice, Shell } from '../page';
import { inviteText, personLinks, type ShareText, shareLinks } from '../share';
import { addDays, civilToday, formatDate, formatMoment, isOpenForClaims } from '../time';
import { button, dateStrip, input, linkButton, personSendLinks, postButton, postForm, roomFor, sayWhen, select, shareBox } from '../ui';
import type { ComingDate, OrganizerHome, OrganizerSignupView, SheetSummary, ToTell } from '../views';
import { codeNotice, sheetLink } from './common';
import { setupMain } from './public';

export function organizerNav(organizer: Organizer): Nav {
  return { kind: 'organizer', via: organizer.via };
}

/** An organizer page's shell. */
export function orgShell(organizer: Organizer, title: string, main: Html, notices: (Notice | null | false)[] = []): Shell {
  return { title: `${title} · ${words.org.title}`, nav: organizerNav(organizer), notices, main };
}

/** /organizer for a browser that is not signed in: the page for the state (TOFU.md, Organizer access). */
export function stateShell(access: OrganizerAccess, query: URLSearchParams): Shell {
  const o = words.organizer;
  const sentence = (text: string): Shell => ({ title: words.org.title, nav: { kind: 'public' }, main: html`<h1>${words.org.title}</h1><p>${text}</p>` });
  switch (access.state) {
    case 'setup-open':
      return { title: o.setupOpen.heading, nav: { kind: 'none' }, main: setupMain() };
    case 'held':
      return { title: o.heldElsewhere.heading, nav: { kind: 'public' }, main: html`<h1>${o.heldElsewhere.heading}</h1><p>${o.heldElsewhere.line}</p>` };
    case 'password':
      return {
        title: o.signIn.heading,
        nav: { kind: 'public' },
        notices: [query.get('e') === 'wrong' ? { kind: 'error', body: o.signIn.wrong } : null],
        main: html`<h1>${o.signIn.heading}</h1>
${postForm(
  path('/organizer/sign-in'),
  html`<input type="text" name="username" value="organizer" autocomplete="username" hidden>
${input({ name: 'password', type: 'password', label: o.signIn.field, hint: o.signIn.hint, autocomplete: 'current-password', required: true, error: query.get('e') === 'wrong' ? o.signIn.wrong : null })}
${button(o.signIn.button)}`
)}
<p class="hint">${o.signIn.forgot}</p>`
      };
    case 'locked-short':
      return sentence(o.lockedShort);
    case 'locked-removed':
      return sentence(o.lockedRemoved);
    case 'locked-expired':
      return sentence(o.lockedExpired);
    case 'locked-unclaimed':
      return sentence(o.lockedUnclaimed);
  }
}

/** A date ahead (not before today in its sheet's time zone). */
function ahead(date: { onDate: string }, timezone: string, now: Date): boolean {
  return date.onDate >= civilToday(timezone, now);
}

/**
 * One person to tell, with the ready message to their own contact. Without one: a line for the group, except on a sheet
 * that hides names ("Taken"), where their own message is for the organizer to send them, never to the group.
 */
function tellItem(item: ToTell, origin: string, now: Date, index: number): Html {
  const o = words.org;
  const sh = words.share;
  const link = sheetLink(origin, item.sheetSlug);
  const when = sayWhen(item, item.sameDay);
  const soon = item.onDate <= addDays(civilToday(item.sheetTimezone, now), 1);
  const changed = item.changedAt !== null;
  // Someone with no private link (imported, or added by the organizer) is never told to use one.
  const calendar = item.hasLink ? sh.calendarWithLink : sh.calendarNoLink;
  const text: ShareText = changed
    ? { subject: sh.changedSubject(item.sheetTitle), text: sh.changedNow(item.name, item.slotLabel, when, item.sheetTitle, calendar, link) }
    : {
        subject: sh.movedUpSubject(item.sheetTitle),
        text: (item.hasLink ? sh.movedUp : sh.movedUpNoLink)(item.name, item.slotLabel, when, item.sheetTitle, link)
      };
  const group: ShareText = { subject: text.subject, text: changed ? text.text : sh.movedUpInGroup(item.name, when, item.slotLabel, link) };
  // The message itself is folded away: its buttons carry it whole, and the list stays short enough to read down.
  const box = item.contact
    ? shareBox({ id: `tell-${index}`, label: words.org.toPerson(item.name), text, links: personLinks(text, item.contact), share: false, collapsed: true })
    : item.sheetNames === 'taken'
      ? shareBox({ id: `tell-${index}`, label: sh.noContactNamesHidden, text, links: shareLinks(text), collapsed: true })
      : shareBox({ id: `tell-${index}`, label: sh.noContact, text: group, links: shareLinks(group), collapsed: true });
  return html`<li>
<h3 class="person-line"><span class="name">${changed ? o.changed(item.name) : o.movedUp(item.name)}</span>${soon ? html`<span class="tag soon">${o.soon}</span>` : null}</h3>
<p>${item.slotLabel}, ${when} · <a href="${path(`/organizer/sheets/${item.sheetSlug}`)}">${item.sheetTitle}</a></p>
${item.contact ? html`<p class="meta">${item.contact}</p>` : null}
${box}
${postButton(path(`/organizer/signups/${item.id}/told`), o.toldThem, 'secondary')}
</li>`;
}

/** The Text, Email and WhatsApp links that remind one person of an upcoming date. */
function reminderLinks(person: { name: string; contact: string }, slot: string, when: string, title: string, link: string): Html | null {
  const text: ShareText = { subject: words.share.remindSubject(title), text: words.share.remindOne(person.name, slot, when, title, link) };
  return personSendLinks(person.contact, text);
}

function comingBlock(date: ComingDate, origin: string, sameDay: number): Html {
  const link = sheetLink(origin, date.sheetSlug);
  const when = sayWhen(date, sameDay);
  return html`<section class="date">
${dateStrip({ onDate: date.onDate, startsAt: date.startsAt, endsAt: date.endsAt, label: date.label, place: date.place }, { heading: 'h3', extra: html`<a href="${path(`/organizer/sheets/${date.sheetSlug}`)}">${date.sheetTitle}</a>` })}
<ul class="slots">
${date.slots.map(
  (slot) => html`<li class="slot">
<span class="slot-name">${slot.label}</span>
<span class="count">${slot.confirmed >= slot.capacity ? words.sheet.countTaken(slot.confirmed, slot.capacity) : words.org.openLeft(slot.capacity - slot.confirmed)}</span>
<ul class="people">${slot.people.length > 0
    ? slot.people.map((person) => html`<li><span class="person-line"><span class="name">${person.name}</span>${person.note ? html`<span class="note">${person.note}</span>` : null}</span>${reminderLinks(person, slot.label, when, date.sheetTitle, link)}</li>`)
    : html`<li class="meta">${words.org.nobodyYet}</li>`}</ul>
</li>`
)}
</ul>
</section>`;
}

function sheetLine(sheet: SheetSummary, now: Date): Html {
  const o = words.org;
  const dates = sheet.dates.filter((date) => ahead(date, sheet.timezone, now) && !date.cancelled);
  const capacity = dates.reduce((n, date) => n + Number(date.capacity), 0);
  const confirmed = dates.reduce((n, date) => n + Number(date.confirmed), 0);
  return html`<li>
<p class="person-line"><a class="title" href="${path(`/organizer/sheets/${sheet.slug}`)}">${sheet.title}</a><span class="tag">${o.statusWords[sheet.status]}</span>${sheet.listed ? null : html`<span class="tag">${o.unlisted}</span>`}</p>
<p class="meta">${o.dateCount(dates.length)}${capacity > 0 ? html` · ${o.filled(confirmed, capacity)}` : null}</p>
</li>`;
}

export type DashboardInput = {
  home: OrganizerHome;
  organizer: Organizer;
  access: OrganizerAccess;
  origin: string;
  query: URLSearchParams;
  /** The sign-up just marked told (`told=`), for its Undo. */
  told: OrganizerSignupView | null;
  now: Date;
};

export function dashboardShell(page: DashboardInput): Shell {
  const o = words.org;
  const { home, now, origin } = page;
  const toTell = home.toTell
    .filter((item) => ahead(item, item.sheetTimezone, now))
    .sort((a, b) => (a.onDate < b.onDate ? -1 : a.onDate > b.onDate ? 1 : 0));
  const sheetsAhead = home.sheets.map((sheet) => ({ sheet, dates: sheet.dates.filter((date) => ahead(date, sheet.timezone, now) && !date.cancelled) }));
  const waitlists = sheetsAhead
    .map(({ sheet, dates }) => ({ sheet, waiting: dates.reduce((n, date) => n + Number(date.waiting), 0) }))
    .filter((entry) => entry.waiting > 0);
  const coming = home.coming.filter((date) => {
    const today = civilToday(date.sheetTimezone, now);
    return date.onDate >= today && date.onDate <= addDays(today, 6);
  });
  // A date with no places has nothing for this week's reminder to say (the sheet page's own button counts the same).
  const weekSheets = [...new Set(coming.filter((date) => date.slots.length > 0).map((date) => date.sheetSlug))];
  const openSoon = coming.flatMap((date) =>
    isOpenForClaims(date.onDate, date.startsAt, date.sheetTimezone, now)
      ? date.slots.filter((slot) => roomFor(slot) > 0).map((slot) => ({ date, slot }))
      : []
  );
  const unpaid = home.unpaid ?? 0;

  const attention: Html[] = [];
  if (toTell.length > 0) attention.push(html`<ul class="rows">${toTell.map((item, index) => tellItem(item, origin, now, index))}</ul>`);
  if (waitlists.length > 0) {
    attention.push(
      html`<ul class="rows">${waitlists.map(({ sheet, waiting }) => html`<li><p>${o.waitingOn(waiting, sheet.title)}</p><div class="actions">${linkButton(path(`/organizer/sheets/${sheet.slug}/share/waitlist`), waitlists.length > 1 ? `${o.messageWaitlist}: ${sheet.title}` : o.messageWaitlist, 'secondary')}</div></li>`)}</ul>`
    );
  }
  if (openSoon.length > 0) {
    attention.push(
      html`<h3>${o.openSoon}</h3><ul class="rows">${openSoon.map(({ date, slot }) => html`<li>${slot.label}, ${formatDate(date.onDate)} · ${date.sheetTitle}: ${o.openLeft(roomFor(slot))}</li>`)}</ul>`
    );
  }
  if (home.unpaid !== null && unpaid > 0) attention.push(html`<div class="actions">${linkButton(path('/organizer/people?unpaid=1'), o.unpaid(unpaid), 'secondary')}</div>`);

  // This week's reminder, the organizer's weekly job, first on the page: one button per open sheet, or, with nothing in
  // the next 7 days, the same button disabled saying so.
  const openSheets = home.sheets.filter((sheet) => sheet.status === 'open');
  const reminders =
    openSheets.length === 0
      ? null
      : html`<div class="actions">${openSheets.map((sheet) => {
          const named = openSheets.length > 1;
          return weekSheets.includes(sheet.slug)
            ? linkButton(path(`/organizer/sheets/${sheet.slug}/share/week`), named ? `${o.weekReminder}: ${sheet.title}` : o.weekReminder, 'primary')
            : html`<button type="button" class="secondary" disabled>${named ? `${sheet.title}: ${o.nothingThisWeek}` : o.nothingThisWeek}</button>`;
        })}</div>`;

  // When the seat ends, in the first sheet's time zone (by its name, where the form offers it), else in UTC.
  const zone = home.sheets[0]?.timezone ?? null;
  const zoneName = zone ? ((words.timeZones as Record<string, string>)[zone] ?? zone) : null;
  const seatBanner =
    page.organizer.via === 'seat' && page.access.seat
      ? html`<div class="box">
<p>${words.organizer.seatBanner(words.access.seatUntil(formatMoment(page.access.seat.until, zone ?? 'UTC'), zoneName))}</p>
<details><summary>${words.organizer.giveUp}</summary><p class="hint">${words.access.seatGiveUpHint}</p>${postButton(path('/organizer/give-up'), words.organizer.giveUpYes, 'danger')}</details>
</div>`
      : null;

  const invites = openSheets.map((sheet) => {
    const text = inviteText(sheet.title, sheetLink(origin, sheet.slug));
    return shareBox({ id: `invite-${sheet.id}`, label: openSheets.length > 1 ? sheet.title : o.inviteHint, text, links: shareLinks(text) });
  });

  const notices: (Notice | null)[] = [
    page.query.has('deleted') ? { kind: 'done', body: o.deleted } : null,
    page.told
      ? {
          kind: 'done',
          body: html`${o.toldDone(page.told.name)} ${postButton(path(`/organizer/signups/${page.told.id}/untold`), o.undo, 'quiet')}`
        }
      : null,
    codeNotice(page.query)
  ];

  const days = words.calendar.weekdaysLong.map((label, index) => ({ value: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][index]!, label }));
  const main = html`${seatBanner}
<h1>${home.group.groupName || o.heading}</h1>
${reminders}
<section id="attention">
<h2>${o.attention}</h2>
${attention.length > 0 ? attention : html`<p>${o.calm}</p>`}
</section>
${coming.length > 0
  ? html`<section id="coming"><h2>${o.comingUp}</h2>${coming.map((date) =>
      comingBlock(date, origin, home.coming.filter((other) => other.sheetSlug === date.sheetSlug && other.onDate === date.onDate).length)
    )}</section>`
  : null}
<section id="sheets">
<h2>${o.sheets}</h2>
${home.sheets.length > 0 ? html`<ul class="rows sheets-list">${home.sheets.map((sheet) => sheetLine(sheet, now))}</ul>` : html`<p>${o.noSheets}</p>`}
<div class="actions">${linkButton(path('/organizer/sheets/new'), o.newSheet)}${linkButton(path('/organizer/import'), o.importFile, 'secondary')}</div>
</section>
${invites.length > 0 ? html`<section id="invite"><h2>${o.invite}</h2>${invites}</section>` : null}
<section id="remind">
<h2>${o.remindWeekly}</h2>
<p class="hint">${o.remindHint}</p>
<form method="get" action="${path('/organizer/reminder.ics')}" class="stack">
<div class="split">
${select({ name: 'day', label: o.remindDay, choices: days, value: 'thu' })}
${input({ name: 'time', type: 'time', label: o.remindTime, value: '18:00', required: true })}
</div>
${button(o.remindButton, 'secondary')}
</form>
</section>
<section id="data">
<h2>${o.exportHeading}</h2>
<p class="hint">${o.exportLine}</p>
<p class="hint">${o.exportRestoreShort}</p>
<p><a class="button secondary" href="${path('/organizer/export.json')}">${o.exportAll}</a></p>
</section>`;

  return orgShell(page.organizer, home.group.groupName || o.heading, main, notices);
}
