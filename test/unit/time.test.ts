import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addDays,
  civilToday,
  closesAt,
  formatDate,
  formatTime,
  formatTimes,
  isOpenForClaims,
  isTimeZone,
  parseDate,
  parseTime,
  TIME_ZONE_CHOICES,
  weekdayIndex,
  zonedToUtc
} from '../../src/lib/time';

const LA = 'America/Los_Angeles';

test('09:00 in Los Angeles is 16:00Z before the 2026-11-01 change and 17:00Z after', () => {
  assert.equal(zonedToUtc('2026-10-31', '09:00', LA).toISOString(), '2026-10-31T16:00:00.000Z');
  assert.equal(zonedToUtc('2026-11-07', '09:00', LA).toISOString(), '2026-11-07T17:00:00.000Z');
  assert.equal(zonedToUtc('2026-11-01', '00:30', LA).toISOString(), '2026-11-01T07:30:00.000Z');
  assert.equal(zonedToUtc('2026-07-04', '18:00', 'America/New_York').toISOString(), '2026-07-04T22:00:00.000Z');
  assert.equal(zonedToUtc('2026-12-24', '23:59', 'Pacific/Honolulu').toISOString(), '2026-12-25T09:59:00.000Z');
});

test("today in a time zone, around its midnight", () => {
  const instant = new Date('2026-11-08T07:30:00Z');
  assert.equal(civilToday(LA, instant), '2026-11-07');
  assert.equal(civilToday('America/New_York', instant), '2026-11-08');
  assert.equal(civilToday(LA, new Date('2026-11-08T08:00:00Z')), '2026-11-08');
});

test('a date takes claims until its start, or until 23:59 when it has none', () => {
  assert.equal(closesAt('2026-11-07', '09:00:00', LA).toISOString(), '2026-11-07T17:00:00.000Z');
  assert.equal(isOpenForClaims('2026-11-07', '09:00:00', LA, new Date('2026-11-07T16:59:59Z')), true);
  assert.equal(isOpenForClaims('2026-11-07', '09:00:00', LA, new Date('2026-11-07T17:00:00Z')), false);
  assert.equal(closesAt('2026-11-07', null, LA).toISOString(), '2026-11-08T07:59:00.000Z');
});

test('weekdays and the soccer season (Saturdays Nov 14 to Dec 26, 2026)', () => {
  for (const saturday of ['2026-11-14', '2026-11-21', '2026-11-28', '2026-12-26']) assert.equal(weekdayIndex(saturday), 6, saturday);
  assert.equal(weekdayIndex('2026-11-08'), 0);
  assert.equal(weekdayIndex('2026-11-01'), 0);
  assert.equal(addDays('2026-12-26', 7), '2027-01-02');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
});

test('dates and times are shown as stored, with plain spaces', () => {
  assert.equal(formatDate('2026-11-07'), 'Sat, Nov 7');
  assert.equal(formatTime('09:00:00'), '9:00 AM');
  assert.equal(formatTime('00:05'), '12:05 AM');
  assert.equal(formatTime('12:30'), '12:30 PM');
  assert.equal(formatTimes('09:00:00', '10:30:00'), '9:00 AM–10:30 AM');
  assert.equal(formatTimes(null, null), '');
});

test('parsing refuses days and times that do not exist', () => {
  assert.equal(parseDate('2026-02-29'), null);
  assert.equal(parseDate('2028-02-29'), '2028-02-29');
  assert.equal(parseDate('2026-1-7'), null);
  assert.equal(parseTime('24:00'), null);
  assert.equal(parseTime('9:00'), null);
  assert.equal(parseTime('18:00'), '18:00');
});

test('time zones: the offered ones exist, typos do not', () => {
  for (const zone of TIME_ZONE_CHOICES) assert.equal(isTimeZone(zone), true, zone);
  assert.equal(isTimeZone('America/LosAngeles'), false);
  assert.equal(isTimeZone(''), false);
});
