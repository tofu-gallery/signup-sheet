// The organizer's pages for one sheet (see TOFU.md, Pages): the sheet with every date, place and person on it, and a
// focused page for each change (the sheet's settings, adding and editing a date or a place, adding, moving and swapping
// someone, cancelling a date, deleting) with its confirmation, "Add a date every week", and the two share pages.
// Organizer only: these pages carry contacts. A form shown again after a refusal keeps what was typed.
import { words } from '../../words';
import type { Organizer } from '../access';
import { anchor, type Child, type Href, html, type Html, path, shareHref } from '../html';
import type { Notice, Shell } from '../page';
import { bccLink, reachOf, type ShareText, shareLinks, waitlistMessages, weekText } from '../share';
import type { DeletionPreview } from '../structure';
import { addDays, civilToday, dateWords, formatDate, formatMoment, formatTimes, formatWhen, isOpenForClaims, TIME_ZONE_CHOICES, weekdayIndex } from '../time';
import {
  button,
  checkbox,
  countText,
  dateStrip,
  errorSentence,
  fieldError,
  hidden,
  input,
  linkButton,
  paragraphs,
  postButton,
  postForm,
  radios,
  roomFor,
  sayWhen,
  select,
  shareBox,
  tellList,
  textarea
} from '../ui';
import { MAX_LENGTH } from '../validation';
import type { OrganizerDateView, OrganizerSheet, OrganizerSignup, OrganizerSignupView, OrganizerSlotView, PublicSheet } from '../views';
import { flagNotice, sheetLink } from './common';
import { orgShell } from './organizer';

type AdminDate = OrganizerSheet['dates'][number];
type AdminSlot = AdminDate['slots'][number];

const o = words.org;

/** HH:MM for a form field ('' for none); the database answers HH:MM:SS. */
function hhmm(time: string | null): string {
  return time?.slice(0, 5) ?? '';
}

/** A date of an open, not cancelled, not yet started kind: people can still be added, moved or swapped into it. */
function takesPeople(sheet: { timezone: string }, date: { onDate: string; startsAt: string | null; cancelled: boolean }, now: Date): boolean {
  return !date.cancelled && isOpenForClaims(date.onDate, date.startsAt, sheet.timezone, now);
}

// On a date's forms, `label` is the date's label, not a place's name.
const DATE_NAMES = { label: words.fields.dateLabel };

function errorNotice(code: string | null, n: string | null = null, names: Record<string, string> = {}): Notice | null {
  const sentence = errorSentence(code, n, { names });
  return sentence ? { kind: 'error', body: sentence } : null;
}

/** The number of different email addresses among these contacts. */
function emailCount(contacts: readonly string[]): number {
  return new Set(contacts.map((contact) => reachOf(contact).email).filter(Boolean)).size;
}

function backToSheet(slug: string): Html {
  return html`<p><a class="go" href="${path(`/organizer/sheets/${slug}`)}">${o.backToSheet}</a></p>`;
}

/** A link that deletes something (after its confirmation): red, apart from the links that only change things. */
function deleteLink(href: Href, label: string): Html {
  return html`<a class="go danger-link" href="${href}">${label}</a>`;
}

// --- The sheet's form (new and edit) -------------------------------------------------------------------------------

export type SheetValues = {
  title: string;
  slug: string;
  description: string;
  timezone: string;
  timezoneOther: string;
  place: string;
  names: string;
  noteLabel: string;
  noteRequired: boolean;
  listed: boolean;
  status: string;
};

export const NEW_SHEET: SheetValues = {
  title: '',
  slug: '',
  description: '',
  timezone: 'America/New_York',
  timezoneOther: '',
  place: '',
  names: 'full',
  noteLabel: '',
  noteRequired: false,
  listed: true,
  status: 'draft'
};

/** What the form sent, to show it again after a refusal. */
export function sheetValuesFrom(form: URLSearchParams): SheetValues {
  const get = (name: string) => form.get(name) ?? '';
  return {
    title: get('title'),
    slug: get('slug'),
    description: get('description'),
    timezone: get('timezone'),
    timezoneOther: get('timezoneOther'),
    place: get('place'),
    names: get('names') || 'full',
    noteLabel: get('noteLabel'),
    noteRequired: get('noteRequired') === '1',
    listed: get('listed') !== '0',
    status: get('status') || 'draft'
  };
}

export function sheetValuesOf(sheet: OrganizerSheet): SheetValues {
  const listedZone = (TIME_ZONE_CHOICES as readonly string[]).includes(sheet.timezone);
  return {
    title: sheet.title,
    slug: sheet.slug,
    description: sheet.description,
    timezone: listedZone ? sheet.timezone : 'other',
    timezoneOther: listedZone ? '' : sheet.timezone,
    place: sheet.place,
    names: sheet.names,
    noteLabel: sheet.noteLabel,
    noteRequired: sheet.noteRequired,
    listed: sheet.listed,
    status: sheet.status
  };
}

function sheetFields(values: SheetValues, code: string | null, options: { isNew: boolean; timezoneLocked: string | null }): Html {
  const zones = [
    ...TIME_ZONE_CHOICES.map((zone) => ({ value: zone, label: `${words.timeZones[zone]} (${zone})` })),
    { value: 'other', label: words.timeZones.other }
  ];
  const zoneChosen = (TIME_ZONE_CHOICES as readonly string[]).includes(values.timezone) || values.timezone === 'other' ? values.timezone : 'other';
  const zoneTyped = zoneChosen === 'other' && values.timezone !== 'other' && !values.timezoneOther ? values.timezone : values.timezoneOther;
  const timezone = options.timezoneLocked
    ? html`${hidden('timezone', options.timezoneLocked)}<p class="field"><strong>${words.fields.timezone}:</strong> ${options.timezoneLocked}<br><span class="hint">${o.timezoneLocked}</span></p>`
    : html`${select({ name: 'timezone', label: o.timezone, choices: zones, value: zoneChosen, error: fieldError(code, 'timezone') })}
${input({ name: 'timezoneOther', label: o.otherTimezone, hint: o.otherTimezoneHint, value: zoneTyped, maxLength: 64 })}`;
  return html`${input({ name: 'title', label: o.sheetTitle, value: values.title, required: true, maxLength: MAX_LENGTH.sheetTitle, error: fieldError(code, 'title') })}
${options.isNew ? input({ name: 'slug', label: o.slug, hint: o.slugHint, value: values.slug, required: true, maxLength: 40, pattern: '[a-z0-9][a-z0-9-]{0,38}[a-z0-9]|[a-z0-9]', autocomplete: 'off', error: fieldError(code, 'slug') }) : null}
${textarea({ name: 'description', label: o.description, value: values.description, rows: 3, maxLength: MAX_LENGTH.sheetDescription, error: fieldError(code, 'description', null, { description: MAX_LENGTH.sheetDescription }) })}
${timezone}
${input({ name: 'place', label: o.place, value: values.place, maxLength: MAX_LENGTH.place, error: fieldError(code, 'place') })}
${radios({ name: 'names', legend: o.namesLegend, value: values.names, error: fieldError(code, 'names'), choices: [{ value: 'full', label: o.namesFull }, { value: 'taken', label: o.namesTaken }] })}
${input({ name: 'noteLabel', label: o.noteLabel, hint: o.noteLabelHint, value: values.noteLabel, maxLength: MAX_LENGTH.noteLabel, error: fieldError(code, 'noteLabel') })}
${checkbox({ name: 'noteRequired', label: o.noteRequired, checked: values.noteRequired })}
${radios({ name: 'listed', legend: o.listedLegend, value: values.listed ? '1' : '0', choices: [{ value: '1', label: o.listedYes }, { value: '0', label: o.listedNo }] })}
${options.isNew
  ? radios({
      name: 'status',
      legend: o.statusLegend,
      value: values.status,
      error: fieldError(code, 'status'),
      choices: (['draft', 'open', 'closed'] as const).map((status) => ({ value: status, label: o.statusWords[status], hint: o.statusHint[status] }))
    })
  : null}`;
}

export function newSheetShell(organizer: Organizer, values: SheetValues, code: string | null): Shell {
  return orgShell(
    organizer,
    o.newSheetHeading,
    html`<h1>${o.newSheetHeading}</h1>
${postForm(path('/organizer/sheets'), html`${sheetFields(values, code, { isNew: true, timezoneLocked: null })}${button(o.create)}`)}
<p><a href="${path('/organizer')}">${words.ui.back}</a></p>`,
    [errorNotice(code)]
  );
}

/** Whether anyone is signed up on the sheet: its time zone then stays as it is. */
function hasSignups(sheet: OrganizerSheet): boolean {
  return sheet.dates.some((date) => date.slots.some((slot) => slot.signups.length > 0));
}

export function editSheetShell(organizer: Organizer, sheet: OrganizerSheet, values: SheetValues, code: string | null): Shell {
  return orgShell(
    organizer,
    o.editSheet,
    html`<p class="group">${sheet.title}</p>
<h1>${o.editSheet}</h1>
${postForm(path(`/organizer/sheets/${sheet.slug}/edit`), html`${sheetFields(values, code, { isNew: false, timezoneLocked: hasSignups(sheet) ? sheet.timezone : null })}${button(o.saveChanges)}`)}
${backToSheet(sheet.slug)}
<section class="danger-zone"><p>${deleteLink(path(`/organizer/sheets/${sheet.slug}/delete`), o.deleteSheet)}</p></section>`,
    [errorNotice(code)]
  );
}

// --- Dates and places: forms ---------------------------------------------------------------------------------------

export type DateValues = { date: string; start: string; end: string; label: string; place: string; withSlots: boolean };

export function dateValuesFrom(form: URLSearchParams): DateValues {
  const get = (name: string) => form.get(name) ?? '';
  return { date: get('date'), start: get('start'), end: get('end'), label: get('label'), place: get('place'), withSlots: get('withSlots') === '1' };
}

function dateFields(values: DateValues, code: string | null, prefix: string): Html {
  return html`${input({ name: 'date', id: `${prefix}-date`, type: 'date', label: o.dateLabel, value: values.date, required: true, error: fieldError(code, 'date') })}
<div class="split">
${input({ name: 'start', id: `${prefix}-start`, type: 'time', label: o.startLabel, value: values.start, error: fieldError(code, 'start') })}
${input({ name: 'end', id: `${prefix}-end`, type: 'time', label: o.endLabel, value: values.end, error: fieldError(code, 'end') })}
</div>
${input({ name: 'label', id: `${prefix}-label`, label: o.dateNameLabel, hint: o.dateNameHint, value: values.label, maxLength: MAX_LENGTH.dateLabel, error: fieldError(code, 'label', null, { label: MAX_LENGTH.dateLabel }) })}
${input({ name: 'place', id: `${prefix}-place`, label: o.place, hint: o.datePlaceHint, value: values.place, maxLength: MAX_LENGTH.place, error: fieldError(code, 'place') })}`;
}

function addDateForm(slug: string, values: DateValues, code: string | null): Html {
  return postForm(
    path(`/organizer/sheets/${slug}/dates`),
    html`${dateFields(values, code, 'add')}${checkbox({ name: 'withSlots', id: 'add-withSlots', label: o.withSlots, checked: values.withSlots })}${button(o.addDateButton)}`
  );
}

/** "Add a date" on its own, shown again after a refusal with what was typed. */
export function addDateShell(organizer: Organizer, sheet: { slug: string; title: string }, values: DateValues, code: string | null): Shell {
  return orgShell(organizer, o.addDate, html`<p class="group">${sheet.title}</p><h1>${o.addDate}</h1>${addDateForm(sheet.slug, values, code)}${backToSheet(sheet.slug)}`, [errorNotice(code, null, DATE_NAMES)]);
}

export function dateValuesOf(date: { onDate: string; startsAt: string | null; endsAt: string | null; label: string; place: string }): DateValues {
  return { date: date.onDate, start: hhmm(date.startsAt), end: hhmm(date.endsAt), label: date.label, place: date.place, withSlots: false };
}

export function editDateShell(organizer: Organizer, date: OrganizerDateView, values: DateValues, code: string | null): Shell {
  const when = formatWhen(date.onDate, date.startsAt);
  return orgShell(
    organizer,
    o.editDateHeading(when),
    html`<p class="group">${date.sheetTitle}</p>
<h1>${o.editDateHeading(when)}</h1>
<p class="hint">${o.editDateWarning}</p>
${postForm(path(`/organizer/dates/${date.id}/edit`), html`${dateFields(values, code, 'edit')}${button(words.ui.save)}`)}
${backToSheet(date.sheetSlug)}`,
    [errorNotice(code, null, DATE_NAMES)]
  );
}

export type SlotValues = { label: string; capacity: string; description: string };

export function slotValuesFrom(form: URLSearchParams): SlotValues {
  return { label: form.get('label') ?? '', capacity: form.get('capacity') ?? '', description: form.get('description') ?? '' };
}

function slotFields(values: SlotValues, code: string | null, prefix: string, n: string | null = null): Html {
  return html`${input({ name: 'label', id: `${prefix}-label`, label: o.slotLabel, hint: o.slotLabelHint, value: values.label, required: true, maxLength: MAX_LENGTH.slotLabel, error: fieldError(code, 'label', null, { label: MAX_LENGTH.slotLabel }) ?? (code === 'labelTaken' ? words.formErrors.labelTaken : null) })}
${input({ name: 'capacity', id: `${prefix}-capacity`, label: o.capacity, value: values.capacity, required: true, inputMode: 'numeric', pattern: '[0-9]{1,3}', maxLength: 3, error: fieldError(code, 'capacity', n) })}
${textarea({ name: 'description', id: `${prefix}-description`, label: o.slotDescription, value: values.description, rows: 2, maxLength: MAX_LENGTH.slotDescription, error: fieldError(code, 'description', null, { description: MAX_LENGTH.slotDescription }) })}`;
}

export function addSlotShell(organizer: Organizer, date: OrganizerDateView, values: SlotValues, code: string | null): Shell {
  const when = formatWhen(date.onDate, date.startsAt);
  return orgShell(
    organizer,
    o.addSlotHeading(when),
    html`<p class="group">${date.sheetTitle}</p>
<h1>${o.addSlotHeading(when)}</h1>
${postForm(path(`/organizer/dates/${date.id}/slots`), html`${slotFields(values, code, 'slot')}${button(o.addSlot)}`)}
${backToSheet(date.sheetSlug)}`,
    [errorNotice(code)]
  );
}

export function editSlotShell(organizer: Organizer, slot: OrganizerSlotView, values: SlotValues, code: string | null, n: string | null): Shell {
  const when = formatWhen(slot.onDate, slot.startsAt);
  return orgShell(
    organizer,
    o.editSlotHeading(slot.slotLabel, when),
    html`<p class="group">${slot.sheetTitle}</p>
<h1>${o.editSlotHeading(slot.slotLabel, when)}</h1>
<p class="hint">${o.capacityHint}</p>
${postForm(path(`/organizer/slots/${slot.slotId}/edit`), html`${slotFields(values, code, 'slot', n)}${button(words.ui.save)}`)}
${backToSheet(slot.sheetSlug)}
<section class="danger-zone"><p>${deleteLink(path(`/organizer/slots/${slot.slotId}/delete`), o.deleteSlot)}</p></section>`,
    [errorNotice(code, n)]
  );
}

// --- Adding, moving and swapping people ------------------------------------------------------------------------------

export type AddValues = { personId: string; name: string; contact: string; note: string };

export function addValuesFrom(form: URLSearchParams): AddValues {
  return { personId: form.get('personId') ?? '', name: form.get('name') ?? '', contact: form.get('contact') ?? '', note: form.get('note') ?? '' };
}

export function addSomeoneShell(
  organizer: Organizer,
  slot: OrganizerSlotView,
  roster: readonly { id: string; name: string; contact: string }[],
  rid: string,
  values: AddValues,
  code: string | null
): Shell {
  const when = formatWhen(slot.onDate, slot.startsAt);
  const already = new Set(slot.personIds);
  const choices = [
    { value: '', label: o.pickPerson },
    ...roster.filter((person) => !already.has(person.id)).map((person) => ({ value: person.id, label: person.contact ? `${person.name} (${person.contact})` : person.name }))
  ];
  const noteLabel = slot.noteLabel || words.fields.note;
  const full = roomFor({ capacity: slot.capacity, confirmed: slot.confirmed, waiting: slot.waiting }) === 0;
  return orgShell(
    organizer,
    o.addHeading(slot.slotLabel, when),
    html`<p class="group">${slot.sheetTitle}</p>
<h1>${o.addHeading(slot.slotLabel, when)}</h1>
<p class="count">${countText(slot)}</p>
${full ? html`<p>${o.addFull(slot.waiting + 1)}</p>` : null}
<p class="hint">${o.addPick}</p>
${postForm(
  path(`/organizer/slots/${slot.slotId}/add`),
  html`${hidden('rid', rid)}
${select({ name: 'personId', label: o.fromRoster, choices, value: values.personId })}
<h2>${o.orNew}</h2>
${input({ name: 'name', label: o.newName, value: values.name, maxLength: MAX_LENGTH.name, error: fieldError(code, 'name') ?? (code === 'nobodyPicked' ? words.formErrors.nobodyPicked : null) })}
${input({ name: 'contact', label: words.claim.contact, hint: words.claim.contactHint, value: values.contact, maxLength: MAX_LENGTH.contact, error: fieldError(code, 'contact'), plain: true })}
${textarea({ name: 'note', label: slot.noteRequired ? noteLabel : `${noteLabel} ${words.ui.optional}`, value: values.note, rows: 2, maxLength: MAX_LENGTH.note, required: slot.noteRequired, error: code === 'note' ? (slot.noteLabel ? words.formErrors.noteLabelled(slot.noteLabel) : words.formErrors.note) : fieldError(code, 'note') })}
${button(o.addThem)}`
)}
${backToSheet(slot.sheetSlug)}`,
    // The note is named as this sheet names it, as the field says.
    [code === 'note' && slot.noteLabel ? { kind: 'error', body: words.formErrors.noteLabelled(slot.noteLabel) } : errorNotice(code, null, { note: noteLabel })]
  );
}

/** The places a sign-up could move to: with room after the people waiting, not its own, not one its person holds. */
function moveTargets(sheet: OrganizerSheet, signup: OrganizerSignupView, now: Date): { date: AdminDate; slot: AdminSlot }[] {
  const targets: { date: AdminDate; slot: AdminSlot }[] = [];
  for (const date of sheet.dates) {
    if (!takesPeople(sheet, date, now)) continue;
    for (const slot of date.slots) {
      if (slot.id === signup.slotId || roomFor(slot) === 0 || slot.signups.some((other) => other.personId === signup.personId)) continue;
      targets.push({ date, slot });
    }
  }
  return targets;
}

export function moveShell(organizer: Organizer, signup: OrganizerSignupView, sheet: OrganizerSheet, code: string | null, now: Date): Shell {
  const targets = moveTargets(sheet, signup, now);
  // The document's title names nobody (it lands in the browser's history); the heading names the person.
  return orgShell(
    organizer,
    o.moveTitle,
    html`<p class="group">${sheet.title} · ${signup.slotLabel}, ${dateWords(sheet.dates, signup)}</p>
<h1>${o.moveHeading(signup.name)}</h1>
<p class="hint">${o.moveHint}</p>
${targets.length > 0
  ? postForm(
      path(`/organizer/signups/${signup.id}/move`),
      html`<fieldset class="choices"><legend>${words.me.moveLegend}</legend>${targets.map(
        ({ date, slot }) =>
          html`<label class="choice"><input type="radio" name="to" value="${slot.id}" required><span>${slot.label}, ${dateWords(sheet.dates, date)}<span class="hint">${words.sheet.countLeft(roomFor(slot))}</span></span></label>`
      )}</fieldset>${button(o.moveHere)}`
    )
  : html`<p>${o.noRoom}</p>`}
${backToSheet(sheet.slug)}`,
    [errorNotice(code)]
  );
}

export function swapShell(organizer: Organizer, signup: OrganizerSignupView, sheet: OrganizerSheet, code: string | null, now: Date): Shell {
  const own = sheet.dates.flatMap((date) => date.slots.map((slot) => ({ date, slot }))).find((place) => place.slot.id === signup.slotId);
  const candidates: { date: AdminDate; slot: AdminSlot; other: OrganizerSignup }[] = [];
  if (own && signup.status === 'confirmed' && takesPeople(sheet, own.date, now)) {
    for (const date of sheet.dates) {
      if (!takesPeople(sheet, date, now)) continue;
      for (const slot of date.slots) {
        if (slot.id === signup.slotId || slot.signups.some((each) => each.personId === signup.personId)) continue;
        for (const other of slot.signups) {
          if (other.status !== 'confirmed' || other.personId === signup.personId) continue;
          if (own.slot.signups.some((each) => each.personId === other.personId)) continue;
          candidates.push({ date, slot, other });
        }
      }
    }
  }
  const when = dateWords(sheet.dates, signup);
  return orgShell(
    organizer,
    o.swapTitle,
    html`<p class="group">${sheet.title}</p>
<h1>${o.swapHeading(signup.name, signup.slotLabel, when)}</h1>
<p class="hint">${o.swapHint}</p>
${candidates.length > 0
  ? postForm(
      path(`/organizer/signups/${signup.id}/swap`),
      html`<fieldset class="choices"><legend>${words.fields.name}</legend>${candidates.map(
        ({ date, slot, other }) =>
          html`<label class="choice"><input type="radio" name="with" value="${other.id}" required><span>${other.name}<span class="hint">${slot.label}, ${dateWords(sheet.dates, date)}</span></span></label>`
      )}</fieldset>${button(o.swapWith)}`
    )
  : html`<p>${o.noSwap}</p>`}
${backToSheet(sheet.slug)}`,
    [errorNotice(code)]
  );
}

// --- Confirmations -------------------------------------------------------------------------------------------------

function previewPeople(preview: DeletionPreview, textFor: (person: DeletionPreview['people'][number]) => ShareText): Html {
  return tellList(
    preview.people.map((person) => ({
      name: person.name,
      contact: person.contact,
      line: html`${person.slotLabel}, ${formatDate(person.onDate)}${person.status === 'waiting' ? html` · ${o.waitlist}` : null}`,
      text: textFor(person)
    })),
    'tell'
  );
}

/**
 * "Delete … with its sign-ups?": who to tell, each with the message; `changed` when the list changed meanwhile.
 * `sheetGone`: the whole sheet goes, so the message carries no link to it. `instead`: shown above the buttons (a date
 * ahead offers cancelling it instead, which keeps everyone on it).
 */
export function deleteShell(
  organizer: Organizer,
  input: { question: string; action: Href; back: Href; preview: DeletionPreview; sheetTitle: string; origin: string; changed: boolean; sheetGone?: boolean; instead?: Html | null }
): Shell {
  const link = sheetLink(input.origin, input.preview.slug);
  const { preview } = input;
  const s = words.share;
  return orgShell(
    organizer,
    input.question,
    html`<h1>${input.question}</h1>
${preview.people.length > 0
  ? html`<p>${o.tellThese(preview.people.length)}</p>${previewPeople(preview, (person) => ({
      subject: s.deletedSubject(input.sheetTitle),
      text: input.sheetGone
        ? s.sheetDeleted(input.sheetTitle, person.slotLabel, formatDate(person.onDate))
        : s.deleted(input.sheetTitle, person.slotLabel, formatDate(person.onDate), link)
    }))}`
  : html`<p>${o.nobody}</p>`}
${input.instead ?? null}
<div class="actions">
${postForm(input.action, html`${hidden('confirm', 'yes')}${hidden('seen', preview.seen)}${button(o.yesDelete, 'danger')}`, 'inline')}
${linkButton(input.back, o.keepIt, 'secondary')}
</div>`,
    [input.changed ? { kind: 'error', body: words.formErrors.deletionChanged } : null]
  );
}

/** Under a date's delete question while the date is ahead: cancelling keeps everyone on it, and can be undone. */
export function cancelInstead(date: { id: string }): Html {
  return html`<div class="box"><p>${o.deleteDateOrCancel}</p><div class="actions">${linkButton(path(`/organizer/dates/${date.id}/cancel`), o.cancelDate, 'secondary')}</div></div>`;
}

/**
 * "Remove … from …?": one sign-up off its place. The first person waiting moves up into a confirmed one only while its
 * date still takes people (not cancelled, not started), as cancelSignup decides; the page promises no more than that.
 */
export function removeOneShell(organizer: Organizer, signup: OrganizerSignupView, sheet: OrganizerSheet, now: Date): Shell {
  const when = dateWords(sheet.dates, signup);
  const place = placeOf(sheet, signup.slotId);
  const movesUp = signup.status === 'confirmed' && place !== null && takesPeople(sheet, place.date, now);
  return orgShell(
    organizer,
    o.removeOneTitle,
    html`<p class="group">${sheet.title}</p>
<h1>${o.removeOneQuestion(signup.name, signup.slotLabel, when)}</h1>
${movesUp ? html`<p>${o.removeOneLine}</p>` : null}
<div class="actions">
${postForm(path(`/organizer/signups/${signup.id}/remove`), button(o.removeYes, 'danger'), 'inline')}
${linkButton(path(`/organizer/sheets/${sheet.slug}#p${signup.slotId}`), o.keepIt, 'secondary')}
</div>`
  );
}

/** "Cancel this date?": the people on it stay, to move; each gets the message that the date is cancelled. */
export function cancelDateShell(organizer: Organizer, date: OrganizerDateView, preview: DeletionPreview, origin: string): Shell {
  const when = formatWhen(date.onDate, date.startsAt);
  const link = sheetLink(origin, date.sheetSlug);
  const text: ShareText = { subject: words.share.deletedSubject(date.sheetTitle), text: words.share.dateCancelled(date.sheetTitle, sayWhen(date, date.sameDay), link) };
  return orgShell(
    organizer,
    o.cancelDateQuestion(when),
    html`<p class="group">${date.sheetTitle}</p>
<h1>${o.cancelDateQuestion(when)}</h1>
<p>${o.cancelDateLine}</p>
${preview.people.length > 0 ? html`<p>${o.tellThese(preview.people.length)}</p>${previewPeople(preview, () => text)}` : html`<p>${o.nobody}</p>`}
<div class="actions">
${postForm(path(`/organizer/dates/${date.id}/cancel`), button(o.yesCancelDate, 'danger'), 'inline')}
${linkButton(path(`/organizer/sheets/${date.sheetSlug}`), o.keepIt, 'secondary')}
</div>`
  );
}

// --- "Add a date every week" ----------------------------------------------------------------------------------------

export type WeeklyPreview = { days: string[]; skipped: string[] } | null;

/** Which of these days the sheet already has at this start time (they are skipped). */
export function weeklyPreview(sheet: OrganizerSheet, days: readonly string[], startsAt: string | null): { days: string[]; skipped: string[] } {
  const taken = new Set(sheet.dates.filter((date) => hhmm(date.startsAt) === (startsAt ?? '')).map((date) => date.onDate));
  return { days: days.filter((day) => !taken.has(day)), skipped: days.filter((day) => taken.has(day)) };
}

export function weeklyShell(
  organizer: Organizer,
  sheet: OrganizerSheet,
  query: URLSearchParams,
  preview: WeeklyPreview,
  code: string | null
): Shell {
  const get = (name: string) => query.get(name) ?? '';
  const anySlots = sheet.dates.some((date) => date.slots.length > 0);
  const withSlots = query.has('from') ? get('withSlots') === '1' : anySlots;
  const values = { from: get('from'), until: get('until'), start: get('start'), end: get('end'), place: get('place') };
  const fields = html`${input({ name: 'from', type: 'date', label: o.bulkFrom, value: values.from, required: true, error: fieldError(code, 'from') ?? (code === 'order' || code === 'tooMany' ? errorSentence(code) : null) })}
${input({ name: 'until', type: 'date', label: o.bulkUntil, value: values.until, required: true, error: fieldError(code, 'until') })}
<div class="split">
${input({ name: 'start', type: 'time', label: o.startLabel, value: values.start, error: fieldError(code, 'start') })}
${input({ name: 'end', type: 'time', label: o.endLabel, value: values.end, error: fieldError(code, 'end') })}
</div>
${input({ name: 'place', label: o.place, hint: o.datePlaceHint, value: values.place, maxLength: MAX_LENGTH.place, error: fieldError(code, 'place') })}
${checkbox({ name: 'withSlots', label: o.withSlots, checked: withSlots })}`;

  let confirm: Html | null = null;
  if (preview && !code) {
    const first = preview.days[0] ?? preview.skipped[0];
    const weekday = first ? words.calendar.weekdaysLong[weekdayIndex(first)]! : '';
    const times = formatTimes(values.start || null, values.end || null);
    confirm = html`<section class="box">
<h2>${o.bulkEvery(weekday)}${times ? ` · ${times}` : ''}</h2>
${preview.days.length > 0
  ? html`<p>${o.bulkWill(preview.days.length)}</p><ul>${preview.days.map((day) => html`<li>${formatDate(day)}</li>`)}</ul>`
  : html`<p>${o.bulkNone}</p>`}
${preview.skipped.length > 0 ? html`<p class="hint">${o.bulkAlready(preview.skipped.length)}</p>` : null}
${preview.days.length > 0
  ? postForm(
      path(`/organizer/sheets/${sheet.slug}/dates/weekly`),
      html`${hidden('from', values.from)}${hidden('until', values.until)}${hidden('start', values.start)}${hidden('end', values.end)}${hidden('place', values.place)}${withSlots ? hidden('withSlots', '1') : null}${button(o.bulkAdd(preview.days.length))}`
    )
  : null}
</section>`;
  }
  return orgShell(
    organizer,
    o.bulkHeading,
    html`<p class="group">${sheet.title}</p>
<h1>${o.bulkHeading}</h1>
<p class="hint">${o.bulkHint}</p>
<form method="get" action="${path(`/organizer/sheets/${sheet.slug}/dates/weekly`)}" class="stack">${fields}${button(o.bulkPreview, confirm ? 'secondary' : 'primary')}</form>
${confirm}
${backToSheet(sheet.slug)}`,
    [errorNotice(code, null, DATE_NAMES)]
  );
}

// --- The share pages ------------------------------------------------------------------------------------------------

/** The email addresses of everyone on a sheet's dates from today on (for one bcc email). */
function sheetContacts(sheet: OrganizerSheet, now: Date, which: (signup: OrganizerSignup) => boolean): string[] {
  const today = civilToday(sheet.timezone, now);
  return sheet.dates
    .filter((date) => date.onDate >= today && !date.cancelled)
    .flatMap((date) => date.slots.flatMap((slot) => slot.signups.filter(which).map((signup) => signup.contact)));
}

export function weekShareShell(organizer: Organizer, sheet: PublicSheet, admin: OrganizerSheet, origin: string, now: Date): Shell {
  const text = weekText(sheet, sheetLink(origin, sheet.slug), now);
  const contacts = sheetContacts(admin, now, (signup) => signup.status === 'confirmed');
  const bcc = text ? bccLink(text, contacts) : null;
  return orgShell(
    organizer,
    o.weekHeading,
    html`<p class="group">${sheet.title}</p>
<h1>${o.weekHeading}</h1>
${text
  ? html`${shareBox({ id: 'week', label: o.weekHeading, text, links: shareLinks(text), extra: bcc ? html`<a class="button secondary" href="${shareHref(bcc)}">${words.ui.emailEveryone(emailCount(contacts))}</a>` : null })}${bcc ? html`<p class="hint">${o.weekEmailAll}</p>` : null}`
  : html`<p><button type="button" class="secondary" disabled>${o.nothingThisWeek}</button></p>`}
${backToSheet(sheet.slug)}`
  );
}

export function waitlistShareShell(organizer: Organizer, sheet: OrganizerSheet, origin: string, now: Date): Shell {
  const messages = waitlistMessages(sheet, sheetLink(origin, sheet.slug), now);
  const all = messages.all;
  const bcc = all ? bccLink(all, messages.each.map((each) => each.contact)) : null;
  return orgShell(
    organizer,
    o.waitlistHeading,
    html`<p class="group">${sheet.title}</p>
<h1>${o.waitlistHeading}</h1>
${all
  ? html`<h2>${o.waitlistAll}</h2>
${shareBox({ id: 'waitlist-all', label: o.waitlistAll, text: all, links: shareLinks(all), extra: bcc ? html`<a class="button secondary" href="${shareHref(bcc)}">${words.ui.emailEveryone(emailCount(messages.each.map((each) => each.contact)))}</a>` : null })}
<h2>${o.waitlistEach}</h2>
${tellList(
  messages.each.map((each) => ({ name: each.name, contact: each.contact, text: each.text })),
  'waiting',
  { namesHidden: sheet.names === 'taken' }
)}`
  : html`<p>${o.waitlistNone}</p>`}
${backToSheet(sheet.slug)}`
  );
}

// --- The sheet itself -----------------------------------------------------------------------------------------------

function needsTelling(signup: OrganizerSignup): boolean {
  return signup.toldAt === null && (signup.changedAt !== null || (signup.promotedAt !== null && signup.status === 'confirmed'));
}

function signupLine(sheet: OrganizerSheet, date: AdminDate, signup: OrganizerSignup, now: Date): Html {
  const noteLabel = sheet.noteLabel || words.fields.note;
  const open = takesPeople(sheet, date, now);
  // Someone on a cancelled date can still be moved to another; nobody is moved off a date that has started.
  const movable = isOpenForClaims(date.onDate, date.startsAt, sheet.timezone, now);
  const tags = [
    signup.status === 'waiting' ? html`<span class="tag">${o.waitingNumber(signup.position ?? 1)}</span>` : null,
    needsTelling(signup) ? html`<span class="tag soon">${signup.changedAt ? o.changedTag : o.movedUpTag}</span>` : null,
    signup.placesOnSheet > 3 ? html`<span class="tag">${o.manyPlaces(signup.placesOnSheet)}</span>` : null,
    signup.paid === false ? html`<span class="tag">${o.notPaid}</span>` : null
  ];
  // A screen reader hears whose Change and Told them these are (their visible words stay short).
  const whose = html`<span class="sr">: ${signup.name}</span>`;
  return html`<li>
<p class="person-line"><a class="name" href="${path(`/organizer/people/${signup.personId}`)}">${signup.name}</a>${tags}</p>
${signup.contact ? html`<p class="meta">${signup.contact}</p>` : null}
${signup.note ? html`<p>${o.noteLine(noteLabel, signup.note)}</p>` : null}
<p class="meta">${o.addedBy[signup.addedBy]} ${o.signedUpOn(formatMoment(signup.signedUpAt, sheet.timezone))}${signup.hasLink ? null : html` · ${o.noLink}`}</p>
${needsTelling(signup) ? postButton(path(`/organizer/signups/${signup.id}/told`), html`${o.toldThem}${whose}`, 'secondary', { from: 'sheet' }) : null}
<details><summary>${o.change}${whose}</summary><div class="actions">
${movable ? linkButton(path(`/organizer/signups/${signup.id}/move`), o.moveTo, 'secondary') : null}
${signup.status === 'confirmed' && open ? linkButton(path(`/organizer/signups/${signup.id}/swap`), o.swap, 'secondary') : null}
${linkButton(path(`/organizer/signups/${signup.id}/remove`), o.remove, 'danger')}
</div></details>
</li>`;
}

/** A menu folded under one button: each item a whole row to tap, deletes last and in red. */
function menu(summary: Child, items: readonly (Html | null)[]): Html {
  return html`<details class="manage"><summary>${summary}</summary><ul class="menu">${items.filter((item): item is Html => item !== null).map((item) => html`<li>${item}</li>`)}</ul></details>`;
}

function slotBlock(sheet: OrganizerSheet, date: AdminDate, slot: AdminSlot, now: Date): Html {
  const confirmed = slot.signups.filter((signup) => signup.status === 'confirmed');
  const waiting = slot.signups.filter((signup) => signup.status === 'waiting');
  const which = html`<span class="sr">: ${slot.label}, ${dateWords(sheet.dates, date)}</span>`;
  return html`<li class="slot" id="${`p${slot.id}`}">
<div class="slot-main"><span class="slot-name">${slot.label}</span><span class="count">${countText(slot)}</span>${slot.description ? html`<span class="slot-description">${slot.description}</span>` : null}</div>
${confirmed.length > 0 ? html`<ul class="rows">${confirmed.map((signup) => signupLine(sheet, date, signup, now))}</ul>` : html`<p class="meta">${o.nobodyYet}</p>`}
${waiting.length > 0 ? html`<p class="waitlist-head">${o.waitlist}</p><ul class="rows">${waiting.map((signup) => signupLine(sheet, date, signup, now))}</ul>` : null}
<div class="actions">${linkButton(path(`/organizer/slots/${slot.id}/add`), html`${o.addSomeone}${which}`, 'secondary')}</div>
${menu(html`${o.changeSlot}${which}`, [
  html`<a href="${path(`/organizer/slots/${slot.id}/edit`)}">${o.editSlot}</a>`,
  deleteLink(path(`/organizer/slots/${slot.id}/delete`), o.deleteSlot)
])}
</li>`;
}

function dateBlock(sheet: OrganizerSheet, date: AdminDate, now: Date): Html {
  const which = html`<span class="sr">: ${dateWords(sheet.dates, date)}</span>`;
  return html`<section class="date" id="${`d${date.id}`}">
${dateStrip({ ...date, place: date.place }, { heading: 'h3' })}
${date.slots.length > 0 ? html`<ul class="slots">${date.slots.map((slot) => slotBlock(sheet, date, slot, now))}</ul>` : html`<p class="meta">${o.noSlots}</p>`}
${date.cancelled ? html`<div class="actions">${postButton(path(`/organizer/dates/${date.id}/uncancel`), o.uncancelDate, 'secondary')}</div>` : null}
${menu(html`${o.changeDate}${which}`, [
  html`<a href="${path(`/organizer/dates/${date.id}/edit`)}">${o.editDate}</a>`,
  html`<a href="${path(`/organizer/dates/${date.id}/slots`)}">${o.addSlot}</a>`,
  date.cancelled ? null : html`<a href="${path(`/organizer/dates/${date.id}/cancel`)}">${o.cancelDate}</a>`,
  deleteLink(path(`/organizer/dates/${date.id}/delete`), o.deleteDate)
])}
</section>`;
}

/** Everyone on one date, with the message that it was cancelled (`cancelled=<date id>`, after the cancel). */
function cancelledNotice(sheet: OrganizerSheet, dateId: string | null, origin: string): Notice | null {
  const date = dateId ? sheet.dates.find((each) => each.id === dateId) : undefined;
  if (!date) return null;
  const when = dateWords(sheet.dates, date);
  const text: ShareText = { subject: words.share.deletedSubject(sheet.title), text: words.share.dateCancelled(sheet.title, when, sheetLink(origin, sheet.slug)) };
  const people = date.slots.flatMap((slot) => slot.signups.map((signup) => ({ name: signup.name, contact: signup.contact, line: slot.label, text })));
  return {
    kind: 'done',
    body: o.cancelledTell(when),
    after: people.length > 0 ? tellList(people, 'cancelled') : html`<p>${o.nobodyOn}</p>`
  };
}

type Place = { date: AdminDate; slot: AdminSlot };

function placeOf(sheet: OrganizerSheet, slotId: string | undefined): Place | null {
  for (const date of sheet.dates) for (const slot of date.slots) if (slot.id === slotId) return { date, slot };
  return null;
}

function findSignup(sheet: OrganizerSheet, signupId: string): { place: Place; signup: OrganizerSignup } | null {
  for (const date of sheet.dates) {
    for (const slot of date.slots) {
      const signup = slot.signups.find((each) => each.id === signupId);
      if (signup) return { place: { date, slot }, signup };
    }
  }
  return null;
}

/**
 * The message for someone whose place the organizer changed, naming the old day when it is known. Both days carry
 * their times when the time is what changed (or the sheet has another date that day); else neither does. Someone with
 * a private link adds the new date from it; someone without one is not told to.
 */
function changedText(sheet: OrganizerSheet, signup: OrganizerSignup, to: Place, from: { onDate: string; startsAt: string | null } | null, link: string): ShareText {
  const s = words.share;
  const subject = s.changedSubject(sheet.title);
  const calendar = signup.hasLink ? s.calendarWithLink : s.calendarNoLink;
  if (!from || (from.onDate === to.date.onDate && hhmm(from.startsAt) === hhmm(to.date.startsAt))) {
    return { subject, text: s.changedNow(signup.name, to.slot.label, dateWords(sheet.dates, to.date), sheet.title, calendar, link) };
  }
  const withTimes = hhmm(from.startsAt) !== hhmm(to.date.startsAt) || sheet.dates.filter((date) => date.onDate === to.date.onDate).length > 1;
  const fromWhen = withTimes ? formatWhen(from.onDate, from.startsAt ? hhmm(from.startsAt) : null) : formatDate(from.onDate);
  const toWhen = withTimes ? formatWhen(to.date.onDate, to.date.startsAt ? hhmm(to.date.startsAt) : null) : formatDate(to.date.onDate);
  return { subject, text: s.changed(signup.name, to.slot.label, fromWhen, toWhen, sheet.title, calendar, link) };
}

/**
 * After a move (`changed=<id>&was=<old slot id>`), a swap (`changed=<a>-<b>`: each now has the other's old place) or a
 * date's new day, time or place (`moved=<date id>&was=<old day>&wasAt=<old time>`): the people to tell, with messages.
 */
function changedNotice(sheet: OrganizerSheet, query: URLSearchParams, origin: string): Notice | null {
  const link = sheetLink(origin, sheet.slug);
  const people: { name: string; contact: string; line: Html; text: ShareText }[] = [];
  const changed = /^([1-9][0-9]{0,17})(?:-([1-9][0-9]{0,17}))?$/.exec(query.get('changed') ?? '');
  if (changed) {
    const a = findSignup(sheet, changed[1]!);
    const b = changed[2] ? findSignup(sheet, changed[2]) : null;
    if (a && b) {
      people.push({ name: a.signup.name, contact: a.signup.contact, line: html`${a.place.slot.label}, ${dateWords(sheet.dates, a.place.date)}`, text: changedText(sheet, a.signup, a.place, b.place.date, link) });
      people.push({ name: b.signup.name, contact: b.signup.contact, line: html`${b.place.slot.label}, ${dateWords(sheet.dates, b.place.date)}`, text: changedText(sheet, b.signup, b.place, a.place.date, link) });
    } else if (a) {
      const from = placeOf(sheet, query.get('was') ?? undefined);
      people.push({ name: a.signup.name, contact: a.signup.contact, line: html`${a.place.slot.label}, ${dateWords(sheet.dates, a.place.date)}`, text: changedText(sheet, a.signup, a.place, from?.date ?? null, link) });
    }
  }
  const moved = query.get('moved');
  const date = moved ? sheet.dates.find((each) => each.id === moved) : undefined;
  if (date) {
    const was = query.get('was') ?? '';
    const wasAt = query.get('wasAt') ?? '';
    const from = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(was) ? { onDate: was, startsAt: /^[0-9]{2}:[0-9]{2}$/.test(wasAt) ? wasAt : null } : null;
    for (const slot of date.slots) {
      for (const signup of slot.signups) {
        people.push({ name: signup.name, contact: signup.contact, line: html`${slot.label}, ${dateWords(sheet.dates, date)}`, text: changedText(sheet, signup, { date, slot }, from, link) });
      }
    }
  }
  if (people.length === 0) return null;
  return { kind: 'done', body: o.changedTell, after: tellList(people, 'changed', { namesHidden: sheet.names === 'taken' }) };
}

/** After a removal (`removed=<n>`): how many waiting people moved up into the place, marked below to tell. */
function removedNotice(query: URLSearchParams): Notice | null {
  const up = query.get('removed');
  return up !== null && /^[0-9]{1,4}$/.test(up) ? { kind: 'done', body: o.removedUp(Number(up)) } : null;
}

export type SheetAdminInput = {
  organizer: Organizer;
  sheet: OrganizerSheet;
  origin: string;
  query: URLSearchParams;
  /** The sign-up just marked told from this page (`told=`), for its Undo. */
  told: { id: string; name: string } | null;
  now: Date;
};

export function sheetAdminShell(page: SheetAdminInput): Shell {
  const { sheet, now, origin, query } = page;
  const today = civilToday(sheet.timezone, now);
  const ahead = sheet.dates.filter((date) => date.onDate >= today);
  const earlier = sheet.dates.filter((date) => date.onDate < today);
  const thisWeek = sheet.dates.some((date) => !date.cancelled && date.onDate >= today && date.onDate <= addDays(today, 6) && date.slots.length > 0);
  const anyWaiting = ahead.some((date) => date.slots.some((slot) => slot.waiting > 0));
  const anySlots = sheet.dates.some((date) => date.slots.length > 0);

  // Only the statuses it can change to (its own is the tag under the title); a draft's way forward, Open, is the one
  // main button.
  const statusButtons = (['draft', 'open', 'closed'] as const)
    .filter((status) => status !== sheet.status)
    .map((status) => {
      const label = status === 'draft' ? o.makeDraft : status === 'open' ? o.makeOpen : o.makeClosed;
      return postButton(path(`/organizer/sheets/${sheet.slug}/status`), label, status === 'open' && sheet.status === 'draft' ? 'primary' : 'secondary', { status });
    });
  const invite: ShareText = { subject: sheet.title, text: words.share.invite(sheet.title, sheetLink(origin, sheet.slug)).join('\n') };

  const notices: (Notice | null)[] = [
    flagNotice(query, 'saved', words.ui.saved),
    flagNotice(query, 'deleted', o.deleted),
    removedNotice(query),
    flagNotice(query, 'added', o.added),
    /^[0-9]{1,3}$/.test(query.get('weekly') ?? '') ? { kind: 'done', body: o.bulkAdded(Number(query.get('weekly'))) } : null,
    page.told ? { kind: 'done', body: html`${o.toldDone(page.told.name)} ${postButton(path(`/organizer/signups/${page.told.id}/untold`), o.undo, 'quiet', { from: 'sheet' })}` } : null,
    cancelledNotice(sheet, query.get('cancelled'), origin),
    changedNotice(sheet, query, origin),
    errorNotice(query.get('e'), query.get('n'))
  ];

  const main = html`${sheet.groupName ? html`<p class="group">${sheet.groupName}</p>` : null}
<h1>${sheet.title}</h1>
<p class="person-line"><span class="tag">${o.statusWords[sheet.status]}</span>${sheet.listed ? null : html`<span class="tag">${o.unlisted}</span>`}<a href="${path(`/s/${sheet.slug}`)}">${o.publicPage}</a></p>
${paragraphs(sheet.description)}
${sheet.place ? html`<p class="place-line">${sheet.place}</p>` : null}
<section id="status">
<h2>${o.statusHeading}</h2>
<p class="hint">${sheet.status === 'draft' ? words.sheet.draft : o.statusHint[sheet.status]}</p>
<div class="status-row">${statusButtons}</div>
</section>
<section id="share">
<h2>${o.shareHeading}</h2>
${sheet.status === 'open' ? shareBox({ id: 'invite', label: o.invite, text: invite, links: shareLinks(invite) }) : null}
<div class="actions">
${thisWeek ? linkButton(path(`/organizer/sheets/${sheet.slug}/share/week`), o.shareWeek, 'secondary') : html`<button type="button" class="secondary" disabled>${o.nothingThisWeek}</button>`}
${anyWaiting ? linkButton(path(`/organizer/sheets/${sheet.slug}/share/waitlist`), o.messageWaitlist, 'secondary') : null}
<a class="button secondary" href="${path(`/organizer/sheets/${sheet.slug}/export.csv`)}">${o.csv}</a>
</div>
</section>
<section id="dates">
<h2>${o.dates}</h2>
<div class="actions">${linkButton(anchor('new-date'), o.addDate, 'secondary')}${linkButton(path(`/organizer/sheets/${sheet.slug}/dates/weekly`), o.bulkLink, 'secondary')}</div>
${sheet.dates.length === 0 ? html`<p>${o.noDates}</p>` : null}
${ahead.map((date) => dateBlock(sheet, date, now))}
${earlier.length > 0 ? html`<details><summary>${o.earlier(earlier.length)}</summary>${earlier.map((date) => dateBlock(sheet, date, now))}</details>` : null}
</section>
<section id="new-date" class="box">
<h2>${o.addDate}</h2>
${addDateForm(sheet.slug, { date: '', start: '', end: '', label: '', place: '', withSlots: anySlots }, null)}
</section>
<section id="add-slot" class="box">
<details><summary>${o.addSlotEvery}</summary>
<p class="hint">${o.addSlotEveryHint}</p>
${postForm(path(`/organizer/sheets/${sheet.slug}/slots-every-date`), html`${slotFields({ label: '', capacity: '1', description: '' }, null, 'every')}${button(o.addSlotEveryButton, 'secondary')}`)}
</details>
</section>
<section id="settings">
<h2>${o.sheetSettings}</h2>
<p class="hint">${o.sheetSettingsHint}</p>
<div class="actions">${linkButton(path(`/organizer/sheets/${sheet.slug}/edit`), o.editSheet, 'secondary')}</div>
<p>${deleteLink(path(`/organizer/sheets/${sheet.slug}/delete`), o.deleteSheet)}</p>
</section>`;

  return orgShell(page.organizer, sheet.title, main, notices);
}
