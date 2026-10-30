// The import and export format, signup-sheet/1 (see TOFU.md, Import and export): reading a file strictly into an
// ImportPlan (importer.ts writes it). The whole file is checked before anything is written, and the first thing wrong
// refuses all of it with one sentence: a path and what is wrong there (`sheets[0].dates[2].weekday: …`), or one of the
// exact sentences in words.ts.
//
// The file is read by a JSON reader of its own, because JSON.parse silently keeps the last of two fields with the same
// name. Here a field written twice is refused, and so is a field this format does not have (except `from`, anywhere,
// and the fields only an export writes, which are accepted: see below), a value that is not one of its choices, a day
// whose weekday does not match, and anything that could name two things (two dates of a sheet at one day and time, two
// slots of a date with one label, a day with several times named without its time). Texts get the same checks as the
// app's own forms (validation.ts).
//
// A file with `exportedAt` is an export from some copy. Its person ids are that copy's, so they are never matched with
// anyone here: everyone in it becomes a new person. Its sign-ups' history is restored with them: who added each one
// (`addedBy`), when it was made (`signedUpAt`), when it moved up from the waitlist (`promotedAt`) and whether the
// organizer marked them told (`told`, restored as told at the export's own `exportedAt`, the latest moment the file can
// vouch for). In any other file, a person's `id` names someone already here, who is kept exactly as they are, and those
// history fields are read and ignored.
import { words } from '../words';
import type { ImportGroup, ImportPlan } from './importer';
import { IMPORT_LIMIT_BYTES } from './request';
import { dateWords, formatDate, formatWhen, isOpenForClaims, isTimeZone, parseDate, parseTime, weekdayFrom, weekdayIndex } from './time';
import { checkText, isReservedSlug, isSlug, MAX_LENGTH, type Checked, type TextRules } from './validation';

export const FORMAT = 'signup-sheet/1';

/** The most one file may hold. The copy's own row caps (caps.ts) apply as well. */
export const FILE_LIMITS = { sheets: 20, datesPerSheet: 200, slotsPerDate: 20, people: 500, signups: 2_000 } as const;

export type ImportRefusalText = { sentence: string; path: string | null };

export type ReadImport = {
  plan: ImportPlan;
  /** The file's own `dryRun`, or null when it has none. */
  dryRun: boolean | null;
  /** When the file says it was exported (`exportedAt`), else null. */
  exportedAt: Date | null;
  /** Where each person and sheet is in the file (`people[2]`, `sheets[0]`), to name a refusal the database finds. */
  personPaths: Map<string, string>;
  sheetPaths: Map<string, string>;
};

// --- A strict JSON reader -------------------------------------------------------------------------------------------

export type Json = null | boolean | number | string | Json[] | JsonObject;
export interface JsonObject {
  [key: string]: Json;
}

/** A refusal of the whole file: one sentence, and the field it is about when there is one. */
class Refusal extends Error {
  constructor(
    readonly sentence: string,
    readonly path: string | null
  ) {
    super(sentence);
    this.name = 'Refusal';
  }
}

const MAX_DEPTH = 24;
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;
const ESCAPES: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

/** A path to show: `sheets[0].dates[2]`, or "The file" for the file itself. */
function shown(path: string): string {
  return path || words.import.fileItself;
}

function member(path: string, name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return `${path}[${JSON.stringify(name)}]`;
  return path ? `${path}.${name}` : name;
}

function item(path: string, index: number): string {
  return `${path}[${index}]`;
}

/**
 * Reads JSON text (RFC 8259) into plain values. Objects have no prototype, so a field named `__proto__` is only a field.
 * A field written twice in one object, nesting deeper than 24, and text that is not whole characters are refused.
 */
export function parseStrictJson(text: string): Json {
  let at = 0;
  const syntax = (where = at): never => {
    const before = text.slice(0, where);
    const line = before.split('\n').length;
    throw new Refusal(words.import.notJson(line, where - before.lastIndexOf('\n')), null);
  };
  const space = () => {
    for (;;) {
      const c = text.charCodeAt(at);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) at += 1;
      else return;
    }
  };
  const literal = <T extends Json>(word: string, result: T): T => {
    if (!text.startsWith(word, at)) syntax();
    at += word.length;
    return result;
  };
  const string = (): string => {
    const opened = at;
    at += 1;
    let out = '';
    let run = at;
    for (;;) {
      if (at >= text.length) syntax();
      const c = text.charCodeAt(at);
      if (c === 0x22) break;
      if (c < 0x20) syntax();
      if (c !== 0x5c) {
        at += 1;
        continue;
      }
      out += text.slice(run, at);
      const escape = text[at + 1];
      if (escape === 'u') {
        const hex = text.slice(at + 2, at + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) syntax();
        out += String.fromCharCode(parseInt(hex, 16));
        at += 6;
      } else if (escape !== undefined && Object.prototype.hasOwnProperty.call(ESCAPES, escape)) {
        out += ESCAPES[escape];
        at += 2;
      } else {
        syntax();
      }
      run = at;
    }
    out += text.slice(run, at);
    at += 1;
    if (LONE_SURROGATE.test(out)) syntax(opened);
    return out;
  };
  const value = (path: string, depth: number): Json => {
    if (depth > MAX_DEPTH) throw new Refusal(words.import.tooDeep, null);
    space();
    switch (text[at]) {
      case '{': {
        at += 1;
        const result: JsonObject = Object.create(null) as JsonObject;
        space();
        if (text[at] === '}') {
          at += 1;
          return result;
        }
        for (;;) {
          space();
          if (text[at] !== '"') syntax();
          const key = string();
          if (Object.prototype.hasOwnProperty.call(result, key)) {
            throw new Refusal(words.import.field(shown(path), words.import.problem.sameJsonField(key)), path || null);
          }
          space();
          if (text[at] !== ':') syntax();
          at += 1;
          result[key] = value(member(path, key), depth + 1);
          space();
          if (text[at] === ',') {
            at += 1;
            continue;
          }
          if (text[at] !== '}') syntax();
          at += 1;
          return result;
        }
      }
      case '[': {
        at += 1;
        const result: Json[] = [];
        space();
        if (text[at] === ']') {
          at += 1;
          return result;
        }
        for (;;) {
          result.push(value(item(path, result.length), depth + 1));
          space();
          if (text[at] === ',') {
            at += 1;
            continue;
          }
          if (text[at] !== ']') syntax();
          at += 1;
          return result;
        }
      }
      case '"':
        return string();
      case 't':
        return literal('true', true);
      case 'f':
        return literal('false', false);
      case 'n':
        return literal('null', null);
      default: {
        NUMBER.lastIndex = at;
        const match = NUMBER.exec(text);
        if (!match) return syntax();
        const number = Number(match[0]);
        if (!Number.isFinite(number)) syntax();
        at += match[0].length;
        return number;
      }
    }
  };
  // A byte order mark some editors write first is not part of the JSON.
  if (text.charCodeAt(0) === 0xfeff) at = 1;
  const result = value('', 0);
  space();
  if (at !== text.length) syntax();
  return result;
}

// --- Fields ---------------------------------------------------------------------------------------------------------

const p = words.import.problem;

function wrong(path: string, problem: string): never {
  throw new Refusal(words.import.field(shown(path), problem), path || null);
}

function isObject(value: Json | undefined): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function objectAt(value: Json | undefined, path: string): JsonObject {
  if (!isObject(value)) wrong(path, p.object);
  return value;
}

function listAt(value: Json | undefined, path: string, max: number, what: string): Json[] {
  if (!Array.isArray(value)) wrong(path, p.list);
  if (value.length > max) wrong(path, p.tooMany(max, what));
  return value;
}

/** A field only an export writes: accepted and ignored, once it looks like what an export writes there. */
type ExportOnly = { looksRight: (value: Json) => boolean; problem: string };

/** Refuses a field this kind of object cannot have. `from` is allowed anywhere: text, or an object of texts. */
function onlyFields(value: JsonObject, path: string, fields: readonly string[], exportOnly: Record<string, ExportOnly> = {}): void {
  for (const [name, field] of Object.entries(value)) {
    if (name === 'from') {
      if (typeof field !== 'string' && !(isObject(field) && Object.values(field).every((source) => typeof source === 'string'))) {
        wrong(member(path, name), p.from);
      }
      continue;
    }
    if (fields.includes(name)) continue;
    const ignored = Object.prototype.hasOwnProperty.call(exportOnly, name) ? exportOnly[name] : undefined;
    if (!ignored) throw new Refusal(words.import.unknownField(shown(path), name), member(path, name));
    if (!ignored.looksRight(field)) wrong(member(path, name), ignored.problem);
  }
}

const RULE_PROBLEM = { required: p.required, invalid: p.invalid, card: p.card } as const;

function checked(path: string, result: Checked<string>, rules: TextRules): string {
  if (result.ok) return result.value;
  wrong(path, result.error === 'too_long' ? p.tooLong(rules.max) : RULE_PROBLEM[result.error]);
}

/** A text field, checked as the app's forms check it. Left out: '' (or refused, when required). */
function textField(value: JsonObject, name: string, path: string, rules: TextRules): string {
  const field = value[name];
  const at = member(path, name);
  if (field === undefined) {
    if (rules.required) wrong(at, p.missing);
    return '';
  }
  if (typeof field !== 'string') wrong(at, p.text);
  return checked(at, checkText(field, rules), rules);
}

// A moment as an export writes it: UTC, to the second or the millisecond.
const MOMENT = /^(\d{4})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
// How far another copy's clock may be ahead of this one's.
const CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * A moment written as an export writes it ('2026-10-29T19:00:00.000Z'), or null when the field is null: a day and time
 * that exist (Date moves Feb 30 or 24:00 on, so they no longer read back the same), from the year 2000 on, and never
 * later than now (a few minutes of another clock aside). A time from the future would stay ahead of every change the
 * calendar files count (views.ts SEQUENCE).
 */
function momentAt(field: Json | undefined, path: string, now: Date): Date | null {
  if (field === null) return null;
  const match = typeof field === 'string' ? MOMENT.exec(field) : null;
  const when = match ? new Date(match[0]) : null;
  if (!when || Number.isNaN(when.getTime()) || when.toISOString().slice(0, 19) !== match![0].slice(0, 19) || Number(match![1]) < 2000) {
    wrong(path, p.moment);
  }
  if (when.getTime() > now.getTime() + CLOCK_SKEW_MS) wrong(path, p.momentAhead);
  return when;
}

function booleanField(value: JsonObject, name: string, path: string, otherwise: boolean): boolean {
  const field = value[name];
  if (field === undefined) return otherwise;
  if (typeof field !== 'boolean') wrong(member(path, name), p.boolean);
  return field;
}

function wholeNumber(field: Json | undefined, path: string, min: number, max: number): number {
  if (typeof field !== 'number' || !Number.isInteger(field) || field < min || field > max) wrong(path, p.wholeNumber(min, max));
  return field;
}

function choiceField<T extends string>(value: JsonObject, name: string, path: string, choices: readonly T[], otherwise: T): T {
  const field = value[name];
  if (field === undefined) return otherwise;
  const choice = choices.find((each) => each === field);
  if (!choice) wrong(member(path, name), p.oneOf(choices));
  return choice;
}

const DIGITS = (max: number, extra: Partial<TextRules> = {}): TextRules => ({ max, payment: 'digits', ...extra });
const NAME = DIGITS(MAX_LENGTH.name, { required: true });
const CONTACT: TextRules = { max: MAX_LENGTH.contact, payment: 'card' };
const MONEY = { min: 0, max: 10_000_000 } as const;

// What the export-only fields look like.
const isRowId = (v: Json | undefined) =>
  (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) || (typeof v === 'string' && /^[1-9][0-9]{0,17}$/.test(v));
const EXPORTED_TIME: ExportOnly = { looksRight: (v) => v === null || typeof v === 'string', problem: p.text };
const EXPORT_ONLY = {
  file: { exportedAt: { looksRight: (v: Json) => typeof v === 'string', problem: p.moment } },
  person: { hasLink: { looksRight: (v: Json) => typeof v === 'boolean', problem: p.boolean } },
  sheet: { id: { looksRight: isRowId, problem: p.rowId } },
  signup: {
    addedBy: { looksRight: (v: Json) => v === 'member' || v === 'organizer' || v === 'import', problem: p.oneOf(['member', 'organizer', 'import']) },
    signedUpAt: EXPORTED_TIME,
    promotedAt: EXPORTED_TIME,
    told: { looksRight: (v: Json) => typeof v === 'boolean', problem: p.boolean }
  }
} satisfies Record<string, Record<string, ExportOnly>>;

// --- The file -------------------------------------------------------------------------------------------------------

type DatePlan = ImportPlan['sheets'][number]['dates'][number];

/**
 * Reads a whole file. `now` decides which dates are still ahead (a waiting sign-up on a date ahead must be waiting for
 * a full place). Answers the plan, or the refusal of the first thing wrong (its sentence without "Nothing was imported").
 */
export function readImportFile(text: string, now: Date): { ok: true; value: ReadImport } | { ok: false; refusal: ImportRefusalText } {
  try {
    return { ok: true, value: readFile(text, now) };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, refusal: { sentence: error.sentence, path: error.path } };
    throw error;
  }
}

function readFile(text: string, now: Date): ReadImport {
  if (Buffer.byteLength(text, 'utf8') > IMPORT_LIMIT_BYTES) throw new Refusal(words.import.tooBig, null);
  if (text.trim() === '') throw new Refusal(words.import.empty, null);
  const file = parseStrictJson(text);
  if (!isObject(file) || file.format !== FORMAT) throw new Refusal(words.import.notFormat, 'format');
  onlyFields(file, '', ['format', 'dryRun', 'replace', 'group', 'people', 'sheets'], EXPORT_ONLY.file);

  // onlyFields has checked that it is text; null is not a moment here.
  const exportedAt = file.exportedAt === undefined ? null : (momentAt(file.exportedAt, 'exportedAt', now) ?? wrong('exportedAt', p.moment));
  const exported = exportedAt !== null;
  const dryRun = file.dryRun === undefined ? null : booleanField(file, 'dryRun', '', false);
  const replace = booleanField(file, 'replace', '', false);
  const group = file.group === undefined ? null : readGroup(file.group, 'group');

  const people: ImportPlan['people'] = [];
  const personPaths = new Map<string, string>();
  const existing = new Set<string>();
  const peopleList = file.people === undefined ? [] : listAt(file.people, 'people', FILE_LIMITS.people, 'people');
  for (const [index, value] of peopleList.entries()) {
    const path = item('people', index);
    const person = readPerson(value, path, exported);
    if (personPaths.has(person.key)) wrong(member(path, 'key'), p.sameKey(person.key));
    if (person.existingId !== null) {
      if (existing.has(person.existingId)) wrong(member(path, 'id'), p.sameId);
      existing.add(person.existingId);
    }
    personPaths.set(person.key, path);
    people.push(person);
  }

  const sheets: ImportPlan['sheets'] = [];
  const sheetPaths = new Map<string, string>();
  const sheetList = file.sheets === undefined ? [] : listAt(file.sheets, 'sheets', FILE_LIMITS.sheets, 'sheets');
  let signups = 0;
  for (const [index, value] of sheetList.entries()) {
    const path = item('sheets', index);
    const sheet = readSheet(value, path, { people: new Map(people.map((person) => [person.key, person])), exportedAt, now, signupsBefore: signups });
    if (sheetPaths.has(sheet.slug)) wrong(member(path, 'slug'), p.sameSlug(sheet.slug));
    sheetPaths.set(sheet.slug, path);
    signups += sheet.signups.length;
    sheets.push(sheet);
  }

  return { plan: { replace, exported, group, people, sheets }, dryRun, exportedAt, personPaths, sheetPaths };
}

/** `group`: each of `name`, `organizer` and `dues` changes only when the file gives it. */
function readGroup(value: Json, path: string): ImportGroup {
  const group = objectAt(value, path);
  onlyFields(group, path, ['name', 'organizer', 'dues']);
  const result: ImportGroup = {};
  if (group.name !== undefined) result.groupName = textField(group, 'name', path, DIGITS(MAX_LENGTH.groupName));
  if (group.organizer !== undefined) {
    const at = member(path, 'organizer');
    const organizer = objectAt(group.organizer, at);
    onlyFields(organizer, at, ['name', 'contact']);
    if (organizer.name === undefined) wrong(member(at, 'name'), p.missing);
    result.organizerName = textField(organizer, 'name', at, DIGITS(MAX_LENGTH.organizerName));
    result.organizerContact = textField(organizer, 'contact', at, { max: MAX_LENGTH.organizerContact, payment: 'card' });
  }
  if (group.dues !== undefined) {
    const at = member(path, 'dues');
    if (group.dues === null) {
      result.duesLabel = '';
      result.duesAmountCents = null;
    } else {
      if (!isObject(group.dues)) wrong(at, p.objectOrNull);
      const dues = group.dues;
      onlyFields(dues, at, ['label', 'amountCents']);
      result.duesLabel = textField(dues, 'label', at, DIGITS(MAX_LENGTH.duesLabel, { required: true }));
      result.duesAmountCents =
        dues.amountCents === undefined || dues.amountCents === null ? null : wholeNumber(dues.amountCents, member(at, 'amountCents'), MONEY.min, MONEY.max);
    }
  }
  return result;
}

const KEY = /^\S(?:[^\p{Cc}\p{Cf}]{0,78}\S)?$/u;

function readPerson(value: Json, path: string, exported: boolean): ImportPlan['people'][number] {
  const person = objectAt(value, path);
  onlyFields(person, path, ['key', 'id', 'name', 'contact', 'paid', 'paidAmountCents', 'paidNote'], EXPORT_ONLY.person);
  const key = person.key;
  if (key === undefined) wrong(member(path, 'key'), p.missing);
  if (typeof key !== 'string' || !KEY.test(key) || /[\p{Cc}\p{Cf}]/u.test(key)) wrong(member(path, 'key'), p.key);
  const name = textField(person, 'name', path, NAME);

  let existingId: string | null = null;
  if (person.id !== undefined) {
    if (!isRowId(person.id)) wrong(member(path, 'id'), p.personId);
    // In an export the id is the other copy's: never someone here. Elsewhere it names someone here, kept as they are.
    if (!exported) {
      existingId = String(person.id);
      for (const field of ['contact', 'paid', 'paidAmountCents', 'paidNote']) {
        if (person[field] !== undefined) wrong(member(path, field), p.keptAsTheyAre(field));
      }
    }
  }
  const cents = person.paidAmountCents;
  return {
    key,
    existingId,
    name,
    contact: textField(person, 'contact', path, CONTACT),
    paid: booleanField(person, 'paid', path, false),
    paidAmountCents: cents === undefined || cents === null ? null : wholeNumber(cents, member(path, 'paidAmountCents'), MONEY.min, MONEY.max),
    paidNote: textField(person, 'paidNote', path, DIGITS(MAX_LENGTH.paidNote))
  };
}

function readSlot(value: Json, path: string): ImportPlan['sheets'][number]['dates'][number]['slots'][number] {
  const slot = objectAt(value, path);
  onlyFields(slot, path, ['label', 'capacity', 'description']);
  if (slot.capacity === undefined) wrong(member(path, 'capacity'), p.missing);
  return {
    label: textField(slot, 'label', path, DIGITS(MAX_LENGTH.slotLabel, { required: true })),
    capacity: wholeNumber(slot.capacity, member(path, 'capacity'), 1, 500),
    description: textField(slot, 'description', path, DIGITS(MAX_LENGTH.slotDescription, { multiline: true }))
  };
}

function readSlots(value: Json | undefined, path: string): DatePlan['slots'] {
  const slots: DatePlan['slots'] = [];
  for (const [index, each] of listAt(value, path, FILE_LIMITS.slotsPerDate, 'slots').entries()) {
    const slot = readSlot(each, item(path, index));
    if (slots.some((other) => other.label === slot.label)) wrong(member(item(path, index), 'label'), p.sameSlot(slot.label));
    slots.push(slot);
  }
  return slots;
}

/** A time field: 'HH:MM' (seconds, as an export never writes them, are refused). */
function timeField(field: Json | undefined, path: string): string {
  if (typeof field !== 'string' || !/^[0-9]{2}:[0-9]{2}$/.test(field)) wrong(path, p.time);
  const time = parseTime(field);
  if (!time) wrong(path, p.time);
  return time;
}

function readDate(value: Json, path: string, everyDate: DatePlan['slots'] | null): DatePlan {
  const date = objectAt(value, path);
  onlyFields(date, path, ['date', 'weekday', 'start', 'end', 'label', 'place', 'cancelled', 'slots']);
  if (date.date === undefined) wrong(member(path, 'date'), p.missing);
  const onDate = typeof date.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date.date) ? parseDate(date.date) : null;
  if (!onDate) wrong(member(path, 'date'), p.date);
  if (date.weekday !== undefined) {
    if (typeof date.weekday !== 'string') wrong(member(path, 'weekday'), p.text);
    const said = weekdayFrom(date.weekday);
    if (said === null) wrong(member(path, 'weekday'), p.weekdayWord(date.weekday));
    const actual = weekdayIndex(onDate);
    if (said !== actual) throw new Refusal(words.import.weekday(onDate, words.calendar.weekdaysLong[actual]!, date.weekday), member(path, 'weekday'));
  }
  const startsAt = date.start === undefined || date.start === null ? null : timeField(date.start, member(path, 'start'));
  const endsAt = date.end === undefined || date.end === null ? null : timeField(date.end, member(path, 'end'));
  if (endsAt && !startsAt) wrong(member(path, 'end'), p.endNeedsStart);
  if (endsAt && startsAt && endsAt <= startsAt) wrong(member(path, 'end'), p.endAfterStart);
  return {
    onDate,
    startsAt,
    endsAt,
    label: textField(date, 'label', path, DIGITS(MAX_LENGTH.dateLabel)),
    place: textField(date, 'place', path, DIGITS(MAX_LENGTH.place)),
    cancelled: booleanField(date, 'cancelled', path, false),
    slots: date.slots === undefined ? (everyDate ?? []).map((slot) => ({ ...slot })) : readSlots(date.slots, member(path, 'slots'))
  };
}

type SheetContext = {
  people: Map<string, ImportPlan['people'][number]>;
  /** The export's own time, or null for an ordinary file. */
  exportedAt: Date | null;
  now: Date;
  /** Sign-ups in the sheets before this one, for the file's limit. */
  signupsBefore: number;
};

function readSheet(value: Json, path: string, context: SheetContext): ImportPlan['sheets'][number] {
  const sheet = objectAt(value, path);
  onlyFields(
    sheet,
    path,
    ['slug', 'title', 'description', 'timezone', 'place', 'names', 'status', 'noteLabel', 'noteRequired', 'listed', 'everyDate', 'dates', 'signups'],
    EXPORT_ONLY.sheet
  );
  if (sheet.slug === undefined) wrong(member(path, 'slug'), p.missing);
  if (typeof sheet.slug !== 'string' || !isSlug(sheet.slug)) wrong(member(path, 'slug'), p.slug);
  if (isReservedSlug(sheet.slug)) wrong(member(path, 'slug'), p.slugReserved);
  const slug = sheet.slug;
  const title = textField(sheet, 'title', path, DIGITS(MAX_LENGTH.sheetTitle, { required: true }));
  if (sheet.timezone === undefined) wrong(member(path, 'timezone'), p.missing);
  if (typeof sheet.timezone !== 'string') wrong(member(path, 'timezone'), p.text);
  if (!isTimeZone(sheet.timezone)) throw new Refusal(words.import.timeZone(sheet.timezone), member(path, 'timezone'));
  const timezone = sheet.timezone;
  const noteLabel = textField(sheet, 'noteLabel', path, DIGITS(MAX_LENGTH.noteLabel));
  const noteRequired = booleanField(sheet, 'noteRequired', path, false);
  const fields = {
    slug,
    title,
    description: textField(sheet, 'description', path, DIGITS(MAX_LENGTH.sheetDescription, { multiline: true })),
    timezone,
    place: textField(sheet, 'place', path, DIGITS(MAX_LENGTH.place)),
    names: choiceField(sheet, 'names', path, ['full', 'taken'] as const, 'full'),
    status: choiceField(sheet, 'status', path, ['draft', 'open', 'closed'] as const, 'draft'),
    noteLabel,
    noteRequired,
    listed: booleanField(sheet, 'listed', path, true)
  };
  const everyDate = sheet.everyDate === undefined ? null : readSlots(sheet.everyDate, member(path, 'everyDate'));

  if (sheet.dates === undefined) wrong(member(path, 'dates'), p.missing);
  const dates: DatePlan[] = [];
  for (const [index, each] of listAt(sheet.dates, member(path, 'dates'), FILE_LIMITS.datesPerSheet, 'dates').entries()) {
    const date = readDate(each, item(member(path, 'dates'), index), everyDate);
    if (dates.some((other) => other.onDate === date.onDate && other.startsAt === date.startsAt)) {
      wrong(item(member(path, 'dates'), index), p.sameDate(formatWhen(date.onDate, date.startsAt)));
    }
    dates.push(date);
  }

  const signups = readSignups(sheet.signups, member(path, 'signups'), {
    ...context,
    dates,
    timezone,
    // A restored export keeps sign-ups made before the sheet started to ask for a note.
    noteRequired: noteRequired && context.exportedAt === null,
    noteLabel
  });
  return { ...fields, dates, signups };
}

type SignupContext = SheetContext & { dates: DatePlan[]; timezone: string; noteRequired: boolean; noteLabel: string };

type SignupHistory = Pick<ImportPlan['sheets'][number]['signups'][number], 'addedBy' | 'signedUpAt' | 'promotedAt' | 'toldAt'>;

/**
 * An export's sign-up history, restored: who added it, when it was made (null, as when the file leaves it out: made by
 * the import), when it moved up, and whether its person was told (told at the export's own time; the file says only
 * that it happened by then). An ordinary file's history fields were checked by onlyFields and are ignored: its sign-ups
 * count as imported, as a new sign-up made by an import does.
 */
function history(signup: JsonObject, at: string, exportedAt: Date | null, now: Date): SignupHistory {
  if (!exportedAt) return {};
  const addedBy = signup.addedBy === undefined ? 'import' : (signup.addedBy as 'member' | 'organizer' | 'import');
  const signedUp = signup.signedUpAt === undefined ? null : momentAt(signup.signedUpAt, member(at, 'signedUpAt'), now);
  const promoted = signup.promotedAt === undefined ? null : momentAt(signup.promotedAt, member(at, 'promotedAt'), now);
  const told = signup.told === true;
  return {
    addedBy,
    signedUpAt: signedUp?.toISOString() ?? null,
    promotedAt: promoted?.toISOString() ?? null,
    toldAt: told ? exportedAt.toISOString() : null
  };
}

function readSignups(value: Json | undefined, path: string, context: SignupContext): ImportPlan['sheets'][number]['signups'] {
  if (value === undefined) return [];
  const list = listAt(value, path, FILE_LIMITS.signups, 'sign-ups');
  if (context.signupsBefore + list.length > FILE_LIMITS.signups) wrong(path, p.tooMany(FILE_LIMITS.signups, 'sign-ups in the whole file'));
  const signups: ImportPlan['sheets'][number]['signups'] = [];
  const paths: string[] = [];
  for (const [index, each] of list.entries()) {
    const at = item(path, index);
    const signup = objectAt(each, at);
    onlyFields(signup, at, ['date', 'start', 'slot', 'person', 'note', 'status'], EXPORT_ONLY.signup);

    if (signup.date === undefined) wrong(member(at, 'date'), p.missing);
    const day = typeof signup.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(signup.date) ? parseDate(signup.date) : null;
    if (!day) wrong(member(at, 'date'), p.date);
    const sameDay = context.dates.map((date, d) => ({ date, d })).filter(({ date }) => date.onDate === day);
    if (sameDay.length === 0) wrong(member(at, 'date'), p.noSuchDate(formatDate(day)));
    let found: { date: DatePlan; d: number } | undefined;
    if (signup.start === undefined) {
      if (sameDay.length > 1) wrong(at, p.needsStart(day));
      found = sameDay[0];
    } else {
      if (signup.start !== null && typeof signup.start !== 'string') wrong(member(at, 'start'), p.timeOrNull);
      const start = signup.start === null ? null : timeField(signup.start, member(at, 'start'));
      found = sameDay.find(({ date }) => date.startsAt === start);
      if (!found) wrong(member(at, 'start'), p.noSuchDate(formatWhen(day, start)));
    }
    const { date, d } = found!;
    const when = dateWords(context.dates, date);

    if (signup.slot === undefined) wrong(member(at, 'slot'), p.missing);
    if (typeof signup.slot !== 'string') wrong(member(at, 'slot'), p.text);
    const label = checkText(signup.slot, { max: MAX_LENGTH.slotLabel, required: true, payment: 'none' });
    const s = label.ok ? date.slots.findIndex((slot) => slot.label === label.value) : -1;
    if (s < 0) throw new Refusal(words.import.unknownSlot(signup.slot, when), member(at, 'slot'));

    if (signup.person === undefined) wrong(member(at, 'person'), p.missing);
    if (typeof signup.person !== 'string') wrong(member(at, 'person'), p.text);
    const person = context.people.get(signup.person);
    if (!person) throw new Refusal(words.import.unknownPerson(signup.person), member(at, 'person'));
    if (signups.some((other) => other.date === d && other.slot === s && other.person === person.key)) {
      wrong(at, p.twice(person.key, date.slots[s]!.label, when));
    }

    const note = textField(signup, 'note', at, DIGITS(MAX_LENGTH.note));
    if (context.noteRequired && !note) wrong(member(at, 'note'), p.noteRequired(context.noteLabel));
    const status = choiceField(signup, 'status', at, ['confirmed', 'waiting'] as const, 'confirmed');
    signups.push({ date: d, slot: s, person: person.key, note, status, ...history(signup, at, context.exportedAt, context.now) });
    paths.push(at);
  }

  // Each place holds no more confirmed sign-ups than it has room for; on a date still ahead (and not cancelled) people
  // only wait for a full place, as they do in the app.
  for (const [d, date] of context.dates.entries()) {
    for (const [s, slot] of date.slots.entries()) {
      const here = signups.map((signup, index) => ({ signup, index })).filter(({ signup }) => signup.date === d && signup.slot === s);
      const confirmed = here.filter(({ signup }) => signup.status === 'confirmed').length;
      if (confirmed > slot.capacity) {
        throw new Refusal(words.import.overCapacity(slot.label, dateWords(context.dates, date), slot.capacity, confirmed), path);
      }
      const ahead = !date.cancelled && isOpenForClaims(date.onDate, date.startsAt, context.timezone, context.now);
      const waiting = here.find(({ signup }) => signup.status === 'waiting');
      if (ahead && waiting && confirmed < slot.capacity) {
        wrong(member(paths[waiting.index]!, 'status'), p.waitingWithRoom(slot.label, dateWords(context.dates, date)));
      }
    }
  }
  return signups;
}
