// Ready-made messages and the links that send them (see TOFU.md, Share texts).
//
// Every text is in words.ts; this fills them in and makes the links people tap. A link's text is encoded with
// encodeURIComponent, so a space is %20 and never + (iPhone Messages and Mail show a + as it is). A text message or a
// WhatsApp link goes to at most one number: several people get one link each, never a group text. One email to several
// people puts them all in bcc, so nobody sees anyone else's address. A link may only lead to WhatsApp, Messages, Mail or
// Google Calendar's event form (SHARE_TARGETS).
//
// What the group sees (the invite, this week's reminder, the message to everyone waiting) is made from the public sheet
// only (views.ts publicSheetView): names, or "Taken" on a sheet that hides them, and counts. It never carries a contact,
// a paid state, dues or a private link. A text with a private link goes to its own person only, by personLinks, which
// has no link to a group: the organizer's new or first link, the link of someone signed up from another person's phone,
// and "Send it to myself" to the person's own saved contact when it reads only one way (an email address, or a number
// with its country code); else "Send it to myself" opens Messages or Mail addressed to nobody, never WhatsApp's chat
// list or the share sheet (pages/member.ts).
import { words } from '../words';
import { addDays, civilToday, dateWords, formatWhen, isOpenForClaims } from './time';
import type { OrganizerSheet, PublicSheet } from './views';

export type ShareText = { subject: string; text: string };

/** The only places a share or calendar button may lead. */
export const SHARE_TARGETS = ['https://wa.me/', 'sms:', 'mailto:', 'https://calendar.google.com/calendar/render?'] as const;

/** Whether an address is one a share or calendar button may have: one of SHARE_TARGETS, with everything in it encoded. */
export function isShareHref(href: string): boolean {
  return SHARE_TARGETS.some((target) => href.startsWith(target)) && !/[\s<>"`\\]/.test(href);
}

/** How a contact can be reached by a link: a number for Messages, digits for WhatsApp, an email address. */
export type Reach = { sms: string | null; whatsapp: string | null; email: string | null };

const NOWHERE: Reach = { sms: null, whatsapp: null, email: null };
const EMAIL = /^[^\s@,;:<>()[\]"\\]+@[^\s@,;:<>()[\]"\\]+\.[^\s@,;:<>()[\]"\\]+$/;
const PHONE = /^\+?[0-9(][0-9 ().-]{5,22}[0-9]$/;

/**
 * A contact as an address for a link: an email address as it is; a phone number as +digits. A US number (10 digits, or
 * 11 starting with 1) gets its country code, 1, which WhatsApp needs; another country's only when written with +.
 * Anything else (a number with words around it, a local number) gets no link: the organizer can still copy the text.
 */
export function reachOf(contact: string): Reach {
  const text = contact.trim();
  if (EMAIL.test(text)) return { sms: null, whatsapp: null, email: text };
  if (!PHONE.test(text)) return NOWHERE;
  const digits = text.replace(/\D/g, '');
  if (text.startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? { sms: `+${digits}`, whatsapp: digits, email: null } : NOWHERE;
  if (digits.length === 10 || (digits.length === 11 && digits.startsWith('1'))) {
    const us = digits.length === 10 ? `1${digits}` : digits;
    return { sms: `+${us}`, whatsapp: us, email: null };
  }
  return NOWHERE;
}

const enc = encodeURIComponent;
// Mail wants CRLF line breaks in a body (RFC 6068).
const mailText = (text: string) => enc(text.replace(/\r?\n/g, '\r\n'));
const address = (email: string) => enc(email).replace(/%40/g, '@');

export type ShareLinks = { whatsapp: string; sms: string; email: string };

/** WhatsApp, Messages and Mail opened with the text, addressed to nobody: the person picks where it goes. */
export function shareLinks(text: ShareText): ShareLinks {
  return {
    whatsapp: `https://wa.me/?text=${enc(text.text)}`,
    sms: `sms:?&body=${enc(text.text)}`,
    email: `mailto:?subject=${mailText(text.subject)}&body=${mailText(text.text)}`
  };
}

export type PersonLinks = { whatsapp: string | null; sms: string | null; email: string | null };

/** Links to one person only: each one their contact allows (their number, their address), else null. */
export function personLinks(text: ShareText, contact: string): PersonLinks {
  const reach = reachOf(contact);
  return {
    whatsapp: reach.whatsapp ? `https://wa.me/${reach.whatsapp}?text=${enc(text.text)}` : null,
    sms: reach.sms ? `sms:${reach.sms}?&body=${enc(text.text)}` : null,
    email: reach.email ? `mailto:${address(reach.email)}?subject=${mailText(text.subject)}&body=${mailText(text.text)}` : null
  };
}

/** One email to several people, every address in bcc; null when none of them gave an email address. */
export function bccLink(text: ShareText, contacts: readonly string[]): string | null {
  const emails = [...new Set(contacts.map((contact) => reachOf(contact).email).filter((email): email is string => email !== null))];
  if (emails.length === 0) return null;
  return `mailto:?bcc=${emails.map(address).join(',')}&subject=${mailText(text.subject)}&body=${mailText(text.text)}`;
}

/** The two lines for the group chat that invite people to a sheet. */
export function inviteText(title: string, link: string): ShareText {
  return { subject: title, text: words.share.invite(title, link).join('\n') };
}

/** "Taken" for a one-place slot with someone in it, "2 taken" for a larger one; '' when nobody is in it. */
function takenWords(confirmed: number, capacity: number): string {
  if (confirmed === 0) return '';
  return capacity === 1 ? words.share.takenOne : words.share.takenMany(confirmed);
}

/**
 * This week's reminder for a sheet: a line per slot of each date in the next 7 days (today and the 6 after it, in the
 * sheet's time zone; cancelled dates left out) with who has it, or "Taken" where the sheet hides names, and the places
 * still open. Null when nothing falls in the next 7 days (the button then reads "Nothing in the next 7 days").
 */
export function weekText(sheet: PublicSheet, link: string, now: Date = new Date()): ShareText | null {
  const w = words.share;
  const today = civilToday(sheet.timezone, now);
  const last = addDays(today, 6);
  const lines: string[] = [];
  for (const date of sheet.dates) {
    if (date.cancelled || date.onDate < today || date.onDate > last) continue;
    for (const slot of date.slots) {
      const filled =
        sheet.names === 'taken'
          ? takenWords(slot.confirmed, slot.capacity)
          : slot.entries
              .map((entry) => entry.name ?? '')
              .filter(Boolean)
              .join(', ');
      const open = slot.capacity - slot.confirmed;
      lines.push(w.weekLine(formatWhen(date.onDate, date.startsAt), slot.label, filled, open > 0 ? w.placesOpen(open) : ''));
    }
  }
  if (lines.length === 0) return null;
  return { subject: w.weekSubject(sheet.title), text: [w.weekHeading(sheet.groupName, sheet.title), ...lines, w.weekFooter(link)].join('\n') };
}

export type WaitlistMessage = { signupId: string; personId: string; name: string; contact: string; text: ShareText };

/**
 * The messages for the people waiting on a sheet's dates still ahead (not cancelled): one for each of them, with their
 * number in the queue and up to five other dates whose slot of the same name still has room, and one for all of them
 * (null when nobody waits). Organizer only: it reads the organizer's view, with the contacts each message goes to.
 */
export function waitlistMessages(sheet: OrganizerSheet, link: string, now: Date = new Date()): { all: ShareText | null; each: WaitlistMessage[] } {
  const w = words.share;
  const ahead = sheet.dates.filter((date) => !date.cancelled && isOpenForClaims(date.onDate, date.startsAt, sheet.timezone, now));
  const each: WaitlistMessage[] = [];
  for (const date of ahead) {
    for (const slot of date.slots) {
      const room = ahead
        .filter((other) => other.id !== date.id && other.slots.some((each) => each.label === slot.label && each.confirmed < each.capacity))
        .slice(0, 5)
        .map((other) => dateWords(sheet.dates, other))
        // A date's own words have a comma ("Sat, Nov 14"): dates are set apart with semicolons.
        .join('; ');
      for (const signup of slot.signups) {
        if (signup.status !== 'waiting') continue;
        const text = w.waitlistOne(signup.name, slot.label, dateWords(sheet.dates, date), signup.position ?? 1, sheet.title, room, link);
        each.push({ signupId: signup.id, personId: signup.personId, name: signup.name, contact: signup.contact, text: { subject: w.waitlistSubject(sheet.title), text } });
      }
    }
  }
  const all = each.length > 0 ? { subject: w.waitlistSubject(sheet.title), text: w.waitlistAll(sheet.title, link) } : null;
  return { all, each };
}
