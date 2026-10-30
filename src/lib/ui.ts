// The parts the pages share (see TOFU.md, Pages): labelled fields, forms that post back to this copy, the date strip
// that every list of dates is built on, share boxes, link boxes and the sentence for a `?e=` code. All of it goes
// through html.ts, so every value is escaped and every address checked.
//
// Copy and Share buttons are hidden until public/app.js runs; without it, the text sits in a read-only box to copy by
// hand, and every form still posts.
import { words } from '../words';
import { attr, type Child, flag, type Href, html, type Html, shareHref } from './html';
import { personLinks, type ShareText, shareLinks } from './share';
import { formatDate, formatTimes, formatWhen, weekdayIndex } from './time';
import { MAX_LENGTH } from './validation';

// --- Form fields ---------------------------------------------------------------------------------------------------

type FieldBase = {
  name: string;
  label: Child;
  hint?: Child;
  /** The sentence shown under the label, with the field marked invalid. */
  error?: string | null;
  /** Unique on the page; defaults to `f-<name>`. */
  id?: string;
};

function described(id: string, field: FieldBase): string | null {
  const ids = [field.hint ? `${id}-hint` : '', field.error ? `${id}-error` : ''].filter(Boolean).join(' ');
  return ids || null;
}

function fieldTop(id: string, field: FieldBase): Html {
  return html`<label for="${id}">${field.label}</label>
${field.hint ? html`<p class="hint" id="${`${id}-hint`}">${field.hint}</p>` : null}
${field.error ? html`<p class="field-error" id="${`${id}-error`}">${field.error}</p>` : null}`;
}

export type InputOptions = FieldBase & {
  value?: string;
  type?: 'text' | 'email' | 'tel' | 'date' | 'time' | 'password' | 'number';
  autocomplete?: string;
  required?: boolean;
  maxLength?: number;
  inputMode?: 'text' | 'email' | 'tel' | 'numeric' | 'decimal';
  pattern?: string;
  min?: string;
  max?: string;
  /**
   * Text a phone must not "correct": an email address or a phone number in one box (so it stays type="text"), where a
   * capital first letter or an autocorrected domain would leave the organizer unable to reach the person.
   */
  plain?: boolean;
};

export function input(options: InputOptions): Html {
  const id = options.id ?? `f-${options.name}`;
  const plain = options.plain ? html`${attr('autocapitalize', 'none')}${attr('autocorrect', 'off')}${attr('spellcheck', 'false')}` : null;
  return html`<div class="${options.error ? 'field has-error' : 'field'}">
${fieldTop(id, options)}
<input id="${id}" name="${options.name}" type="${options.type ?? 'text'}" value="${options.value ?? ''}"${attr('autocomplete', options.autocomplete ?? 'off')}${attr('maxlength', options.maxLength)}${attr('inputmode', options.inputMode)}${attr('pattern', options.pattern)}${attr('min', options.min)}${attr('max', options.max)}${attr('aria-describedby', described(id, options))}${attr('aria-invalid', options.error ? 'true' : null)}${flag('required', options.required ?? false)}${plain}>
</div>`;
}

export function textarea(options: FieldBase & { value?: string; rows?: number; maxLength?: number; required?: boolean; readonly?: boolean }): Html {
  const id = options.id ?? `f-${options.name}`;
  return html`<div class="${options.error ? 'field has-error' : 'field'}">
${fieldTop(id, options)}
<textarea id="${id}" name="${options.name}" rows="${options.rows ?? 3}"${attr('maxlength', options.maxLength)}${attr('aria-describedby', described(id, options))}${attr('aria-invalid', options.error ? 'true' : null)}${flag('required', options.required ?? false)}${flag('readonly', options.readonly ?? false)}>${options.value ?? ''}</textarea>
</div>`;
}

export type Choice = { value: string; label: Child; hint?: Child };

export function select(options: FieldBase & { choices: readonly Choice[]; value?: string; required?: boolean }): Html {
  const id = options.id ?? `f-${options.name}`;
  return html`<div class="${options.error ? 'field has-error' : 'field'}">
${fieldTop(id, options)}
<select id="${id}" name="${options.name}"${attr('aria-describedby', described(id, options))}${flag('required', options.required ?? false)}>
${options.choices.map((choice) => html`<option value="${choice.value}"${flag('selected', choice.value === options.value)}>${choice.label}</option>`)}
</select>
</div>`;
}

/** Radio buttons in a fieldset: one choice per row, each a 44 px target. */
export function radios(options: { name: string; legend: Child; choices: readonly Choice[]; value?: string; error?: string | null; required?: boolean }): Html {
  return html`<fieldset class="${options.error ? 'choices has-error' : 'choices'}">
<legend>${options.legend}</legend>
${options.error ? html`<p class="field-error">${options.error}</p>` : null}
${options.choices.map(
  (choice, index) => html`<label class="choice"><input type="radio" name="${options.name}" value="${choice.value}"${flag('checked', choice.value === options.value)}${flag('required', (options.required ?? false) && index === 0)}><span>${choice.label}${choice.hint ? html`<span class="hint">${choice.hint}</span>` : null}</span></label>`
)}
</fieldset>`;
}

export function checkbox(options: { name: string; label: Child; checked: boolean; value?: string; hint?: Child; id?: string }): Html {
  const id = options.id ?? `f-${options.name}`;
  return html`<div class="field check">
<input type="checkbox" id="${id}" name="${options.name}" value="${options.value ?? '1'}"${flag('checked', options.checked)}>
<label for="${id}">${options.label}${options.hint ? html`<span class="hint">${options.hint}</span>` : null}</label>
</div>`;
}

export function hidden(name: string, value: string): Html {
  return html`<input type="hidden" name="${name}" value="${value}">`;
}

export type ButtonKind = 'primary' | 'secondary' | 'danger' | 'quiet';

export function button(label: Child, kind: ButtonKind = 'primary', submit: { name: string; value: string } | null = null): Html {
  return html`<button type="submit" class="${kind}"${attr('name', submit?.name)}${attr('value', submit?.value)}>${label}</button>`;
}

/** A form that posts to this copy (every POST passes the Origin guard). */
export function postForm(action: Href, body: Child, className = 'stack'): Html {
  return html`<form method="post" action="${action}" class="${className}">${body}</form>`;
}

/** A button that posts an empty form (Told them, Undo, Remove …). */
export function postButton(action: Href, label: Child, kind: ButtonKind = 'secondary', fields: Record<string, string> = {}): Html {
  return html`<form method="post" action="${action}" class="inline">${Object.entries(fields).map(([name, value]) => hidden(name, value))}${button(label, kind)}</form>`;
}

export function linkButton(href: Href, label: Child, kind: ButtonKind = 'primary'): Html {
  return html`<a class="${`button ${kind}`}" href="${href}">${label}</a>`;
}

// --- Dates ---------------------------------------------------------------------------------------------------------

export type DateLike = { onDate: string; startsAt: string | null; endsAt: string | null; label?: string; place?: string; cancelled?: boolean };

/** 'Saturday, November 7'. */
export function longDate(date: string): string {
  const month = Number(date.slice(5, 7));
  return `${words.calendar.weekdaysLong[weekdayIndex(date)]}, ${words.calendar.monthsLong[month - 1]} ${Number(date.slice(8, 10))}`;
}

/** 'Sat, Nov 7 · 9:00 AM–10:30 AM' (TOFU.md, Time), or 'Sat, Nov 7'. */
export function whenText(date: { onDate: string; startsAt: string | null; endsAt: string | null }): string {
  const times = formatTimes(date.startsAt, date.endsAt);
  return times ? `${formatDate(date.onDate)} · ${times}` : formatDate(date.onDate);
}

/**
 * The date strip every list of dates is built on: the month, the day's number large and the weekday, like a page torn
 * from a wall calendar, then the time, the date's label and its place. `heading` is the level it takes in the page.
 */
export function dateStrip(date: DateLike, options: { heading?: 'h2' | 'h3'; extra?: Child; id?: string } = {}): Html {
  const month = words.calendar.monthsShort[Number(date.onDate.slice(5, 7)) - 1];
  const day = Number(date.onDate.slice(8, 10));
  const weekday = words.calendar.weekdaysShort[weekdayIndex(date.onDate)];
  const times = formatTimes(date.startsAt, date.endsAt);
  const inner = html`<span class="cal" aria-hidden="true"><span class="mon">${month}</span><span class="num">${day}</span><span class="wd">${weekday}</span></span><span class="what"><span class="day">${longDate(date.onDate)}</span>${times ? html`<span class="times">${times}</span>` : null}${date.label ? html`<span class="label">${date.label}</span>` : null}${date.place ? html`<span class="place">${date.place}</span>` : null}${date.cancelled ? html`<span class="tag cancelled">${words.sheet.cancelled}</span>` : null}${options.extra ?? null}</span>`;
  return options.heading === 'h3'
    ? html`<h3 class="${date.cancelled ? 'when is-cancelled' : 'when'}"${attr('id', options.id)}>${inner}</h3>`
    : html`<h2 class="${date.cancelled ? 'when is-cancelled' : 'when'}"${attr('id', options.id)}>${inner}</h2>`;
}

/** How a sentence names a date: 'Sat, Nov 7', with its time when its sheet has `sameDay` dates that day (time.ts dateWords). */
export function sayWhen(date: { onDate: string; startsAt: string | null }, sameDay: number): string {
  return sameDay > 1 ? formatWhen(date.onDate, date.startsAt) : formatDate(date.onDate);
}

/** '1 of 1 taken' / '2 places left' / 'Full · 2 waiting'. */
export function countText(slot: { capacity: number; confirmed: number; waiting: number }): string {
  const s = words.sheet;
  if (slot.confirmed >= slot.capacity) return slot.waiting > 0 ? s.countFullWaiting(slot.waiting) : s.countTaken(slot.confirmed, slot.capacity);
  return s.countLeft(slot.capacity - slot.confirmed);
}

/** Free places after the people already waiting (who move up first). */
export function roomFor(slot: { capacity: number; confirmed: number; waiting: number }): number {
  const free = Math.max(0, slot.capacity - slot.confirmed);
  return Math.max(0, free - Math.min(free, slot.waiting));
}

/** A multi-line text (a sheet's description) as paragraphs; plain text, never markup. */
export function paragraphs(text: string, className = 'description'): Html | null {
  const parts = text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  return html`<div class="${className}">${parts.map((part) => html`<p>${part}</p>`)}</div>`;
}

// --- Sharing and links ---------------------------------------------------------------------------------------------

export type SendLinks = { whatsapp: string | null; sms: string | null; email: string | null };

/** Characters of 16 px text in one line of a message box on a 320 px phone. */
const LINE_CHARACTERS = 30;

/**
 * How many lines a message box needs to show its whole text on a 320 px phone: each line of the text wrapped at about
 * 30 characters (a link breaks anywhere, so it wraps like text). Between 3 and 12; the CSS lets a browser that can fit
 * the box to its text do so exactly.
 */
export function messageRows(text: string): number {
  const wrapped = text.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / LINE_CHARACTERS)), 0);
  return Math.min(12, Math.max(3, wrapped));
}

/**
 * A ready-made message: the text in a read-only box (to copy by hand without the script), WhatsApp, Text and Email
 * where an address is known, and Copy and Share once the script runs. `share: false` leaves out the phone's share
 * sheet (for a message that must go to one person only). `collapsed`: the text folded under "See the message" (a
 * list of several messages), its buttons still at hand, since each carries the whole text.
 */
export function shareBox(options: {
  id: string;
  label: Child;
  text: ShareText;
  links: SendLinks;
  extra?: Child;
  share?: boolean;
  collapsed?: boolean;
}): Html {
  const { whatsapp, sms, email } = options.links;
  const box = html`<textarea id="${options.id}" class="message" readonly rows="${messageRows(options.text.text)}">${options.text.text}</textarea>
<p class="hint nojs">${words.ui.copyHint}</p>`;
  return html`<div class="share">
<label for="${options.id}">${options.label}</label>
${options.collapsed ? html`<details class="message-text"><summary>${words.ui.seeMessage}</summary>${box}</details>` : box}
<div class="actions">
${whatsapp ? html`<a class="button secondary" href="${shareHref(whatsapp)}">${words.ui.whatsapp}</a>` : null}
${sms ? html`<a class="button secondary" href="${shareHref(sms)}">${words.ui.sms}</a>` : null}
${email ? html`<a class="button secondary" href="${shareHref(email)}">${words.ui.email}</a>` : null}
${options.extra ?? null}
<button type="button" class="secondary" data-copy="${options.id}" data-done="${words.ui.copied}" hidden>${words.ui.copy}</button>
${options.share === false ? null : html`<button type="button" class="secondary" data-share="${options.id}" data-title="${options.text.subject}" hidden>${words.ui.share}</button>`}
</div>
</div>`;
}

/** A person's contact with Text, Email and WhatsApp links to it, each carrying `text`; null without a contact. */
export function personSendLinks(contact: string, text: ShareText): Html | null {
  if (!contact) return null;
  const links = personLinks(text, contact);
  const parts = [
    links.sms ? html`<a href="${shareHref(links.sms)}">${words.ui.sms}</a>` : null,
    links.email ? html`<a href="${shareHref(links.email)}">${words.ui.email}</a>` : null,
    links.whatsapp ? html`<a href="${shareHref(links.whatsapp)}">${words.ui.whatsapp}</a>` : null
  ].filter((part): part is Html => part !== null);
  return html`<span class="send">${contact}${parts.map((part) => html` · ${part}`)}</span>`;
}

export type PersonToTell = { name: string; contact: string; line?: Child; text: ShareText; groupText?: ShareText };

/**
 * People to tell, each with their own message: sent to their own contact (no share sheet, so it cannot go to a group by
 * mistake), or, for someone who gave none, a message for the group. `namesHidden` (a "Taken" sheet, whose messages name
 * the person): someone with no contact gets their own message for the organizer to send them, never one for the group.
 * Several people with no contact whose group message is the same word for word (a cancelled date's) share one box.
 */
export function tellList(people: readonly PersonToTell[], idPrefix: string, options: { namesHidden?: boolean } = {}): Html {
  const groupText = (person: PersonToTell) => person.groupText ?? person.text;
  const shared = (person: PersonToTell) => !person.contact && !options.namesHidden;
  const sameText = (person: PersonToTell) => people.filter((other) => shared(other) && groupText(other).text === groupText(person).text);
  return html`<ul class="rows">${people.map((person, index) => {
    const group = groupText(person);
    const together = shared(person) ? sameText(person) : [person];
    // The first of several with one message carries it, naming them all; the others only say who they are.
    const first = together[0] === person;
    const box = person.contact
      ? shareBox({ id: `${idPrefix}-${index}`, label: words.org.toPerson(person.name), text: person.text, links: personLinks(person.text, person.contact), share: false })
      : options.namesHidden
        ? shareBox({ id: `${idPrefix}-${index}`, label: words.share.noContactNamesHidden, text: person.text, links: shareLinks(person.text) })
        : !first
          ? null
          : together.length > 1
            ? shareBox({ id: `${idPrefix}-${index}`, label: words.share.noContactFor(together.map((each) => each.name).join(', ')), text: group, links: shareLinks(group) })
            : shareBox({ id: `${idPrefix}-${index}`, label: words.share.noContact, text: group, links: shareLinks(group) });
    return html`<li>
<p class="person-line"><span class="name">${person.name}</span>${person.contact ? html`<span class="meta">${person.contact}</span>` : null}</p>
${person.line ? html`<p class="meta">${person.line}</p>` : null}
${box}
</li>`;
  })}</ul>`;
}

/**
 * A private link in a read-only box, with Copy (and, with `share: true`, Share where the phone has it) once the script
 * runs; without the script, the hint to copy it by hand. A private link's own box has no Share: the phone's share sheet
 * offers the chats used last first, which for a parent is the group chat the sheet came from.
 */
export function linkBox(options: { id: string; label: Child; link: string; share?: boolean; copyLabel?: string }): Html {
  return html`<div class="linkbox">
<label for="${options.id}">${options.label}</label>
<input id="${options.id}" class="link" type="text" readonly value="${options.link}" autocomplete="off" spellcheck="false">
<p class="hint nojs">${words.ui.copyHint}</p>
<div class="actions">
<button type="button" class="primary" data-copy="${options.id}" data-done="${words.ui.copied}" hidden>${options.copyLabel ?? words.ui.copy}</button>
${options.share === true ? html`<button type="button" class="secondary" data-share-url="${options.id}" hidden>${words.ui.share}</button>` : null}
</div>
</div>`;
}

// --- `?e=` codes ---------------------------------------------------------------------------------------------------

const TEXT_ERRORS = { required: words.text.required, invalid: words.text.invalid, card: words.text.card } as const;

// The longest a field may be, where its name alone says which limit applies.
const FIELD_MAX: Record<string, number> = {
  name: MAX_LENGTH.name,
  contact: MAX_LENGTH.contact,
  note: MAX_LENGTH.note,
  title: MAX_LENGTH.sheetTitle,
  noteLabel: MAX_LENGTH.noteLabel,
  groupName: MAX_LENGTH.groupName,
  organizerName: MAX_LENGTH.organizerName,
  organizerContact: MAX_LENGTH.organizerContact,
  duesLabel: MAX_LENGTH.duesLabel,
  place: MAX_LENGTH.place
};

export type ErrorWording = {
  /** The longest a field may be, where FIELD_MAX does not say (or says otherwise for this form). */
  maxima?: Record<string, number>;
  /** A field's name where words.fields does not fit this form (a date's `label` is its label, not a name). */
  names?: Record<string, string>;
  /** False next to the field itself, whose label already names it. */
  withField?: boolean;
};

/**
 * The sentence for a `?e=` code (routes send `<field>-<error>` for a typed value, or a word from words.formErrors), or
 * null for a code the app never sends: nothing a request makes up is ever shown. `n` is the capacity refusal's number.
 */
export function errorSentence(code: string | null, n: string | null = null, wording: ErrorWording = {}): string | null {
  if (!code || !/^[A-Za-z_-]{1,40}$/.test(code)) return null;
  const f = words.fieldErrors;
  const fieldName = (field: string) => wording.names?.[field] ?? (words.fields as Record<string, string>)[field] ?? words.fields.name;
  const named = (field: string, sentence: string) => (wording.withField === false ? sentence : words.ui.error(fieldName(field), sentence));
  const text = /^([A-Za-z]+)-(required|too_long|invalid|card)$/.exec(code);
  if (text) {
    const [, field, error] = text as unknown as [string, string, keyof typeof TEXT_ERRORS | 'too_long'];
    if (!(field in words.fields)) return null;
    const max = wording.maxima?.[field] ?? FIELD_MAX[field];
    return named(field, error === 'too_long' ? (max ? words.text.tooLong(max) : f.tooLongHere) : TEXT_ERRORS[error]);
  }
  switch (code) {
    case 'slug-invalid':
      return named('slug', f.slugInvalid);
    case 'slug-reserved':
      return named('slug', f.slugReserved);
    case 'date':
    case 'from':
    case 'until':
      return named(code, f.date);
    case 'start':
      return named('start', f.time);
    case 'end':
      return named('end', f.end);
    case 'timezone':
      return named('timezone', f.timezone);
    case 'timezoneLocked':
      return words.formErrors.timezone;
    case 'capacity': {
      const confirmed = n !== null && /^[0-9]{1,4}$/.test(n) ? Number(n) : null;
      return confirmed !== null ? words.formErrors.capacity(confirmed) : named('capacity', f.capacity);
    }
    case 'names':
    case 'status':
      return named(code, f.choice);
    case 'duesAmount':
    case 'amount':
      return named(code, f.amount);
    case 'wrong':
      return words.organizer.signIn.wrong;
    default: {
      const known = (words.formErrors as Record<string, unknown>)[code];
      return typeof known === 'string' ? known : null;
    }
  }
}

/** The error a field shows next to itself when the page's `?e=` code is about it (its label already names it). */
export function fieldError(code: string | null, field: string, n: string | null = null, maxima: Record<string, number> = {}): string | null {
  if (!code) return null;
  if (code === field || code.startsWith(`${field}-`)) return errorSentence(code, n, { maxima, withField: false });
  return null;
}
