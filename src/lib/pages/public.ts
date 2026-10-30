// The public pages (see TOFU.md, Pages and Privacy): the home page, a sheet, and the claim form. They are made only from
// the public view (views.ts publicSheetView): names (none on a sheet that shows "Taken"), notes, counts and the words of
// the sheet. Never a contact, a paid state, a token, a person's id or a sign-up's time. The one personal thing is the
// phone's own remembered person: their name and their own places, never their contact.
import { words } from '../../words';
import { anchor, flag, type Href, html, type Html, path } from '../html';
import type { Notice, Shell } from '../page';
import { civilToday, formatDate, isOpenForClaims } from '../time';
import {
  button,
  countText,
  dateStrip,
  errorSentence,
  fieldError,
  hidden,
  input,
  linkButton,
  paragraphs,
  postForm,
  roomFor,
  textarea
} from '../ui';
import { MAX_LENGTH } from '../validation';
import type { ListedSheet, MyPlaces, PublicSheet } from '../views';
import { codeNotice, publicFooter } from './common';

type PublicDate = PublicSheet['dates'][number];
type PublicSlot = PublicDate['slots'][number];

/**
 * The setup page: `/` and `/organizer` while setup is open (TOFU.md, Organizer access). The only way to take the seat is
 * its POST.
 */
export function setupMain(): Html {
  const s = words.organizer.setupOpen;
  return html`<h1>${s.heading}</h1>
<p>${s.line}</p>
<p class="hint">${s.tofuNote}</p>
${postForm(path('/organizer/setup'), button(s.button))}
<p class="hint">${s.note}</p>`;
}

export function setupShell(): Shell {
  return { title: words.organizer.setupOpen.heading, nav: { kind: 'none' }, main: setupMain() };
}

/** The home page with no open sheet, or with several. */
export function homeShell(groupName: string, organizerName: string, sheets: readonly ListedSheet[], now: Date): Shell {
  const h = words.home;
  const heading = groupName || h.title;
  if (sheets.length === 0) {
    return {
      title: heading,
      nav: { kind: 'public' },
      main: html`<h1>${heading}</h1><p class="sentence-line">${h.nothingOpen}</p><p class="hint">${h.nothingOpenHint}</p>`,
      footer: publicFooter(organizerName)
    };
  }
  const items = sheets.map((sheet) => {
    const today = civilToday(sheet.timezone, now);
    const next = sheet.dates.find((date) => date.onDate >= today);
    return html`<li>
<a class="title" href="${path(`/s/${sheet.slug}`)}">${sheet.title}</a>
${sheet.description ? html`<p class="meta">${sheet.description.split('\n')[0]}</p>` : null}
<p class="meta">${next ? h.next(formatDate(next.onDate)) : h.noneAhead}${sheet.place ? html`<br>${sheet.place}` : null}</p>
</li>`;
  });
  return {
    title: heading,
    nav: { kind: 'public' },
    main: html`<h1>${heading}</h1><h2>${h.openSheets}</h2><ul class="rows sheets-list">${items}</ul>`,
    footer: publicFooter(organizerName)
  };
}

/** Whether a date of this sheet still takes claims (not cancelled, before its start). */
function claimable(sheet: PublicSheet, date: PublicDate, now: Date): boolean {
  return !date.cancelled && isOpenForClaims(date.onDate, date.startsAt, sheet.timezone, now);
}

/** What a Take it link is for, for a screen reader (its visible words stay "Take it"): the place and the day. */
function placeWords(slot: { label: string }, date: { onDate: string }): Html {
  return html`<span class="sr">: ${slot.label}, ${formatDate(date.onDate)}</span>`;
}

function slotItem(sheet: PublicSheet, date: PublicDate, slot: PublicSlot, options: { actions: boolean; mine: MyPlaces['places'][number] | undefined; now: Date }): Html {
  const s = words.sheet;
  const people = slot.entries.map(
    (entry) => html`<li>${entry.name ?? s.taken}${entry.note ? html` <span class="note">${entry.note}</span>` : null}</li>`
  );
  let action: Html | null = null;
  // A cancelled date shows who was on it, but no count and no "You're in": nothing happens that day.
  if (options.mine && !date.cancelled) {
    const waiting = options.mine.status !== 'confirmed';
    action = html`<span class="${waiting ? 'take mine waiting' : 'take mine'}">${waiting ? s.youreWaiting(options.mine.position ?? 1) : s.youreIn}</span>`;
  } else if (!options.mine && options.actions && claimable(sheet, date, options.now)) {
    const href = path(`/s/${sheet.slug}/slots/${slot.id}`);
    action =
      roomFor(slot) > 0
        ? html`<a class="button primary take" href="${href}">${s.takeIt}${placeWords(slot, date)}</a>`
        : html`<a class="button secondary take" href="${href}">${s.joinWaitlist}${placeWords(slot, date)}</a>`;
  }
  return html`<li class="slot">
<div class="slot-main"><span class="slot-name">${slot.label}</span><span class="count">${date.cancelled ? s.cancelled : countText(slot)}</span>${slot.description ? html`<span class="slot-description">${slot.description}</span>` : null}</div>
${action}
${people.length > 0 ? html`<ul class="people">${people}</ul>` : null}
</li>`;
}

function dateBlock(sheet: PublicSheet, date: PublicDate, options: { actions: boolean; mine: Map<string, MyPlaces['places'][number]>; now: Date }): Html {
  const place = date.place && date.place !== sheet.place ? date.place : '';
  return html`<section class="date">
${dateStrip({ ...date, place })}
${date.slots.length > 0 ? html`<ul class="slots">${date.slots.map((slot) => slotItem(sheet, date, slot, { actions: options.actions, mine: options.mine.get(slot.id), now: options.now }))}</ul>` : null}
</section>`;
}

/** The first box on the sheet: this phone's own places, and the next open place with its Take it. */
function leadBox(sheet: PublicSheet, ahead: readonly PublicDate[], remembered: MyPlaces | null, now: Date): Html | null {
  const s = words.sheet;
  const mine = remembered?.places ?? [];
  const slots = new Map<string, { date: PublicDate; slot: PublicSlot }>();
  for (const date of sheet.dates) for (const slot of date.slots) slots.set(slot.id, { date, slot });
  const mineLines = mine
    .map((place) => slots.get(place.slotId))
    .filter((found): found is { date: PublicDate; slot: PublicSlot } => Boolean(found))
    .sort((a, b) => (a.date.onDate < b.date.onDate ? -1 : a.date.onDate > b.date.onDate ? 1 : 0))
    .map(({ date, slot }) => {
      const place = mine.find((each) => each.slotId === slot.id)!;
      const status = date.cancelled ? s.mineCancelled : place.status === 'waiting' ? s.statusWaiting(place.position ?? 1) : null;
      return html`<li>${slot.label}, ${formatDate(date.onDate)}${status ? html` (${date.cancelled ? html`<strong>${status}</strong>` : status})` : null}</li>`;
    });

  let next: { date: PublicDate; slot: PublicSlot } | null = null;
  let open = 0;
  for (const date of ahead) {
    if (!claimable(sheet, date, now)) continue;
    for (const slot of date.slots) {
      const room = roomFor(slot);
      open += room;
      if (room > 0 && !next && !mine.some((place) => place.slotId === slot.id)) next = { date, slot };
    }
  }
  const anyClaimable = ahead.some((date) => claimable(sheet, date, now) && date.slots.length > 0);
  if (!remembered && !anyClaimable) return null;

  return html`<div class="lead">
${remembered
  ? html`<p>${s.signedUpAs(remembered.name)}</p>${mineLines.length > 0 ? html`<p>${s.yourPlaces}</p><ul class="mine-list">${mineLines}</ul>` : null}<div class="actions">${linkButton(path('/me'), s.changeOrCancel, 'secondary')}</div>`
  : null}
${next
  ? html`<p><strong>${s.nextOpen(next.slot.label, formatDate(next.date.onDate))}</strong><br>${s.placesOpen(open)}</p><div class="actions">${linkButton(path(`/s/${sheet.slug}/slots/${next.slot.id}`), html`${s.takeIt}${placeWords(next.slot, next.date)}`)}</div>`
  : anyClaimable
    ? html`<p>${s.allFull}</p>`
    : null}
</div>`;
}

export type SheetPageInput = {
  sheet: PublicSheet;
  remembered: MyPlaces | null;
  /** The organizer looking at a draft. */
  preview: boolean;
  query: URLSearchParams;
  now: Date;
  /** Set when the sheet is shown in place on the home page: its own address. */
  canonical: Href | null;
};

/** A sheet: dates from today on with their places, earlier dates folded away, the lead box first. */
export function sheetShell(input: SheetPageInput): Shell {
  const { sheet, now } = input;
  const s = words.sheet;
  const today = civilToday(sheet.timezone, now);
  const ahead = sheet.dates.filter((date) => date.onDate >= today);
  const earlier = sheet.dates.filter((date) => date.onDate < today);
  // A draft's preview shows the sheet as people will see it, without its buttons: nobody can sign up for a draft.
  const actions = sheet.status === 'open';
  const mine = new Map((input.remembered?.places ?? []).map((place) => [place.slotId, place]));

  const notices: (Notice | null)[] = [
    input.preview && sheet.status === 'draft'
      ? { kind: 'info', body: html`${s.draft} <a href="${path(`/organizer/sheets/${sheet.slug}`)}">${s.organizerView}</a>` }
      : null,
    sheet.status === 'closed' ? { kind: 'info', body: s.closed } : null,
    input.query.has('signedup') ? { kind: 'done', body: words.member.signedUpNoLink } : null,
    codeNotice(input.query)
  ];
  const seasonOver = sheet.dates.length > 0 && ahead.length === 0;

  const main = html`${sheet.groupName ? html`<p class="group">${sheet.groupName}</p>` : null}
<h1>${sheet.title}</h1>
${paragraphs(sheet.description)}
${sheet.place ? html`<p class="place-line">${sheet.place}</p>` : null}
${sheet.status === 'open' ? leadBox(sheet, ahead, input.remembered, now) : null}
${seasonOver ? html`<p class="sentence-line"><strong>${words.seasonOver}</strong></p>` : null}
${sheet.dates.length === 0 ? html`<p>${s.noDates}</p>` : null}
${ahead.map((date) => dateBlock(sheet, date, { actions, mine, now }))}
${earlier.length > 0
  ? html`<details class="earlier"><summary>${s.earlier(earlier.length)}</summary>${earlier.map((date) => dateBlock(sheet, date, { actions: false, mine, now }))}</details>`
  : null}`;

  return {
    title: sheet.groupName ? `${sheet.title} · ${sheet.groupName}` : sheet.title,
    canonical: input.canonical,
    nav: { kind: 'public' },
    notices,
    main,
    footer: publicFooter(sheet.organizerName)
  };
}

// --- The claim form ------------------------------------------------------------------------------------------------

export type ClaimValues = { name: string; contact: string; note: string };

export type ClaimPageInput = {
  sheet: PublicSheet;
  date: PublicDate;
  slot: PublicSlot;
  /** The person this phone remembers: their name only, never their contact; `here` when they hold this place. */
  remembered: { name: string; here: boolean } | null;
  /** The form that was sent and is shown again: `me` (the remembered person) or `new`; null for a fresh page. */
  sent: 'me' | 'new' | null;
  /** One request id per form on the page. A form shown again keeps its own, so sending it twice signs up once. */
  rids: { me: string; new: string };
  /** What was typed into the form that is shown again. */
  values: ClaimValues;
  /** The refusal to show: a `?e=` code. */
  code: string | null;
  now: Date;
};

const EMPTY: ClaimValues = { name: '', contact: '', note: '' };

function noteField(page: ClaimPageInput, id: string, value: string, error: string | null): Html {
  const c = words.claim;
  const { sheet } = page;
  const label = sheet.noteLabel
    ? sheet.noteRequired
      ? sheet.noteLabel
      : `${sheet.noteLabel} ${words.ui.optional}`
    : sheet.noteRequired
      ? words.fields.note
      : c.note;
  const hint = html`${sheet.names === 'taken' ? c.takenNoteHint : c.noteHint} ${c.noteHealth}`;
  return textarea({ name: 'note', id, label, hint, value, error, rows: 2, maxLength: MAX_LENGTH.note, required: sheet.noteRequired });
}

function honeypot(id: string): Html {
  return html`<div class="hp" aria-hidden="true"><label for="${id}">${words.claim.honeypot}</label><input id="${id}" name="ss_hp" type="text" value="" tabindex="-1" autocomplete="off"></div>`;
}

/**
 * The claim form. Shown again after a refusal, it keeps what was typed and the same request id, with the sentence at
 * the top (an alert) and next to the field it is about.
 */
export function claimShell(page: ClaimPageInput): Shell {
  const c = words.claim;
  const { sheet, date, slot } = page;
  const back = path(`/s/${sheet.slug}`);
  const action = path(`/s/${sheet.slug}/slots/${slot.id}/claim`);
  const top = html`<p class="group">${sheet.groupName ? `${sheet.groupName} · ${sheet.title}` : sheet.title}</p>
<h1>${slot.label}</h1>
${dateStrip({ ...date, place: date.place || sheet.place })}
${slot.description ? html`<p>${slot.description}</p>` : null}
<p class="count">${countText(slot)}</p>`;
  const shell = (notices: (Notice | null)[], body: Html | null): Shell => ({
    title: `${slot.label} · ${sheet.title}`,
    nav: { kind: 'public' },
    notices,
    main: html`${top}${body}<p><a class="go" href="${back}">${c.backToSheet}</a></p>`,
    footer: publicFooter(sheet.organizerName)
  });

  if (sheet.status !== 'open') return shell([{ kind: 'info', body: words.formErrors.closed }], null);
  if (date.cancelled) return shell([{ kind: 'info', body: words.formErrors.cancelled }], null);
  if (!isOpenForClaims(date.onDate, date.startsAt, sheet.timezone, page.now)) return shell([{ kind: 'info', body: words.formErrors.past }], null);

  const room = roomFor(slot);
  const label = room > 0 ? c.signUp : c.joinWaitlist(slot.waiting + 1);
  const taken = sheet.names === 'taken';
  const code = page.code;
  // The form that was sent; a form for the remembered person whose link stopped working comes back as the plain one.
  const sent = page.sent === 'me' && !page.remembered ? 'new' : page.sent;
  // The note as the sheet calls it, in the sentences about it ("What you'll bring: …").
  const noteMissing = sheet.noteLabel ? words.formErrors.noteLabelled(sheet.noteLabel) : words.formErrors.note;
  // A field's own error, only on the form that was sent.
  const errorOn = (form: 'me' | 'new', field: 'name' | 'contact' | 'note'): string | null => {
    if (sent !== null && sent !== form) return null;
    if (field === 'note' && code === 'note') return noteMissing;
    return fieldError(code, field, null, { note: MAX_LENGTH.note });
  };
  const valuesOf = (form: 'me' | 'new'): ClaimValues => (sent === form ? page.values : EMPTY);

  // `other`: the form in "Sign up someone else", whose fields are about the other person, never this phone's own.
  const newFields = (id: 'new' | 'other'): Html => {
    const v = valuesOf('new');
    const other = id === 'other';
    const privacy = other ? (taken ? c.theirPrivacyTaken(sheet.noteLabel) : c.theirPrivacy(sheet.noteLabel)) : taken ? c.privacyTaken(sheet.noteLabel) : c.privacy(sheet.noteLabel);
    return html`${hidden('rid', page.rids.new)}
${input({ name: 'name', id: `${id}-name`, label: other ? c.theirName : c.name, hint: c.nameHint, value: v.name, error: errorOn('new', 'name'), required: true, maxLength: MAX_LENGTH.name, autocomplete: other ? 'off' : 'name' })}
${input({ name: 'contact', id: `${id}-contact`, label: other ? c.theirContact : c.contact, hint: c.contactHint, value: v.contact, error: errorOn('new', 'contact'), maxLength: MAX_LENGTH.contact, autocomplete: other ? 'off' : 'email', plain: true })}
${noteField(page, `${id}-note`, v.note, errorOn('new', 'note'))}
${honeypot(`${id}-hp`)}
<p class="hint">${privacy}</p>
${button(label)}`;
  };

  let form: Html;
  if (page.remembered?.here) {
    form = html`<p>${c.signingUpAs(page.remembered.name)}</p>
<p><strong>${c.already}</strong></p>
<div class="actions">${linkButton(path('/me'), words.sheet.changeOrCancel, 'secondary')}</div>
<details${flag('open', sent === 'new')}><summary>${c.someoneElse}</summary><p class="hint">${c.someoneElseHint}</p>${postForm(action, newFields('other'))}</details>`;
  } else if (page.remembered) {
    const v = valuesOf('me');
    form = html`<p>${c.signingUpAs(page.remembered.name)}</p>
${postForm(path('/forget'), html`${hidden('to', `/s/${sheet.slug}/slots/${slot.id}`)}${button(c.notYou, 'quiet')}`, 'inline')}
${postForm(
  action,
  html`${hidden('rid', page.rids.me)}${hidden('as', 'me')}
${input({ name: 'contact', id: 'me-contact', label: c.contact, hint: c.contactKeep, value: v.contact, error: errorOn('me', 'contact'), maxLength: MAX_LENGTH.contact, autocomplete: 'email', plain: true })}
${noteField(page, 'me-note', v.note, errorOn('me', 'note'))}
${honeypot('me-hp')}
<p class="hint">${taken ? c.privacyTaken(sheet.noteLabel) : c.privacy(sheet.noteLabel)}</p>
${button(label)}`
)}
<details${flag('open', sent === 'new')}><summary>${c.someoneElse}</summary><p class="hint">${c.someoneElseHint}</p>${postForm(action, newFields('other'))}</details>`;
  } else {
    form = postForm(action, newFields('new'));
  }

  // The sentence at the top: a field's refusal names the field as the sheet calls it, and leads to it.
  const sentence = code === 'note' ? noteMissing : code ? (errorSentence(code, null, { names: { note: sheet.noteLabel || words.fields.note } }) ?? words.formErrors.form) : null;
  const field = /^(name|contact|note)(?:-|$)/.exec(code ?? '')?.[1];
  const formId = sent === 'me' ? 'me' : page.remembered ? 'other' : 'new';
  const body = sentence && field ? html`<a href="${anchor(`${formId}-${field}`)}">${sentence}</a>` : sentence;
  return shell(
    [body ? { kind: 'error', body } : null],
    html`${room === 0 && !page.remembered?.here ? html`<p>${c.full}</p>` : null}${form}`
  );
}
