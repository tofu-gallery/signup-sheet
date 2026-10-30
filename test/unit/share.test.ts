// Share texts and their links (share.ts): contacts as link addresses, %20 encoding, one number per text, bcc for a
// group email, only the allowed targets, this week's reminder word for word (T28) with "Taken" where names are hidden,
// and the waitlist messages. Pure functions on hand-made views.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bccLink, inviteText, isShareHref, personLinks, reachOf, shareLinks, waitlistMessages, weekText } from '../../src/lib/share';
import type { OrganizerSheet, OrganizerSignup, PublicSheet } from '../../src/lib/views';

const LINK = 'https://sign-up-sheet-ab12cd.trytofu.app/s/snacks';
// Thursday, Oct 29, 2026, noon in Los Angeles.
const NOW = new Date('2026-10-29T19:00:00Z');

test('a contact as a link address: US numbers get their country code, + numbers stay, emails stay, anything else none', () => {
  for (const phone of ['(415) 555-0134', '415-555-0134', '415.555.0134', '1 415 555 0134', '+1 415 555 0134']) {
    assert.deepEqual(reachOf(phone), { sms: '+14155550134', whatsapp: '14155550134', email: null }, phone);
  }
  assert.deepEqual(reachOf('+44 20 7946 0018'), { sms: '+442079460018', whatsapp: '442079460018', email: null });
  assert.deepEqual(reachOf(' hello@trytofu.ai '), { sms: null, whatsapp: null, email: 'hello@trytofu.ai' });
  for (const other of ['555-0134', 'call Mike at 415 555 0134', 'Mike', '', 'a@b', '+12']) {
    assert.deepEqual(reachOf(other), { sms: null, whatsapp: null, email: null }, other);
  }
});

test('links encode spaces as %20 (never +), mail line breaks as CRLF, and go only to WhatsApp, Messages, Mail or Google', () => {
  const text = { subject: 'Snack sign-up this week', text: "Mike's family: 1+1 places\nSign up: a&b=c?" };
  const links = shareLinks(text);
  assert.equal(links.whatsapp, "https://wa.me/?text=Mike's%20family%3A%201%2B1%20places%0ASign%20up%3A%20a%26b%3Dc%3F");
  assert.equal(links.sms, "sms:?&body=Mike's%20family%3A%201%2B1%20places%0ASign%20up%3A%20a%26b%3Dc%3F");
  assert.equal(links.email, "mailto:?subject=Snack%20sign-up%20this%20week&body=Mike's%20family%3A%201%2B1%20places%0D%0ASign%20up%3A%20a%26b%3Dc%3F");
  for (const href of Object.values(links)) {
    assert.ok(!href.includes('+'), href);
    assert.ok(isShareHref(href), href);
  }
  for (const bad of ['javascript:alert(1)', 'https://evil.example/', 'data:text/html,x', 'https://wa.me/?text=a b', 'mailto:"x"', ' sms:?&body=x']) {
    assert.equal(isShareHref(bad), false, bad);
  }
});

test('to one person: only the links their contact allows; to several by email: one mail with everyone in bcc', () => {
  const text = { subject: 'Snack sign-up: your new private link', text: 'Here it is' };
  assert.deepEqual(personLinks(text, '(415) 555-0134'), {
    whatsapp: 'https://wa.me/14155550134?text=Here%20it%20is',
    sms: 'sms:+14155550134?&body=Here%20it%20is',
    email: null
  });
  assert.deepEqual(personLinks(text, 'hello@trytofu.ai'), {
    whatsapp: null,
    sms: null,
    email: 'mailto:hello@trytofu.ai?subject=Snack%20sign-up%3A%20your%20new%20private%20link&body=Here%20it%20is'
  });
  assert.deepEqual(personLinks(text, ''), { whatsapp: null, sms: null, email: null }, 'no group link for a private message');
  assert.equal(
    bccLink(text, ['hello@trytofu.ai', '(415) 555-0134', 'frank@example.com', 'hello@trytofu.ai', '']),
    'mailto:?bcc=hello@trytofu.ai,frank@example.com&subject=Snack%20sign-up%3A%20your%20new%20private%20link&body=Here%20it%20is'
  );
  assert.equal(bccLink(text, ['(415) 555-0134']), null);
  assert.deepEqual(inviteText('Snack sign-up', LINK), {
    subject: 'Snack sign-up',
    text: `Snack sign-up: pick your date here ${LINK}\nNo account needed. Tap a date, type your name, and keep the link it gives you to change or cancel.`
  });
});

type PublicDate = PublicSheet['dates'][number];

function publicDate(id: string, onDate: string, startsAt: string | null, slots: [string, number, (string | null)[]][], cancelled = false): PublicDate {
  return {
    id,
    onDate,
    startsAt,
    endsAt: null,
    label: '',
    place: '',
    cancelled,
    slots: slots.map(([label, capacity, names], index) => ({
      id: `${id}${index}`,
      label,
      description: '',
      capacity,
      confirmed: names.length,
      waiting: 0,
      entries: names.map((name) => ({ name, note: 'never in the week text' }))
    }))
  };
}

function publicSheet(names: 'full' | 'taken'): PublicSheet {
  const name = (value: string) => (names === 'full' ? value : null);
  return {
    slug: 'snacks',
    title: 'Snack sign-up',
    description: '',
    timezone: 'America/Los_Angeles',
    place: '',
    names,
    status: 'open',
    listed: true,
    noteLabel: '',
    noteRequired: false,
    groupName: 'U9 Tigers',
    organizerName: 'Mike',
    dates: [
      publicDate('1', '2026-10-24', '09:00:00', [['Bring snacks', 1, [name("Mike's family")]]]),
      publicDate('2', '2026-10-31', '09:00:00', [
        ['Bring snacks', 1, [name("Mike's family")]],
        ['Drivers', 2, [name("Frank's family")]]
      ]),
      publicDate('3', '2026-11-01', null, [['Bring snacks', 1, []]], true),
      publicDate('4', '2026-11-02', null, [['Bring snacks', 1, []]]),
      publicDate('5', '2026-11-04', '18:00:00', [['Bring snacks', 1, []]]),
      publicDate('6', '2026-11-05', '18:00:00', [['Bring snacks', 1, []]])
    ]
  };
}

test("T28: this week's reminder, word for word: today and the 6 days after, cancelled dates left out, \"Taken\" where names are hidden", () => {
  assert.deepEqual(weekText(publicSheet('full'), LINK, NOW), {
    subject: 'Snack sign-up this week',
    text: [
      'U9 Tigers: Snack sign-up, this week',
      "Sat, Oct 31, 9:00 AM: Bring snacks: Mike's family",
      "Sat, Oct 31, 9:00 AM: Drivers: Frank's family; 1 place open",
      'Mon, Nov 2: Bring snacks: 1 place open',
      'Wed, Nov 4, 6:00 PM: Bring snacks: 1 place open',
      `Sign up or change: ${LINK}`
    ].join('\n')
  });
  const taken = weekText(publicSheet('taken'), LINK, NOW)!;
  assert.deepEqual(taken.text.split('\n').slice(1, 3), ['Sat, Oct 31, 9:00 AM: Bring snacks: Taken', 'Sat, Oct 31, 9:00 AM: Drivers: 1 taken; 1 place open']);
  assert.ok(!/Mike|Frank|never in/.test(taken.text));
  assert.ok(shareLinks(taken).sms.includes('%20') && !shareLinks(taken).sms.includes('+'), 'MD16: %20 and no +');
  assert.equal(weekText(publicSheet('full'), LINK, new Date('2026-12-01T19:00:00Z')), null, 'nothing in the next 7 days');
  assert.equal(weekText({ ...publicSheet('full'), groupName: '' }, LINK, NOW)!.text.split('\n')[0], 'Snack sign-up, this week');
});

function waiting(id: string, name: string, contact: string, position: number): OrganizerSignup {
  return {
    id,
    personId: `p${id}`,
    name,
    contact,
    hasLink: false,
    paid: null,
    status: 'waiting',
    position,
    note: '',
    addedBy: 'member',
    signedUpAt: new Date('2026-10-20T10:00:00Z'),
    promotedAt: null,
    changedAt: null,
    toldAt: null,
    placesOnSheet: 1
  };
}

test('the waitlist messages: each person with their number and other dates with room, and one for everyone', () => {
  const date = (id: string, onDate: string, confirmed: number, signups: OrganizerSignup[], cancelled = false) => ({
    id,
    onDate,
    startsAt: '09:00:00',
    endsAt: null,
    label: '',
    place: '',
    cancelled,
    slots: [{ id: `s${id}`, label: 'Bring snacks', description: '', capacity: 1, confirmed, waiting: signups.length, signups }]
  });
  const sheet: OrganizerSheet = {
    id: '1',
    slug: 'snacks',
    title: 'Snack sign-up',
    description: '',
    timezone: 'America/Los_Angeles',
    place: '',
    names: 'full',
    status: 'open',
    listed: true,
    noteLabel: '',
    noteRequired: false,
    groupName: 'U9 Tigers',
    duesLabel: '',
    dates: [
      date('1', '2026-10-24', 1, [waiting('9', 'Past', '', 1)]),
      date('2', '2026-11-07', 1, [waiting('10', "Frank's family", '(415) 555-0134', 1), waiting('11', 'Second', 'hello@trytofu.ai', 2)]),
      date('3', '2026-11-14', 0, []),
      date('4', '2026-11-21', 0, [], true),
      date('5', '2026-11-28', 0, [])
    ]
  };
  const { all, each } = waitlistMessages(sheet, LINK, NOW);
  assert.deepEqual(
    each.map((message) => [message.signupId, message.contact]),
    [
      ['10', '(415) 555-0134'],
      ['11', 'hello@trytofu.ai']
    ]
  );
  assert.equal(
    each[0]!.text.text,
    `Hi Frank's family, you're #1 on the waitlist for Bring snacks on Sat, Nov 7 (Snack sign-up). If a place opens, you move up automatically and I'll let you know. These dates still have room: Sat, Nov 14; Sat, Nov 28. The sheet: ${LINK}`
  );
  assert.ok(each[1]!.text.text.includes("you're #2 on the waitlist"));
  assert.deepEqual(all, {
    subject: 'Snack sign-up: the waitlist',
    text: `Hi everyone on the waitlist for Snack sign-up: if a place opens, you move up automatically and I'll let you know. The sheet: ${LINK}`
  });
  assert.equal(bccLink(all!, each.map((message) => message.contact)), `mailto:?bcc=hello@trytofu.ai&subject=Snack%20sign-up%3A%20the%20waitlist&body=${encodeURIComponent(all!.text)}`);
});
