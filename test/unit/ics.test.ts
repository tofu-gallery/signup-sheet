// Calendar files (ics.ts): RFC 5545 lines, folding at 75 octets, escaping, UTC times across a daylight-saving change,
// all-day events, alarms, a cancelled date, the Google link and the organizer's weekly reminder. Pure functions.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type EventLinks,
  foldLine,
  googleCalendarUrl,
  icsText,
  personCalendar,
  reminderCalendar,
  type SignupEvent
} from '../../src/lib/ics';
import { isShareHref } from '../../src/lib/share';

const TOKEN = 'A'.repeat(43);
const LINKS: EventLinks = {
  host: 'sign-up-sheet-ab12cd.trytofu.app',
  privateLink: `https://sign-up-sheet-ab12cd.trytofu.app/me/${TOKEN}`,
  sheetLink: 'https://sign-up-sheet-ab12cd.trytofu.app/s/snacks'
};
const NOW = new Date('2026-10-29T19:00:00Z');

function event(change: Partial<SignupEvent> = {}): SignupEvent {
  return {
    signupId: '42',
    note: 'Oranges, apples; water',
    slotLabel: 'Bring snacks',
    slotDescription: '',
    onDate: '2026-11-07',
    startsAt: '09:00:00',
    endsAt: '10:30:00',
    dateLabel: 'vs Eagles',
    place: 'Lincoln Park, Field 3',
    cancelled: false,
    sheetTitle: 'Snack sign-up',
    sheetTimezone: 'America/Los_Angeles',
    personName: "Mike's family",
    groupName: 'U9 Tigers',
    organizerName: 'Mike',
    organizerContact: 'hello@trytofu.ai',
    sequence: 7,
    revisedAt: new Date('2026-10-28T10:00:00Z'),
    ...change
  };
}

const unfold = (text: string) => text.replace(/\r\n /g, '');
const calendar = (events: SignupEvent[]) => personCalendar(events, () => LINKS, NOW);

function assertWellFormed(text: string): void {
  assert.ok(text.endsWith('\r\n'));
  assert.ok(!/[^\r]\n/.test(text), 'every line ends with CRLF');
  for (const line of text.split('\r\n')) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `a line of ${Buffer.byteLength(line, 'utf8')} octets`);
    assert.ok(!/[\uD800-\uDFFF]/u.test(line), 'no character split between lines');
  }
}

test('T27: a timed event in Los Angeles is written in UTC on both sides of the daylight-saving change, with two alarms', () => {
  const text = calendar([event()]);
  assertWellFormed(text);
  const lines = unfold(text).split('\r\n');
  for (const line of [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Tofu//Sign-up sheet 1//EN',
    'METHOD:PUBLISH',
    'UID:signup-42@sign-up-sheet-ab12cd.trytofu.app',
    'DTSTAMP:20261029T190000Z',
    'LAST-MODIFIED:20261028T100000Z',
    'SEQUENCE:7',
    'DTSTART:20261107T170000Z',
    'DTEND:20261107T183000Z',
    'SUMMARY:Bring snacks · U9 Tigers',
    'LOCATION:Lincoln Park\\, Field 3',
    'STATUS:CONFIRMED',
    'TRIGGER:-P1D',
    'TRIGGER:-PT2H',
    'DESCRIPTION:Tomorrow: Bring snacks · U9 Tigers'
  ]) {
    assert.ok(lines.includes(line), line);
  }
  assert.equal(lines.filter((line) => line === 'BEGIN:VALARM').length, 2);
  const description = lines.find((line) => line.startsWith('DESCRIPTION:You signed up'))!;
  assert.equal(
    description,
    `DESCRIPTION:You signed up as Mike's family.\\nvs Eagles\\nYour note: Oranges\\, apples\\; water\\nChange or cancel (your private link\\, keep it to yourself): ${LINKS.privateLink}\\nIf a page asks for an access code first\\, enter it\\, then open this link again.\\nSign-up sheet: ${LINKS.sheetLink}\\nQuestions: Mike\\, hello@trytofu.ai`
  );
  // Before the change (2026-11-01), 9 AM in Los Angeles is 16:00 UTC.
  assert.ok(unfold(calendar([event({ onDate: '2026-10-31' })])).includes('DTSTART:20261031T160000Z\r\n'));
  // No end time: an hour.
  assert.ok(unfold(calendar([event({ endsAt: null })])).includes('DTEND:20261107T180000Z\r\n'));
});

test('a date with no time is an all-day event with one alarm at 9 AM the day before', () => {
  const lines = unfold(calendar([event({ startsAt: null, endsAt: null })])).split('\r\n');
  assert.ok(lines.includes('DTSTART;VALUE=DATE:20261107'));
  assert.ok(lines.includes('DTEND;VALUE=DATE:20261108'));
  assert.deepEqual(lines.filter((line) => line.startsWith('TRIGGER:')), ['TRIGGER:-PT15H']);
});

test('a cancelled date is the same event marked cancelled, without alarms, and gets no Google link', () => {
  const ev = event({ cancelled: true });
  const lines = unfold(calendar([ev])).split('\r\n');
  assert.ok(lines.includes('STATUS:CANCELLED'));
  assert.ok(lines.includes('UID:signup-42@sign-up-sheet-ab12cd.trytofu.app'), 'the same UID replaces the event');
  assert.ok(lines.includes('SUMMARY:Cancelled: Bring snacks · U9 Tigers'));
  assert.ok(!lines.includes('BEGIN:VALARM'));
  assert.equal(googleCalendarUrl(ev, LINKS), null);
});

test('TEXT values are escaped, and long lines fold at 75 octets without splitting a character', () => {
  assert.equal(icsText('a\\b;c,d\ne\r\nf\rg\u0007'), 'a\\\\b\\;c\\,d\\ne\\nf\\ng');
  const long = `DESCRIPTION:${'家🍊é'.repeat(60)}`;
  const folded = foldLine(long);
  assertWellFormed(`${folded}\r\n`);
  assert.equal(folded.replace(/\r\n /g, ''), long);
  assert.ok(folded.split('\r\n').length > 3);
  assert.equal(foldLine('x'.repeat(75)), 'x'.repeat(75));
  assert.equal(foldLine('x'.repeat(76)), `${'x'.repeat(75)}\r\n x`);
  // A whole file with multibyte words everywhere stays within the limit.
  assertWellFormed(calendar([event({ note: '🍊'.repeat(50), place: '学校'.repeat(30), personName: 'Ñandú family' })]));
});

test('the Google Calendar link: Google\'s event form, every value encoded (%20, never +), all-day as dates', () => {
  const url = googleCalendarUrl(event(), LINKS)!;
  assert.ok(url.startsWith('https://calendar.google.com/calendar/render?action=TEMPLATE&text=Bring%20snacks%20%C2%B7%20U9%20Tigers&'));
  assert.ok(url.includes('&dates=20261107T170000Z%2F20261107T183000Z&'));
  assert.ok(url.includes('&location=Lincoln%20Park%2C%20Field%203'));
  assert.ok(!url.includes('+'));
  assert.ok(isShareHref(url));
  const details = decodeURIComponent(/&details=([^&]*)/.exec(url)![1]!);
  assert.ok(details.includes(`Change or cancel (your private link, keep it to yourself): ${LINKS.privateLink}`));
  assert.ok(googleCalendarUrl(event({ startsAt: null, endsAt: null }), LINKS)!.includes('&dates=20261107%2F20261108&'));
});

test("the organizer's weekly reminder: floating local time, until the day after the last date, one event per day and time", () => {
  const text = reminderCalendar({
    day: 'thu',
    time: '18:00',
    today: '2026-10-29',
    lastDate: '2026-12-19',
    sequence: 41,
    host: 'sign-up-sheet-ab12cd.trytofu.app',
    organizerLink: 'https://sign-up-sheet-ab12cd.trytofu.app/organizer',
    now: NOW
  });
  assertWellFormed(text);
  const lines = unfold(text).split('\r\n');
  for (const line of [
    'UID:organizer-reminder-thu-1800@sign-up-sheet-ab12cd.trytofu.app',
    'SEQUENCE:41',
    'DTSTART:20261029T180000',
    'DTEND:20261029T181500',
    'RRULE:FREQ=WEEKLY;BYDAY=TH;UNTIL=20261220T000000',
    "SUMMARY:Send this week's sign-up reminder",
    'TRIGGER:PT0S'
  ]) {
    assert.ok(lines.includes(line), line);
  }
  // From a Friday, the first Thursday is the next week's. The SEQUENCE is the revision it is given, not the last date:
  // a shorter season made later (a higher revision) reads as the newer version of the same event.
  const shorter = unfold(reminderCalendar({ day: 'thu', time: '18:00', today: '2026-10-30', lastDate: '2026-11-21', sequence: 42, host: 'h.example', organizerLink: 'https://h.example/organizer', now: NOW }));
  assert.ok(shorter.includes('DTSTART:20261105T180000\r\n'));
  assert.ok(shorter.includes('RRULE:FREQ=WEEKLY;BYDAY=TH;UNTIL=20261122T000000\r\n'));
  assert.ok(shorter.includes('\r\nSEQUENCE:42\r\n'));
});
