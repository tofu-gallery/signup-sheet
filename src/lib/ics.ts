// Calendar files (see TOFU.md, Calendar files): a person's own sign-ups, and the organizer's weekly reminder.
//
// RFC 5545: CRLF line ends, lines folded at 75 octets of UTF-8 (never inside a character), TEXT values escaped. Timed
// events are written in UTC, worked out from the sheet's time zone, so no VTIMEZONE is needed; a date with no time is an
// all-day event. Each event's UID is its sign-up's, so a file downloaded again replaces the event instead of adding one;
// its SEQUENCE counts the seconds from the sign-up's creation to the latest change of anything the event shows (the
// revised_at columns), so it grows exactly when the event changes. A date the organizer cancelled is sent as the same
// event with STATUS:CANCELLED and no alarms, so a calendar that takes the file again removes or strikes it.
//
// The file asks for alarms (the day before, and 2 hours before a timed event); the calendar app decides whether and
// how they show, which no file can prove. A person's own file carries their own private link on purpose, labelled as
// theirs: it is the main way back to a lost link, and a calendar they share carries it too (TOFU.md says so). It never
// carries anyone else's link, contact or paid state.
import { words } from '../words';
import { addDays, weekdayIndex, zonedToUtc } from './time';

/** One of the person's own confirmed sign-ups, as views.ts myCalendar reads it, with the links to put in it. */
export type SignupEvent = {
  signupId: string;
  note: string;
  slotLabel: string;
  slotDescription: string;
  onDate: string;
  startsAt: string | null;
  endsAt: string | null;
  dateLabel: string;
  /** The date's place, else the sheet's. */
  place: string;
  cancelled: boolean;
  sheetTitle: string;
  sheetTimezone: string;
  personName: string;
  groupName: string;
  organizerName: string;
  organizerContact: string;
  sequence: number;
  revisedAt: Date;
};

export type EventLinks = {
  /** This copy's host, for the UID. */
  host: string;
  /** The person's own private link (absolute). */
  privateLink: string;
  /** The sheet's public address (absolute). */
  sheetLink: string;
};

const CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

/** A TEXT value: backslash, semicolon, comma and line breaks escaped; other control characters dropped. */
export function icsText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(CONTROLS, '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

/** One content line folded at 75 octets: continuation lines start with a space. A character is never split. */
export function foldLine(line: string): string {
  const parts: string[] = [];
  let part = '';
  let size = 0;
  let max = 75;
  for (const char of line) {
    const bytes = Buffer.byteLength(char, 'utf8');
    if (size + bytes > max) {
      parts.push(part);
      part = '';
      size = 0;
      max = 74;
    }
    part += char;
    size += bytes;
  }
  parts.push(part);
  return parts.join('\r\n ');
}

/** A whole calendar file around its events' lines. */
export function calendarFile(eventLines: readonly string[]): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Tofu//Sign-up sheet 1//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', ...eventLines, 'END:VCALENDAR'];
  return lines.map((line) => `${foldLine(line)}\r\n`).join('');
}

/** '20261107T170000Z'. */
export function utcStamp(instant: Date): string {
  return instant.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** '20261107'. */
function dateStamp(date: string): string {
  return date.replace(/-/g, '');
}

/** When the event starts and ends: UTC instants for a timed one (an hour long without an end time), else all-day. */
export function eventTimes(event: Pick<SignupEvent, 'onDate' | 'startsAt' | 'endsAt' | 'sheetTimezone'>):
  | { allDay: false; start: Date; end: Date }
  | { allDay: true; start: string; end: string } {
  if (!event.startsAt) return { allDay: true, start: event.onDate, end: addDays(event.onDate, 1) };
  const start = zonedToUtc(event.onDate, event.startsAt, event.sheetTimezone);
  const end = event.endsAt ? zonedToUtc(event.onDate, event.endsAt, event.sheetTimezone) : new Date(start.getTime() + 60 * 60 * 1000);
  return { allDay: false, start, end };
}

export function eventSummary(event: Pick<SignupEvent, 'slotLabel' | 'groupName' | 'sheetTitle' | 'cancelled'>): string {
  const summary = words.ics.summary(event.slotLabel, event.groupName || event.sheetTitle);
  return event.cancelled ? words.ics.cancelledSummary(summary) : summary;
}

/** The event's description, line by line (also the Google Calendar link's details). */
export function eventDescription(event: SignupEvent, links: EventLinks): string {
  const w = words.ics;
  return [
    event.cancelled ? w.cancelledLine : '',
    w.signedUpAs(event.personName),
    event.dateLabel,
    event.slotDescription,
    event.note ? w.yourNote(event.note) : '',
    w.privateLink(links.privateLink),
    words.member.accessCode,
    w.sheetLink(links.sheetLink),
    event.organizerName ? w.questions(event.organizerName, event.organizerContact) : ''
  ]
    .filter(Boolean)
    .join('\n');
}

/** One sign-up's VEVENT. `now` is the file's DTSTAMP (when it was made, as METHOD:PUBLISH has it). */
export function signupEventLines(event: SignupEvent, links: EventLinks, now: Date): string[] {
  const times = eventTimes(event);
  const summary = eventSummary(event);
  const lines = [
    'BEGIN:VEVENT',
    `UID:signup-${event.signupId}@${links.host}`,
    `DTSTAMP:${utcStamp(now)}`,
    `LAST-MODIFIED:${utcStamp(event.revisedAt)}`,
    `SEQUENCE:${Math.max(0, event.sequence)}`,
    times.allDay ? `DTSTART;VALUE=DATE:${dateStamp(times.start)}` : `DTSTART:${utcStamp(times.start)}`,
    times.allDay ? `DTEND;VALUE=DATE:${dateStamp(times.end)}` : `DTEND:${utcStamp(times.end)}`,
    `SUMMARY:${icsText(summary)}`,
    ...(event.place ? [`LOCATION:${icsText(event.place)}`] : []),
    `DESCRIPTION:${icsText(eventDescription(event, links))}`,
    `STATUS:${event.cancelled ? 'CANCELLED' : 'CONFIRMED'}`
  ];
  if (!event.cancelled) {
    // An all-day event starts at midnight: 15 hours before is 9 AM the day before.
    const alarms = times.allDay
      ? [{ trigger: '-PT15H', text: words.ics.alarmTomorrow(summary) }]
      : [
          { trigger: '-P1D', text: words.ics.alarmTomorrow(summary) },
          { trigger: '-PT2H', text: words.ics.alarmSoon(summary) }
        ];
    for (const alarm of alarms) {
      lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(alarm.text)}`, `TRIGGER:${alarm.trigger}`, 'END:VALARM');
    }
  }
  lines.push('END:VEVENT');
  return lines;
}

/** The person's calendar file for these sign-ups. */
export function personCalendar<E extends SignupEvent>(events: readonly E[], links: (event: E) => EventLinks, now: Date): string {
  return calendarFile(events.flatMap((event) => signupEventLines(event, links(event), now)));
}

/**
 * "Add to Google Calendar" for a confirmed sign-up: Google's own event form, filled in. It uses the person's usual
 * Google alerts (a link can't ask for any). Null for a cancelled date, which gets no button.
 */
export function googleCalendarUrl(event: SignupEvent, links: EventLinks): string | null {
  if (event.cancelled) return null;
  const times = eventTimes(event);
  const dates = times.allDay ? `${dateStamp(times.start)}/${dateStamp(times.end)}` : `${utcStamp(times.start)}/${utcStamp(times.end)}`;
  const query = [
    ['action', 'TEMPLATE'],
    ['text', eventSummary(event)],
    ['dates', dates],
    ['details', eventDescription(event, links)],
    ...(event.place ? [['location', event.place]] : [])
  ];
  return `https://calendar.google.com/calendar/render?${query.map(([name, value]) => `${name}=${encodeURIComponent(value!)}`).join('&')}`;
}

/** Weekdays as RRULE writes them, Sunday first, and as the reminder's `day` names them. */
const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;
export const REMINDER_DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type ReminderDay = (typeof REMINDER_DAYS)[number];

/**
 * The organizer's weekly reminder to send the week's message: a repeating event at `time` on `day`, in floating local
 * time (the phone's own clock, so it stays at 6 PM through daylight-saving changes), from the first such day on or
 * after `today` until the day after the last upcoming date. Its UID names the day and time, so choosing another makes
 * another event. Its SEQUENCE is the reminder revision (views.ts reminderSeason), which grows with every write that can
 * move the last date and never goes back, so the file taken after a change replaces the earlier one in a calendar,
 * whether the season grew or shrank, and downloading it again changes nothing.
 */
export function reminderCalendar(input: {
  day: ReminderDay;
  /** 'HH:MM'. */
  time: string;
  today: string;
  lastDate: string;
  /** The reminder revision when the file is made. */
  sequence: number;
  host: string;
  organizerLink: string;
  now: Date;
}): string {
  const target = REMINDER_DAYS.indexOf(input.day);
  const first = addDays(input.today, (target - weekdayIndex(input.today) + 7) % 7);
  const hhmm = input.time.replace(':', '');
  const floating = (date: string, time: string) => `${dateStamp(date)}T${time}00`;
  const end = (() => {
    const minutes = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(2)) + 15;
    return minutes >= 24 * 60 ? '235900' : `${String(Math.floor(minutes / 60)).padStart(2, '0')}${String(minutes % 60).padStart(2, '0')}00`;
  })();
  return calendarFile([
    'BEGIN:VEVENT',
    `UID:organizer-reminder-${input.day}-${hhmm}@${input.host}`,
    `DTSTAMP:${utcStamp(input.now)}`,
    `SEQUENCE:${Math.max(0, Math.floor(input.sequence))}`,
    `DTSTART:${floating(first, hhmm)}`,
    `DTEND:${dateStamp(first)}T${end}`,
    `RRULE:FREQ=WEEKLY;BYDAY=${BYDAY[target]};UNTIL=${floating(addDays(input.lastDate, 1), '0000')}`,
    `SUMMARY:${icsText(words.ics.reminderSummary)}`,
    `DESCRIPTION:${icsText(words.ics.reminderDescription(input.organizerLink))}`,
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${icsText(words.ics.reminderSummary)}`,
    'TRIGGER:PT0S',
    'END:VALARM',
    'END:VEVENT'
  ]);
}

/** The attachment name of one sign-up's file: '<slug>-<date>.ics'. */
export function eventFileName(slug: string, onDate: string): string {
  return `${slug}-${onDate}.ics`;
}
