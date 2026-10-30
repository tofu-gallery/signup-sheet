// Dates and times (see TOFU.md, Time). A date's day, start and end are civil values in its sheet's time zone, stored and
// shown as they are, with no conversion: 'Sat, Nov 7 · 9:00 AM–10:30 AM'. Only deadlines and calendar files need an
// instant, which zonedToUtc works out from Intl's offsets.
import { words } from '../words';

export const TIME_ZONE_CHOICES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu'
] as const;

const DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
const TIME = /^([01][0-9]|2[0-3]):([0-5][0-9])(?::[0-5][0-9])?$/;

const formats = new Map<string, Intl.DateTimeFormat>();

function wallClock(timeZone: string): Intl.DateTimeFormat {
  let format = formats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    formats.set(timeZone, format);
  }
  return format;
}

export function isTimeZone(name: string): boolean {
  if (!name || name.length > 64) return false;
  try {
    wallClock(name);
    return true;
  } catch {
    return false;
  }
}

/** A 'YYYY-MM-DD' that names a real day, else null. */
export function parseDate(text: string): string | null {
  const match = DATE.exec(text.trim());
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? `${match[1]}-${match[2]}-${match[3]}`
    : null;
}

/** A 24-hour 'HH:MM' (seconds, as PostgreSQL returns a time, are dropped), else null. */
export function parseTime(text: string): string | null {
  const match = TIME.exec(text.trim());
  return match ? `${match[1]}:${match[2]}` : null;
}

function civilParts(date: string): [number, number, number] {
  const valid = parseDate(date);
  if (!valid) throw new Error('not a YYYY-MM-DD date');
  return [Number(valid.slice(0, 4)), Number(valid.slice(5, 7)), Number(valid.slice(8, 10))];
}

/** The wall-clock fields at an instant in a time zone. */
function wallAt(timeZone: string, instant: number): number {
  const fields: Record<string, number> = {};
  for (const part of wallClock(timeZone).formatToParts(new Date(instant))) {
    if (part.type !== 'literal') fields[part.type] = Number(part.value);
  }
  return Date.UTC(fields.year!, fields.month! - 1, fields.day!, fields.hour!, fields.minute!, fields.second!);
}

/**
 * The instant a civil date and time in a time zone names. Two passes over Intl's offsets, so it is right on both sides
 * of a daylight-saving change. A time that a spring change skips (2:30 AM) lands an hour off; one a fall change repeats
 * takes its first occurrence.
 */
export function zonedToUtc(date: string, time: string, timeZone: string): Date {
  const [year, month, day] = civilParts(date);
  const hm = parseTime(time);
  if (!hm) throw new Error('not an HH:MM time');
  const wall = Date.UTC(year, month - 1, day, Number(hm.slice(0, 2)), Number(hm.slice(3, 5)));
  const roundSecond = (ms: number) => ms - (((ms % 1000) + 1000) % 1000);
  const offsetAt = (instant: number) => wallAt(timeZone, instant) - roundSecond(instant);
  const guess = wall - offsetAt(wall);
  return new Date(wall - offsetAt(guess));
}

/** Today's date ('YYYY-MM-DD') in a time zone. */
export function civilToday(timeZone: string, now: Date = new Date()): string {
  return new Date(wallAt(timeZone, now.getTime())).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const [year, month, day] = civilParts(date);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** 0 for Sunday … 6 for Saturday. */
export function weekdayIndex(date: string): number {
  const [year, month, day] = civilParts(date);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/**
 * When a date stops taking claims and moves: at its start time in the sheet's time zone, or at 23:59 for a date with
 * no start time. A cancel after this moment moves nobody up.
 */
export function closesAt(date: string, startsAt: string | null, timeZone: string): Date {
  return zonedToUtc(date, startsAt ?? '23:59', timeZone);
}

export function isOpenForClaims(date: string, startsAt: string | null, timeZone: string, now: Date = new Date()): boolean {
  return now.getTime() < closesAt(date, startsAt, timeZone).getTime();
}

/** 'Sat, Nov 7'. */
export function formatDate(date: string): string {
  const [, month, day] = civilParts(date);
  return `${words.calendar.weekdaysShort[weekdayIndex(date)]}, ${words.calendar.monthsShort[month - 1]} ${day}`;
}

/** 'Nov 7'. */
export function formatMonthDay(date: string): string {
  const [, month, day] = civilParts(date);
  return `${words.calendar.monthsShort[month - 1]} ${day}`;
}

/** 'Sat, Nov 7, 9:00 AM', or 'Sat, Nov 7' for a date with no start time. */
export function formatWhen(date: string, startsAt: string | null): string {
  return startsAt ? `${formatDate(date)}, ${formatTime(startsAt)}` : formatDate(date);
}

/** How a sentence names one of a sheet's dates: 'Sat, Nov 7', with its time when the sheet has another date that day. */
export function dateWords(
  dates: readonly { onDate: string; startsAt: string | null }[],
  date: { onDate: string; startsAt: string | null }
): string {
  return dates.filter((other) => other.onDate === date.onDate).length > 1 ? formatWhen(date.onDate, date.startsAt) : formatDate(date.onDate);
}

/** The day of the week a word names ('Sat', 'saturday'; 0 for Sunday … 6 for Saturday), or null. */
export function weekdayFrom(text: string): number | null {
  const word = text.trim().toLowerCase();
  for (let index = 0; index < 7; index += 1) {
    if (word === words.calendar.weekdaysShort[index]!.toLowerCase() || word === words.calendar.weekdaysLong[index]!.toLowerCase()) return index;
  }
  return null;
}

/** The time zone a moment is shown in when nothing else says which (the schema's default for a sheet). */
export const DEFAULT_TIME_ZONE = 'America/New_York';

/** A moment as its time zone's wall clock shows it: 'Oct 29, 7:05 PM'. */
export function formatMoment(instant: Date, timeZone: string): string {
  const wall = new Date(wallAt(timeZone, instant.getTime())).toISOString();
  return `${formatMonthDay(wall.slice(0, 10))}, ${formatTime(wall.slice(11, 16))}`;
}

/** A moment's day in a time zone, as 'Sat, Nov 7'. */
export function formatMomentDate(instant: Date, timeZone: string): string {
  return formatDate(civilToday(timeZone, instant));
}

/** '9:00 AM' (with a plain space, unlike some Intl versions). */
export function formatTime(time: string): string {
  const hm = parseTime(time);
  if (!hm) throw new Error('not an HH:MM time');
  const hour = Number(hm.slice(0, 2));
  return `${hour % 12 === 0 ? 12 : hour % 12}:${hm.slice(3, 5)} ${hour < 12 ? 'AM' : 'PM'}`;
}

/** '9:00 AM–10:30 AM', '9:00 AM', or '' for a date with no start time. */
export function formatTimes(startsAt: string | null, endsAt: string | null): string {
  if (!startsAt) return '';
  return endsAt ? `${formatTime(startsAt)}–${formatTime(endsAt)}` : formatTime(startsAt);
}
