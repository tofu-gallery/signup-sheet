import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  capacityFrom,
  centsFrom,
  checkContact,
  checkName,
  checkNote,
  checkText,
  hasCardNumber,
  idFrom,
  isSlug
} from '../../src/lib/validation';

const ok = (value: string) => ({ ok: true, value });
const refused = (error: string) => ({ ok: false, error });

// Invisible characters are written as escapes, so the test reads the same in any editor.
const ZWSP = '\u200B';
const BOM = '\uFEFF';
const ZWJ = '\u200D';
const RLO = '\u202E';
const LRI = '\u2066';
const PDI = '\u2069';
const LINE_SEPARATOR = '\u2028';
const HANGUL_FILLER = '\u3164';
const BRAILLE_BLANK = '\u2800';
const COMBINING_ACUTE = '\u0301';
const FAMILY = `\u{1F468}${ZWJ}\u{1F469}${ZWJ}\u{1F467}`;

test('text is NFC-normalized and trimmed of space and invisible format characters at its ends', () => {
  assert.deepEqual(checkName(`  The Mike family${ZWSP} `), ok('The Mike family'));
  assert.deepEqual(checkName(`Mike's cafe${COMBINING_ACUTE}`), ok("Mike's caf\u00E9"));
  assert.deepEqual(checkName(`${BOM}Mike`), ok('Mike'));
  assert.deepEqual(checkName("Mike's\tteam"), ok("Mike's team"));
  assert.deepEqual(checkName(`Mike ${FAMILY}`), ok(`Mike ${FAMILY}`), 'a family emoji keeps its joiners');
});

test('bidi overrides and isolates, control characters and stray newlines are refused', () => {
  for (const bad of [`Mike${RLO}eil`, `Mike${LRI}x${PDI}`, 'a\u0000b', 'a\u0007b', 'a\u007Fb', 'a\u0085b', "Mike's\nteam", "Mike's\rteam", `a${LINE_SEPARATOR}b`]) {
    assert.deepEqual(checkName(bad), refused('invalid'), JSON.stringify(bad));
  }
  assert.deepEqual(checkText('Line one\r\nLine two', { max: 1000, multiline: true, payment: 'digits' }), ok('Line one\nLine two'));
  assert.deepEqual(checkText(`x${RLO}y`, { max: 1000, multiline: true, payment: 'digits' }), refused('invalid'));
});

test('a required text with nothing visible is refused; an optional one becomes empty', () => {
  for (const blank of ['', '   ', ZWSP + ZWSP, HANGUL_FILLER, `${BRAILLE_BLANK} `, COMBINING_ACUTE, '\u115F\u1160']) {
    assert.deepEqual(checkName(blank), refused('required'), JSON.stringify(blank));
  }
  assert.deepEqual(checkNote('  '), ok(''));
  assert.deepEqual(checkNote('', true), refused('required'));
});

test('lengths count characters, as the schema does', () => {
  assert.deepEqual(checkName('x'.repeat(80)), ok('x'.repeat(80)));
  assert.deepEqual(checkName('x'.repeat(81)), refused('too_long'));
  assert.equal(checkName('\u{1F600}'.repeat(80)).ok, true, 'an emoji is one character');
});

test('card and bank numbers are refused everywhere; a US phone number is a fine contact', () => {
  for (const card of ['4242 4242 4242 4242', '4242-4242-4242-4242', '4242424242424242', 'card 4242 4242 4242 4242 exp']) {
    assert.deepEqual(checkName(card), refused('card'), card);
    assert.deepEqual(checkNote(card), refused('card'), card);
    assert.deepEqual(checkContact(card), refused('card'), card);
  }
  for (const iban of ['DE89370400440532013000', 'GB29 NWBK 6016 1331 9268 19', 'NL91ABNA0417164300']) {
    assert.deepEqual(checkNote(`pay to ${iban}`), refused('card'), iban);
  }
  assert.deepEqual(checkNote('123456789012'), refused('card'), '12 digits');
  assert.deepEqual(checkNote('Call 415-555-0134 after 5'), ok('Call 415-555-0134 after 5'));
  for (const phone of ['+1 415 555 0134', '(415) 555-0134', '415.555.0134', 'mike@example.com', '+44 20 7946 0958']) {
    assert.deepEqual(checkContact(phone), ok(phone), phone);
  }
});

test('Luhn: a 13-19 digit run is checked whole; a longer run at every 13-19 digit stretch', () => {
  assert.equal(hasCardNumber('4111111111111111'), true);
  assert.equal(hasCardNumber('4111111111111112'), false, 'a 16-digit run that fails Luhn whole is not refused');
  assert.equal(hasCardNumber('4155550134 4111 1111 1111 1111'), true, 'a card joined to a phone number');
  assert.equal(hasCardNumber('Mike 415 555 0134, card 4111-1111-1111-1111'), true);
  assert.equal(hasCardNumber('14155550134'), false);
});

test('ids, slugs, capacities and money', () => {
  assert.equal(idFrom('42'), '42');
  for (const bad of ['0', '-1', '01', '1e3', '42x', '', '1234567890123456789']) assert.equal(idFrom(bad), null, bad);
  assert.equal(isSlug('snacks-2026'), true);
  for (const bad of ['-snacks', 'Snacks', 'snacks-', 'a'.repeat(41), 'sn_acks']) assert.equal(isSlug(bad), false, bad);
  assert.equal(capacityFrom('1'), 1);
  assert.equal(capacityFrom('500'), 500);
  for (const bad of ['0', '501', '1.5', '', 'x']) assert.equal(capacityFrom(bad), null, bad);
  assert.equal(centsFrom('40'), 4000);
  assert.equal(centsFrom('$40.50'), 4050);
  assert.equal(centsFrom(''), null);
  for (const bad of ['40.5', '-1', 'forty', '1000000']) assert.equal(centsFrom(bad), undefined, bad);
});
