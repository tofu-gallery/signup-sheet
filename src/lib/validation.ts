// What a typed value must be before the app keeps it, for forms and imports alike (see TOFU.md, Privacy).
//
// Every text is NFC-normalized and trimmed (white space and invisible format characters at its ends). It is refused
// when it holds bidi overrides or isolates, control characters (a newline only where the field takes several lines), or
// when a required one has nothing visible left. Names, notes, paid notes and the sheet's own words refuse a run of 12 or
// more digits and an IBAN shape; a contact refuses a card number (13–19 digits passing Luhn) but takes a phone number.
// All text is shown through src/lib/html.ts, which escapes it: nothing is ever rendered as HTML or turned into a link.

export type TextError = 'required' | 'too_long' | 'invalid' | 'card';
export type Checked<T> = { ok: true; value: T } | { ok: false; error: TextError };

/** The longest each field may be, in characters (code points), as the schema's checks count them. */
export const MAX_LENGTH = {
  name: 80,
  contact: 200,
  note: 200,
  paidNote: 200,
  groupName: 80,
  organizerName: 60,
  organizerContact: 200,
  duesLabel: 60,
  sheetTitle: 120,
  sheetDescription: 1000,
  place: 200,
  dateLabel: 80,
  slotLabel: 80,
  slotDescription: 300,
  noteLabel: 40
} as const;

export type TextRules = {
  max: number;
  required?: boolean;
  /** Keeps newlines (a sheet's or slot's description). */
  multiline?: boolean;
  /** 'digits' refuses 12+ digit runs and IBANs; 'card' refuses card numbers only (contacts); 'none' checks neither. */
  payment: 'digits' | 'card' | 'none';
};

const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/;
// C0 controls except tab and newline (handled below), DEL, C1 controls.
const CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;
const EDGES = /^[\p{White_Space}\p{Cf}]+|[\p{White_Space}\p{Cf}]+$/gu;
// Nothing visible: white space, format characters, lone combining marks, and the "blank" letters used to fake a name.
const BLANK = /^[\p{White_Space}\p{Cf}\p{M}\u115F\u1160\u3164\uFFA0\u2800]*$/u;

const LONG_DIGIT_RUN = /\d(?:[ -]?\d){11,}/;
const IBAN = /\b[A-Z]{2}\d{2}(?:[A-Z0-9]{11,30}|(?: [A-Z0-9]{4}){2,7}(?: [A-Z0-9]{1,4})?)\b/;
const DIGIT_RUN = /\d(?:[ -]?\d)*/g;

export function checkText(raw: string, rules: TextRules): Checked<string> {
  let text = raw.normalize('NFC').replace(/\t/g, ' ');
  text = rules.multiline ? text.replace(/\r\n?/g, '\n') : text;
  if (BIDI_CONTROLS.test(text) || CONTROLS.test(text)) return { ok: false, error: 'invalid' };
  if (!rules.multiline && /[\n\r\u2028\u2029]/.test(text)) return { ok: false, error: 'invalid' };
  text = text.replace(EDGES, '');
  if (BLANK.test(text)) {
    return rules.required ? { ok: false, error: 'required' } : { ok: true, value: '' };
  }
  if ([...text].length > rules.max) return { ok: false, error: 'too_long' };
  if (rules.payment === 'digits' && (LONG_DIGIT_RUN.test(text) || IBAN.test(text))) return { ok: false, error: 'card' };
  if (rules.payment === 'card' && hasCardNumber(text)) return { ok: false, error: 'card' };
  return { ok: true, value: text };
}

// The usual fields, so every form and the import check them the same way.
export const checkName = (raw: string) => checkText(raw, { max: MAX_LENGTH.name, required: true, payment: 'digits' });
export const checkContact = (raw: string) => checkText(raw, { max: MAX_LENGTH.contact, payment: 'card' });
export const checkNote = (raw: string, required = false) =>
  checkText(raw, { max: MAX_LENGTH.note, required, payment: 'digits' });

/**
 * True when a run of digits (single spaces or dashes between them) is a card number: 13–19 digits passing the Luhn
 * check. A run longer than 19 digits (a card joined to other digits) is checked at every 13–19-digit stretch.
 */
export function hasCardNumber(text: string): boolean {
  for (const match of text.matchAll(DIGIT_RUN)) {
    const digits = match[0].replace(/[ -]/g, '');
    if (digits.length < 13) continue;
    if (digits.length <= 19) {
      if (luhn(digits)) return true;
      continue;
    }
    for (let length = 13; length <= 19; length += 1) {
      for (let start = 0; start + length <= digits.length; start += 1) {
        if (luhn(digits.slice(start, start + length))) return true;
      }
    }
  }
  return false;
}

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

const SLUG = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;
const ID = /^[1-9][0-9]{0,17}$/;

export function isSlug(text: string): boolean {
  return SLUG.test(text);
}

/** Sheet addresses the app's own pages use (/organizer/sheets/new), so no sheet may have them. */
export const RESERVED_SLUGS: readonly string[] = ['new'];

export function isReservedSlug(text: string): boolean {
  return RESERVED_SLUGS.includes(text);
}

/** A row id from a path or a form: a positive integer, kept as text (PostgreSQL's bigint). */
export function idFrom(text: string): string | null {
  const id = text.trim();
  return ID.test(id) ? id : null;
}

/** A place count: a whole number from 1 to 500. */
export function capacityFrom(text: string): number | null {
  const value = text.trim();
  if (!/^[0-9]{1,3}$/.test(value)) return null;
  const capacity = Number(value);
  return capacity >= 1 && capacity <= 500 ? capacity : null;
}

const DOLLARS = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/** Cents as dollars: 4000 → '$40.00'. */
export function formatCents(cents: number): string {
  return DOLLARS.format(cents / 100);
}

/** Dollars as typed ('40', '$40.00') in cents, up to $100,000. '' is null; anything else is undefined (refused). */
export function centsFrom(text: string): number | null | undefined {
  const value = text.trim();
  if (value === '') return null;
  const match = /^\$?\s*([0-9]{1,6})(?:\.([0-9]{2}))?$/.exec(value);
  if (!match) return undefined;
  const cents = Number(match[1]) * 100 + Number(match[2] ?? '0');
  return cents <= 10_000_000 ? cents : undefined;
}
