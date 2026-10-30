// The organizer's forms read into checked fields (validation.ts, time.ts). Each answers the fields, or the `?e=` code
// of the first wrong one: `<field>-<error>` for a text (`title-required`, `place-card`), else the field's name.
import { field } from './request';
import type { DateFields, GroupSettings, SheetFields, SlotFields } from './structure';
import { addDays, isTimeZone, parseDate, parseTime } from './time';
import { capacityFrom, centsFrom, checkContact, checkName, checkText, isReservedSlug, isSlug, MAX_LENGTH, type Checked, type TextRules } from './validation';

export type Parsed<T> = { ok: true; value: T } | { ok: false; code: string };

class Wrong extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function checked(name: string, result: Checked<string>): string {
  if (!result.ok) throw new Wrong(`${name}-${result.error}`);
  return result.value;
}

function text(form: URLSearchParams, name: string, rules: TextRules): string {
  return checked(name, checkText(field(form, name), rules));
}

function parse<T>(read: () => T): Parsed<T> {
  try {
    return { ok: true, value: read() };
  } catch (error) {
    if (error instanceof Wrong) return { ok: false, code: error.code };
    throw error;
  }
}

/** A person's name and contact. */
export function personFrom(form: URLSearchParams): Parsed<{ name: string; contact: string }> {
  return parse(() => ({ name: checked('name', checkName(field(form, 'name'))), contact: checked('contact', checkContact(field(form, 'contact'))) }));
}

/** `start` and `end` (HH:MM, both optional; an end needs a start and comes after it). */
function timesFrom(form: URLSearchParams): { startsAt: string | null; endsAt: string | null } {
  const time = (name: string) => {
    const raw = field(form, name).trim();
    if (!raw) return null;
    const value = parseTime(raw);
    if (!value) throw new Wrong(name);
    return value;
  };
  const startsAt = time('start');
  const endsAt = time('end');
  if (endsAt && (!startsAt || endsAt <= startsAt)) throw new Wrong('end');
  return { startsAt, endsAt };
}

/** A date: `date` (YYYY-MM-DD), `start` and `end` (HH:MM, both optional; an end needs a start), `label`, `place`. */
export function dateFrom(form: URLSearchParams): Parsed<DateFields> {
  return parse(() => {
    const onDate = parseDate(field(form, 'date'));
    if (!onDate) throw new Wrong('date');
    return {
      onDate,
      ...timesFrom(form),
      label: text(form, 'label', { max: MAX_LENGTH.dateLabel, payment: 'digits' }),
      place: text(form, 'place', { max: MAX_LENGTH.place, payment: 'digits' })
    };
  });
}

/** The most dates one "Add a date every week" makes. */
export const WEEKLY_MAX_DATES = 60;

export type WeeklyDates = { days: string[]; startsAt: string | null; endsAt: string | null; place: string; withSlots: boolean };

/**
 * "Add a date every week": every 7 days from `from` up to `until` (YYYY-MM-DD), each with `start`, `end` and `place`;
 * `withSlots=1` gives each the places of the sheet's latest date. The codes: from, until, order, tooMany, start, end,
 * and place-<error>.
 */
export function weeklyFrom(form: URLSearchParams): Parsed<WeeklyDates> {
  return parse(() => {
    const from = parseDate(field(form, 'from'));
    if (!from) throw new Wrong('from');
    const until = parseDate(field(form, 'until'));
    if (!until) throw new Wrong('until');
    if (until < from) throw new Wrong('order');
    const days: string[] = [];
    for (let day = from; day <= until; day = addDays(day, 7)) {
      if (days.length === WEEKLY_MAX_DATES) throw new Wrong('tooMany');
      days.push(day);
    }
    return {
      days,
      ...timesFrom(form),
      place: text(form, 'place', { max: MAX_LENGTH.place, payment: 'digits' }),
      withSlots: field(form, 'withSlots') === '1'
    };
  });
}

/** A slot: `label`, `description`, `capacity` (1–500). */
export function slotFrom(form: URLSearchParams): Parsed<SlotFields> {
  return parse(() => {
    const label = text(form, 'label', { max: MAX_LENGTH.slotLabel, required: true, payment: 'digits' });
    const description = text(form, 'description', { max: MAX_LENGTH.slotDescription, multiline: true, payment: 'digits' });
    const capacity = capacityFrom(field(form, 'capacity'));
    if (capacity === null) throw new Wrong('capacity');
    return { label, description, capacity };
  });
}

const STATUSES = ['draft', 'open', 'closed'] as const;

export function statusFrom(form: URLSearchParams): Parsed<(typeof STATUSES)[number]> {
  const status = STATUSES.find((value) => value === field(form, 'status'));
  return status ? { ok: true, value: status } : { ok: false, code: 'status' };
}

/**
 * A sheet's words and settings. `listed` is on unless the form sends `listed=0`, and `noteRequired` only with
 * `noteRequired=1`, so a form without them makes an ordinary listed sheet. The time zone is `timezone`, or with
 * `timezone=other` the name typed in `timezoneOther`.
 */
export function sheetFrom(form: URLSearchParams): Parsed<SheetFields> {
  return parse(() => {
    const chosen = field(form, 'timezone').trim();
    const timezone = chosen === 'other' ? field(form, 'timezoneOther').trim() : chosen;
    if (!isTimeZone(timezone)) throw new Wrong('timezone');
    const names = field(form, 'names') || 'full';
    if (names !== 'full' && names !== 'taken') throw new Wrong('names');
    return {
      title: text(form, 'title', { max: MAX_LENGTH.sheetTitle, required: true, payment: 'digits' }),
      description: text(form, 'description', { max: MAX_LENGTH.sheetDescription, multiline: true, payment: 'digits' }),
      timezone,
      place: text(form, 'place', { max: MAX_LENGTH.place, payment: 'digits' }),
      names,
      noteLabel: text(form, 'noteLabel', { max: MAX_LENGTH.noteLabel, payment: 'digits' }),
      noteRequired: field(form, 'noteRequired') === '1',
      listed: field(form, 'listed') !== '0'
    };
  });
}

/** A new sheet: its fields, its `slug` and its `status`. */
export function newSheetFrom(form: URLSearchParams): Parsed<SheetFields & { slug: string; status: (typeof STATUSES)[number] }> {
  const sheet = sheetFrom(form);
  if (!sheet.ok) return sheet;
  const slug = field(form, 'slug').trim();
  if (!isSlug(slug)) return { ok: false, code: 'slug-invalid' };
  if (isReservedSlug(slug)) return { ok: false, code: 'slug-reserved' };
  const status = statusFrom(form);
  if (!status.ok) return status;
  return { ok: true, value: { ...sheet.value, slug, status: status.value } };
}

/** The group's settings: names, the organizer's contact, and dues (an empty label means no dues). */
export function settingsFrom(form: URLSearchParams): Parsed<GroupSettings> {
  return parse(() => {
    const dues = centsFrom(field(form, 'duesAmount'));
    if (dues === undefined) throw new Wrong('duesAmount');
    return {
      groupName: text(form, 'groupName', { max: MAX_LENGTH.groupName, payment: 'digits' }),
      organizerName: text(form, 'organizerName', { max: MAX_LENGTH.organizerName, payment: 'digits' }),
      organizerContact: checked('organizerContact', checkText(field(form, 'organizerContact'), { max: MAX_LENGTH.organizerContact, payment: 'card' })),
      duesLabel: text(form, 'duesLabel', { max: MAX_LENGTH.duesLabel, payment: 'digits' }),
      duesAmountCents: dues
    };
  });
}

/** Paid or not (`paid=1`), the amount in dollars, and a note. */
export function paidFrom(form: URLSearchParams): Parsed<{ paid: boolean; amountCents: number | null; note: string }> {
  return parse(() => {
    const amountCents = centsFrom(field(form, 'amount'));
    if (amountCents === undefined) throw new Wrong('amount');
    return { paid: field(form, 'paid') === '1', amountCents, note: text(form, 'note', { max: MAX_LENGTH.paidNote, payment: 'digits' }) };
  });
}
