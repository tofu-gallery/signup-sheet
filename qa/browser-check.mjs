// The browser-level check (see docs/verification.md, Browser check). One headless Chromium walks this app's real flows
// on a running copy with real taps and typing, never by sending a form itself: the organizer's setup, import and
// sheet; members signing up, joining the waitlist, cancelling and moving up; the organizer's pages after that; the main
// pages at four more sizes; JavaScript off; and edge cases. For every step it keeps viewport screenshots (the top of
// the page and each screen down to its end, at most six, never one full-page capture), the page's HTML, page errors,
// console errors, failed requests, and a scan: a page wider than the window, targets under 44×44 CSS px (links inside
// running text listed apart), text boxes of different elements overlapping, text clipped by an overflow ancestor,
// inputs under 16 px, inputs without a label, buttons and links without a name. Text only a screen reader reads (a
// 1×1 clipped box, the `.sr` pattern) is left out of the scan.
//
//   node qa/browser-check.mjs --url http://127.0.0.1:3101 --out /tmp/ss-browser-run [--examples examples]
//
// It needs a copy nobody has set up and no organizer password (scripts/preview-db.mjs reset): its first tap takes the
// setup seat. It pastes examples/soccer.json and examples/potluck.json, their dates moved by whole weeks to a season
// at least two weeks ahead when they are not that far ahead already. It writes
// report.json, shots/, html/ and downloads/ under --out, a new directory outside this repository (mode 700, files
// 600): they hold the run's private links and its made-up data. It exits 0 when every functional check passed, no page
// error happened and the check itself had no problem, 1 otherwise, 2 when it could not start. playwright-core is not a
// dependency of this app: it is loaded from the directory in PLAYWRIGHT_CORE, else from wherever Node finds it (for
// example after `npm install --no-save playwright-core`), with its own Chromium. This check installs nothing and starts
// no server.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LAUNCH = {
  headless: true,
  args: ['--use-mock-keychain', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  // Playwright turns the back/forward cache off by default; a phone's browser has one, so Back behaves as it would there.
  ignoreDefaultArgs: ['--disable-back-forward-cache']
};
const MAX_SCREENS = 6;
const PHONE = { width: 390, height: 844 };
const SIZES = [
  { width: 320, height: 640, mobile: true, touch: true },
  { width: 844, height: 390, mobile: true, touch: true },
  { width: 768, height: 1024, mobile: true, touch: true },
  { width: 1280, height: 800, mobile: false, touch: false }
];
// Every simulated phone sends its own X-Real-IP from 192.0.2.0/24 (as qa/local-http-check.py does), so the app's
// per-connection limits count phones apart, as they would count real ones. No limit is changed.
const IP = {
  organizer: '192.0.2.10',
  frank: '192.0.2.21',
  mike: '192.0.2.22',
  public: '192.0.2.30',
  noScript: '192.0.2.31',
  noScriptLink: '192.0.2.32',
  noScriptDouble: '192.0.2.33',
  edge: (n) => `192.0.2.${40 + n}`
};
const CONTACT = 'hello@trytofu.ai';
const TOKEN = /\/me\/[A-Za-z0-9_-]{43}/;
// The made-up people: only Mike and Frank.
const NAMES = {
  frank: 'Frank',
  mike: 'Mike',
  noScript: "Mike's carpool",
  noScriptDouble: "Frank's carpool",
  long: ("Frank's family " + 'Frankfurter'.repeat(6)).slice(0, 80),
  emoji: "Mike's family \u{1F3C8}",
  markup: "Mike's team",
  card: "Frank's team",
  double: "Frank's crew",
  back: "Mike's crew",
  week: "Mike's neighbors",
  potluck: "Frank's family"
};

// The app's sentences this check looks for, word for word (src/words.ts). A change there needs the same change here.
const W = {
  setupHeading: 'This sign-up sheet has no organizer yet',
  setupButton: 'Set up this app as its organizer',
  dashboardHeading: 'Your sign-up sheets',
  noSheets: 'No sheets yet. Make one, or import a file.',
  nav: { home: 'Sign-up sheet', mine: 'Your sign-ups', organizer: 'Organizer home', people: 'People', settings: 'Settings', importExport: 'Import and export' },
  importHeading: 'Import a file',
  importCheck: 'Check this file',
  importApply: 'Import it',
  wouldMake: 'Would make:',
  imported: 'Imported:',
  importRepeated: 'This form was already used, so the file was imported only once. To import another file, open Import and export again.',
  makeOpen: 'Open for sign-ups',
  takeIt: 'Take it',
  joinWaitlist: 'Join the waitlist',
  signUp: 'Sign up',
  joinWaitlistButton: (n) => `Join the waitlist (you'd be #${n})`,
  full: 'This place is full.',
  confirmedNew: (slot, when) => `You're in: ${slot}, ${when}.`,
  waitingNew: (n) => `This place is full, so you're on the waitlist: #${n}. If a place opens, you move up automatically.`,
  addCalendar: 'Add to my calendar',
  myPage: 'Your sign-ups',
  cancel: 'Cancel',
  cancelQuestion: (slot, when) => `Cancel ${slot} on ${when}? If someone is waiting, they move up.`,
  yesCancel: 'Yes, cancel',
  keepIt: 'Keep it',
  cancelledDone: 'Cancelled.',
  cancelledUp: 'Cancelled. The first person on the waitlist moved up into your place.',
  pickAnother: 'Pick another date on the sheet',
  noSignups: 'You have no sign-ups right now.',
  confirmed: 'Confirmed',
  movedUpOn: 'Moved up from the waitlist on ',
  movedUpItem: (name) => `${name} moved up from the waitlist`,
  toldThem: 'Told them',
  undo: 'Undo',
  toldDone: (name) => `Marked ${name} as told.`,
  change: 'Change',
  swap: 'Swap',
  remove: 'Remove',
  removeOneQuestion: (name, slot, when) => `Remove ${name} from ${slot}, ${when}?`,
  changedTell: 'Tell them about the change:',
  showOnlyUnpaid: 'Show only unpaid',
  notPaid: 'Not paid',
  savePaid: 'Save paid',
  saved: 'Saved.',
  addDateButton: 'Add the date',
  weekReminder: "This week's reminder",
  backToSheet: 'Back to the sheet',
  addSomeone: 'Add someone',
  addThem: 'Add them',
  addFull: (n) => `This place is full: they join the waitlist as #${n}.`,
  added: 'Added.',
  messageWaitlist: 'Message the waitlist',
  waitlistAll: 'To everyone waiting',
  bulkLink: 'Add a date every week',
  bulkPreview: 'Show the dates',
  bulkWill: (n) => `${n === 1 ? 'This date' : `These ${n} dates`} will be added:`,
  bulkAdd: (n) => `Add ${n === 1 ? 'the date' : `the ${n} dates`}`,
  bulkAdded: (n) => `Added ${n} ${n === 1 ? 'date' : 'dates'}.`,
  addEveryButton: 'Add to every date',
  addSlotEvery: 'Add a place to every date',
  changeDate: 'Change this date',
  cancelDate: 'Cancel this date',
  cancelDateQuestion: (when) => `Cancel ${when}?`,
  yesCancelDate: 'Yes, cancel the date',
  undoCancel: 'Undo the cancel',
  cancelledTell: (when) => `${when} is cancelled. Tell the people on it:`,
  cancelledTag: 'Cancelled',
  settingsHeading: 'Settings',
  save: 'Save',
  // Frank's family was imported, so the link made for them is their first: no old link stops working.
  firstLink: 'Make their private link',
  firstLinkQuestion: (name) => `Make a private link for ${name}? They use it to see, change or cancel their sign-ups.`,
  firstLinkShown: 'Here is their private link. Send it to them now: it is shown only once.',
  linkFor: (name) => `${name}'s private link`,
  backToPerson: (name) => `Back to ${name}`,
  newLinkNoContact: 'No phone or email saved for them. Copy the link and send it to them yourself, not to the group.',
  linkMade: 'Link made ',
  removeEverywhere: 'Remove from every place',
  removeQuestion: (name) => `Remove ${name} from every place, and from the list?`,
  removeYes: 'Yes, remove',
  removed: 'Removed.',
  removedOneUp: 'Removed. The first person waiting moved up: tell them.',
  deleteDate: 'Delete date',
  deleteDateQuestion: (when) => `Delete ${when} with its places and sign-ups?`,
  tellThese: (n) => `${n === 1 ? '1 person is' : `${n} people are`} signed up. Tell them:`,
  nobodyHere: 'Nobody is signed up here.',
  yesDelete: 'Yes, delete',
  deleted: 'Deleted.',
  exportAll: 'Export everything (JSON)',
  csv: 'Download a spreadsheet (CSV)',
  publicPage: 'Public page',
  organizerSignIn: 'Organizer sign-in',
  updateCalendar: 'Update my calendar',
  meDateCancelled: 'This date is cancelled, so nothing is needed from you that day. The organizer will let you know if that changes.',
  remindButton: 'Download the reminder',
  reminderSummary: "Send this week's sign-up reminder",
  askGroupHeading: 'Nobody was waiting for that place.',
  timezoneLocked: "The time zone can't change once people have signed up.",
  takenNoteHint: 'Your name stays hidden on this sheet ("Taken"), but everyone sees this.',
  editSheet: 'Edit the sheet',
  namesTaken: 'Show only "Taken"',
  saveChanges: 'Save changes',
  taken: 'Taken',
  // The snack sheet calls its note "What you'll bring" (examples/soccer.json), and its sentences say so.
  privacyTaken: 'On this sheet your name shows only as "Taken". What you write in "What you\'ll bring" shows on the sheet; your email or phone doesn\'t.',
  card: 'That looks like a card or bank number. This app never keeps those.',
  // The potluck's note is "What you'll bring" (examples/potluck.json).
  noteRequired: 'Please fill in "What you\'ll bring": this sheet asks for it.',
  formReused: 'This form was already used. Reload the page and try again.',
  alreadyHere: "You're already signed up here.",
  csvHeader: ['Date', 'Weekday', 'Start', 'End', 'Date label', 'Place', 'Slot', 'Status', 'Name', 'Contact', 'Note', 'Paid', 'Paid note', 'Added by', 'Signed up at', 'Date cancelled']
};

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// --- Small helpers ----------------------------------------------------------------------------------------------------

/** Stops before anything ran, with one sentence. */
function stop(sentence) {
  console.error(`[browser-check] ${sentence}`);
  process.exit(2);
}

function clean(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A regular expression for exactly this text (white space around it ignored). */
function exact(text) {
  return new RegExp(`^\\s*${escapeRegExp(text)}\\s*$`);
}

/**
 * A regular expression for text that starts with this: a control whose visible words are followed by words only a
 * screen reader hears ("Change", then ": Mike's family" in a visually hidden span).
 */
function startsWith(text) {
  return new RegExp(`^\\s*${escapeRegExp(text)}(?![A-Za-z])`);
}

/** Private links replaced, for the report and the console. The saved HTML and screenshots keep them. */
function redact(text) {
  return String(text ?? '').replace(/\/me\/[A-Za-z0-9_-]{43}/g, '/me/<private-link>');
}

function errorText(error) {
  return redact(String(error?.message ?? error).split('\n').slice(0, 4).join(' ')).slice(0, 600);
}

function writePrivate(file, data) {
  writeFileSync(file, data, { mode: 0o600 });
  chmodSync(file, 0o600);
}

function weekdayOf(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** 'Saturday, November 21': how a date strip names a day. */
function longDate(iso) {
  const [, m, d] = iso.split('-').map(Number);
  return `${WEEKDAYS[weekdayOf(iso)]}, ${MONTHS[m - 1]} ${d}`;
}

/** 'Sat, Nov 21': how sentences name a day. */
function shortDate(iso) {
  const [, m, d] = iso.split('-').map(Number);
  return `${WEEKDAYS[weekdayOf(iso)].slice(0, 3)}, ${MONTHS[m - 1].slice(0, 3)} ${d}`;
}

function addDays(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function todayIn(timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

function pathAndQuery(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search;
  } catch {
    return '';
  }
}

/** A page's place in the scan's grouping: its path, with ids and links made general. */
function pageKey(url) {
  let parsed;
  try {
    parsed = new URL(String(url).replace('/me/<private-link>', '/me/:link'));
  } catch {
    return String(url);
  }
  const path = parsed.pathname.replace(/\/me\/[A-Za-z0-9_-]{43}/, '/me/:link').replace(/\/[0-9]+(?=\/|$)/g, '/:id');
  return path === '/me' && parsed.searchParams.has('new') ? '/me?new=:id (after claim)' : path;
}

function hasKey(value, pattern) {
  if (Array.isArray(value)) return value.some((item) => hasKey(item, pattern));
  if (value && typeof value === 'object') return Object.entries(value).some(([key, item]) => pattern.test(key) || hasKey(item, pattern));
  return false;
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

// --- In the page: the scan and the screen's headings (self-contained: Playwright sends their source) -------------------

function scanPage() {
  const view = { width: window.innerWidth, height: window.innerHeight };
  const root = document.documentElement;
  const sx = window.scrollX;
  const sy = window.scrollY;
  const round = (n) => Math.round(n * 10) / 10;
  const clean = (text) => String(text || '').replace(/\s+/g, ' ').trim();
  const textOf = (el) => clean(el instanceof HTMLElement ? el.innerText : el.textContent);
  const describe = (el) => {
    let d = el.tagName.toLowerCase();
    if (el.id) d += `#${el.id}`;
    const classes = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
    if (classes.length > 0) d += `.${classes.join('.')}`;
    const name = el.getAttribute('name');
    if (name && /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(el.tagName)) d += `[name=${name}]`;
    const text = textOf(el).slice(0, 60);
    if (text) d += ` "${text}"`;
    return d;
  };
  // Hidden on purpose for everyone but screen readers: a 1×1 box that clips what is in it (the `.sr` pattern). Its
  // text still has full-width boxes, which would read as overlapping or clipped text.
  const visuallyHidden = (el) => {
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.position !== 'absolute' && cs.position !== 'fixed') continue;
      const r = e.getBoundingClientRect();
      if (r.width <= 1 && r.height <= 1 && (cs.overflow === 'hidden' || cs.clip !== 'auto' || cs.clipPath !== 'none')) return true;
    }
    return false;
  };
  const shown = (el) => {
    if (el.closest('[aria-hidden="true"]')) return false;
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    if (visuallyHidden(el)) return false;
    // Placed off the page on purpose, like the skip link until it has focus.
    return r.right + sx > 0 && r.bottom + sy > 0;
  };

  // Text: every visible text box, with the element it belongs to.
  const texts = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!/\S/.test(node.textContent || '')) continue;
    const el = node.parentElement;
    if (!el || el.closest('script, style, noscript, template, textarea, select, option')) continue;
    if (!shown(el)) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const r of range.getClientRects()) {
      if (r.width < 1 || r.height < 1) continue;
      texts.push({ el, text: clean(node.textContent).slice(0, 50), x: r.left + sx, y: r.top + sy, w: r.width, h: r.height });
    }
  }

  // 1. A page wider than the window, and what sticks out.
  const scrollWidth = root.scrollWidth;
  const wider = scrollWidth > view.width;
  const wide = [];
  if (wider) {
    const named = new Set();
    for (const el of document.body.querySelectorAll('*')) {
      if (wide.length >= 15) break;
      if (!shown(el)) continue;
      if (el.getBoundingClientRect().right + sx <= view.width + 0.5) continue;
      const child = [...el.children].some((c) => shown(c) && c.getBoundingClientRect().right + sx > view.width + 0.5);
      if (child) continue;
      named.add(el);
      wide.push({ el: describe(el), right: round(el.getBoundingClientRect().right + sx) });
    }
    for (const t of texts) {
      if (wide.length >= 15) break;
      if (t.x + t.w > view.width + 0.5 && !named.has(t.el)) {
        named.add(t.el);
        wide.push({ el: describe(t.el), text: t.text, right: round(t.x + t.w) });
      }
    }
  }

  // 2. Targets under 44×44 CSS px. A checkbox or radio counts with its label, which takes the tap too.
  const blockOf = (el) => {
    let block = el.parentElement;
    while (block && getComputedStyle(block).display === 'inline') block = block.parentElement;
    return block;
  };
  const inRunningText = (el) => {
    if (getComputedStyle(el).display !== 'inline') return false;
    const block = blockOf(el);
    if (!block) return false;
    let plain = '';
    const walk = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    for (let node = walk.nextNode(); node; node = walk.nextNode()) {
      let inline = true;
      for (let e = node.parentElement; e && e !== block; e = e.parentElement) {
        if (e.matches('a, button, select, textarea, summary, label') || getComputedStyle(e).display !== 'inline') {
          inline = false;
          break;
        }
      }
      if (inline) plain += node.textContent;
    }
    return /[\p{L}\p{N}]{2,}/u.test(plain);
  };
  const smallTargets = [];
  const smallInlineLinks = [];
  const interactive = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])';
  for (const el of document.querySelectorAll(interactive)) {
    if (!shown(el)) continue;
    let box = el.getBoundingClientRect();
    let via = null;
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (el.tagName === 'INPUT' && (type === 'checkbox' || type === 'radio')) {
      for (const label of el.labels || []) {
        const r = label.getBoundingClientRect();
        if (r.width * r.height > box.width * box.height) {
          box = r;
          via = 'its label';
        }
      }
    }
    if (box.width >= 43.99 && box.height >= 43.99) continue;
    const entry = { el: describe(el), width: round(box.width), height: round(box.height) };
    if (via) entry.via = via;
    if (el.tagName === 'A' && inRunningText(el)) smallInlineLinks.push(entry);
    else smallTargets.push(entry);
  }

  // 3. Text boxes of different elements on top of each other.
  const overlaps = [];
  const pairs = new Set();
  const sorted = [...texts].sort((a, b) => a.y - b.y);
  outer: for (let i = 0; i < sorted.length; i += 1) {
    const a = sorted[i];
    for (let j = i + 1; j < sorted.length && sorted[j].y < a.y + a.h; j += 1) {
      const b = sorted[j];
      if (a.el === b.el) continue;
      const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (w <= 2 || h <= Math.max(3, 0.25 * Math.min(a.h, b.h))) continue;
      const key = `${describe(a.el)}|${describe(b.el)}`;
      if (pairs.has(key)) continue;
      pairs.add(key);
      overlaps.push({ a: describe(a.el), aText: a.text, b: describe(b.el), bText: b.text, width: round(w), height: round(h) });
      if (overlaps.length >= 30) break outer;
    }
  }

  // 4. Text cut off by an ancestor whose overflow is not visible (or scrolled inside it), and ellipses.
  const clipped = [];
  const clipSeen = new Set();
  for (const t of texts) {
    for (let a = t.el; a && a !== document.body && a !== root; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.display === 'inline' || (cs.overflowX === 'visible' && cs.overflowY === 'visible')) continue;
      const r = a.getBoundingClientRect();
      const left = r.left + sx + a.clientLeft;
      const top = r.top + sy + a.clientTop;
      const outX = cs.overflowX !== 'visible' && (t.x < left - 2 || t.x + t.w > left + a.clientWidth + 2);
      const outY = cs.overflowY !== 'visible' && (t.y < top - 2 || t.y + t.h > top + a.clientHeight + 2);
      if (!outX && !outY) continue;
      const key = `${describe(t.el)}|${describe(a)}`;
      if (!clipSeen.has(key)) {
        clipSeen.add(key);
        clipped.push({ el: describe(t.el), text: t.text, by: describe(a), overflow: `${cs.overflowX}/${cs.overflowY}`, scrolls: /auto|scroll/.test(`${cs.overflowX} ${cs.overflowY}`) });
      }
      break;
    }
  }
  for (const el of document.body.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    if (cs.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1 && shown(el)) {
      clipped.push({ el: describe(el), text: textOf(el).slice(0, 50), by: 'text-overflow: ellipsis', overflow: `${cs.overflowX}/${cs.overflowY}`, scrolls: false });
    }
  }

  // 5. Inputs under 16 px (a phone zooms in on them).
  const textLike = /^(text|email|tel|number|password|search|url|date|time|datetime-local|month|week)$/;
  const smallFontInputs = [];
  for (const el of document.querySelectorAll('input, select, textarea')) {
    if (el.tagName === 'INPUT' && !textLike.test((el.getAttribute('type') || 'text').toLowerCase())) continue;
    if (!shown(el)) continue;
    const size = parseFloat(getComputedStyle(el).fontSize);
    if (size < 16) smallFontInputs.push({ el: describe(el), fontSize: size });
  }

  // 6. Inputs without a label, 7. buttons and links without a name.
  const byIds = (ids) => clean(ids.split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)).filter(Boolean).map((e) => e.textContent).join(' '));
  const unlabelledInputs = [];
  for (const el of document.querySelectorAll('input, select, textarea')) {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (el.tagName === 'INPUT' && /^(hidden|submit|button|reset|image)$/.test(type)) continue;
    if (!shown(el)) continue;
    const name =
      byIds(el.getAttribute('aria-labelledby') || '') ||
      clean(el.getAttribute('aria-label')) ||
      clean([...(el.labels || [])].map((label) => label.textContent).join(' ')) ||
      clean(el.getAttribute('title'));
    if (!name) unlabelledInputs.push({ el: describe(el), placeholder: el.getAttribute('placeholder') });
  }
  const unnamedControls = [];
  for (const el of document.querySelectorAll('a[href], button, summary, [role="button"], [role="link"], input[type="submit"], input[type="button"], input[type="reset"]')) {
    if (!shown(el)) continue;
    const name =
      byIds(el.getAttribute('aria-labelledby') || '') ||
      clean(el.getAttribute('aria-label')) ||
      textOf(el) ||
      clean(el.getAttribute('title')) ||
      clean([...el.querySelectorAll('img[alt]')].map((img) => img.getAttribute('alt')).join(' ')) ||
      (el.tagName === 'INPUT' ? clean(el.value) : '');
    if (!name) unnamedControls.push({ el: describe(el) });
  }

  return {
    viewport: view,
    scrollWidth,
    clientWidth: root.clientWidth,
    wider,
    wide,
    smallTargets,
    smallInlineLinks,
    overlaps,
    clipped,
    smallFontInputs,
    unlabelledInputs,
    unnamedControls
  };
}

/** The headings, notices and errors inside the window right now: what a screenshot shows. */
function onScreen() {
  const out = [];
  // The words a reader hears: text in an aria-hidden part (a date strip's small calendar page) is left out.
  const heard = (el) => {
    let text = '';
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || parent.closest('[aria-hidden="true"], textarea, select')) continue;
      if (typeof parent.checkVisibility === 'function' && !parent.checkVisibility()) continue;
      text += ` ${node.textContent}`;
    }
    return text.replace(/\s+/g, ' ').trim();
  };
  for (const el of document.querySelectorAll('h1, h2, h3, .done-line, .notice, .sentence p, legend, .lead strong, .field-error')) {
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility()) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom <= 0 || r.top >= window.innerHeight) continue;
    const text = heard(el);
    if (text && !out.includes(text)) out.push(text.length > 80 ? `${text.slice(0, 77)}...` : text);
  }
  return out.slice(0, 5);
}

// --- The run's state ---------------------------------------------------------------------------------------------------

const OPTIONS = parseArgs(process.argv.slice(2));
const BASE = OPTIONS.url;
const OUT = OPTIONS.out;

function parseArgs(argv) {
  const options = { url: '', out: '', examples: join(REPO, 'examples') };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) stop(`${arg} needs a value.`);
      index += 1;
      return next;
    };
    if (arg === '--url') options.url = value();
    else if (arg === '--out') options.out = resolve(value());
    else if (arg === '--examples') {
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        options.examples = resolve(next);
        index += 1;
      }
    } else stop(`Unknown option ${arg}: say --url <origin> --out <new directory> [--examples <directory>].`);
  }
  if (!options.url || !options.out) stop('Say --url <origin> and --out <new directory>.');
  let origin;
  try {
    origin = new URL(options.url);
  } catch {
    stop('--url must be an address like http://127.0.0.1:3101.');
  }
  if (!/^https?:$/.test(origin.protocol) || origin.pathname !== '/' || origin.search || origin.hash) stop('--url must be an origin only, like http://127.0.0.1:3101.');
  options.url = origin.origin;
  const inside = relative(REPO, options.out);
  if (inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))) stop('--out must be outside this repository: the run keeps private links.');
  return options;
}

function readExample(name) {
  const file = join(OPTIONS.examples, name);
  if (!existsSync(file)) stop(`${file} is missing: --examples must name the directory with soccer.json and potluck.json.`);
  return readFileSync(file, 'utf8');
}

// The examples' dates are fixed (a season to copy, with its weekdays checked), and this check needs them ahead. Once the
// soccer season's first day is less than two weeks off in its own time zone, both files are pasted with every date moved
// by the same whole number of weeks, so each keeps its weekday and the potluck stays a week after the season starts.
const SOCCER_FILE = JSON.parse(readExample('soccer.json'));
const POTLUCK_FILE = JSON.parse(readExample('potluck.json'));
const ZONE = SOCCER_FILE.sheets[0].timezone;
const TODAY = todayIn(ZONE);
const SHIFT_WEEKS = (() => {
  let weeks = 0;
  while (addDays(SOCCER_FILE.sheets[0].dates[0].date, 7 * weeks) < addDays(TODAY, 14)) weeks += 1;
  return weeks;
})();
function moved(file) {
  const move = (iso) => addDays(iso, 7 * SHIFT_WEEKS);
  return {
    ...file,
    sheets: file.sheets.map((sheet) => ({
      ...sheet,
      dates: sheet.dates.map((date) => ({ ...date, date: move(date.date) })),
      ...(sheet.signups ? { signups: sheet.signups.map((signup) => ({ ...signup, date: move(signup.date) })) } : {})
    }))
  };
}
const SOCCER = moved(SOCCER_FILE);
const POTLUCK = moved(POTLUCK_FILE);
const SOCCER_TEXT = SHIFT_WEEKS === 0 ? readExample('soccer.json') : `${JSON.stringify(SOCCER, null, 2)}\n`;
const POTLUCK_TEXT = SHIFT_WEEKS === 0 ? readExample('potluck.json') : `${JSON.stringify(POTLUCK, null, 2)}\n`;
const SHEET = SOCCER.sheets[0];
const SLOT = SHEET.everyDate[0].label;
const DATES = SHEET.dates.map((date) => date.date);
// The members' flow takes the third date: the first two hold Mike's and Frank's families from the file.
const CLAIM_DATE = DATES[2];
if (DATES[0] <= TODAY) stop(`examples/soccer.json's first date (${DATES[0]}) is not ahead: this check needs its dates ahead.`);
// A day in the coming week, for "Add a date" (so this week's reminder has something), a Saturday when there is one.
const WEEK_DATE = (() => {
  const days = [1, 2, 3, 4, 5, 6].map((n) => addDays(TODAY, n)).filter((day) => !DATES.includes(day));
  return days.find((day) => weekdayOf(day) === 6) ?? days[0];
})();
// "Add a date every week": four Saturdays after the season.
const BULK_FROM = (() => {
  let day = addDays(DATES.at(-1), 14);
  while (weekdayOf(day) !== 6) day = addDays(day, 1);
  return day;
})();
const BULK_DAYS = [0, 7, 14, 21].map((n) => addDays(BULK_FROM, n));
const POTLUCK_SHEET = POTLUCK.sheets[0];

const report = {
  check: 'qa/browser-check.mjs',
  url: BASE,
  startedAt: new Date().toISOString(),
  finishedAt: '',
  browser: {},
  setup: [
    'One headless Chromium (playwright-core), at most one browser process, closed at the end.',
    "Playwright's --disable-back-forward-cache is left out, so Back can restore a page from the cache as a phone's browser would.",
    'Each simulated phone is its own browser context and sends its own X-Real-IP from 192.0.2.0/24, as qa/local-http-check.py does.',
    'Date and time fields are filled with their ISO value (what a phone date picker sets); every other field is typed key by key, and the import file is pasted.',
    'The saved HTML and the screenshots show private links of this throwaway database; this report has them replaced.'
  ],
  summary: {},
  steps: [],
  screenshots: [],
  downloads: [],
  functionalFailures: [],
  pageErrors: [],
  consoleErrors: [],
  failedRequests: [],
  httpErrors: [],
  scanByPage: {},
  notExercised: [],
  scriptProblems: []
};

// What this check does not do, said in every report (docs/verification.md says where each is proven, if anywhere).
const NOT_COVERED = [
  ['device calendars', 'Whether iPhone and Android calendars accept the .ics files, replace an event by UID and SEQUENCE, drop a cancelled one and show its alerts: the check reads the files, it cannot see a phone.'],
  ['share targets', 'Opening WhatsApp, Messages, Mail or Google Calendar from their links: the check reads the links (encoding, one recipient, bcc), it opens no other app.'],
  ['Copy and Share', 'The clipboard after Copy, and the phone share sheet (headless Chromium has no navigator.share, so Share stays hidden): only that Copy shows once the script runs.'],
  ['other browsers', "Safari and WebKit, and chat apps' in-app browsers (their back/forward cache and cookies): one Chromium only."],
  ['organizer access states', 'Sign-in with ORGANIZER_PASSWORD, the held-elsewhere page, the locked states and Give up setup: the run keeps the setup seat throughout.'],
  ['member pages not walked', "A member's Move, note and name or contact changes, their own new link, and Forget me on this phone."],
  ['organizer pages not walked', 'A new sheet from the form, an organizer Move, a date\'s day, time or place changed, a place edited or deleted, a sheet deleted, Add a person, a person edited or deleted from the list, Mark paid on the unpaid list and its Undo, the dashboard\'s This week\'s reminder button, a new link for someone who already had one.'],
  ['states not reached', 'A season that is over, a date that has started, a closed sheet, a person with more than three places on a sheet.'],
  ['several servers', 'The run uses the one --url; races across servers are qa/local-http-check.py\'s.'],
  ['Tofu', 'The access-code door, the platform\'s headers and its security checkpoint: a deployed copy only.']
];

/** Ids and links the flows learn as they go. */
const S = { slots: {} };
let stepCount = 0;
let phase = '';
/** @type {Record<string, Phone>} */
const phones = {};
let browser = null;

// --- One simulated phone (a browser context with one page) ---------------------------------------------------------------

class Phone {
  constructor(name, options) {
    this.name = name;
    this.options = options;
    this.js = options.js !== false;
    this.touch = options.touch !== false;
    this.trail = [];
    this.fresh();
  }

  get label() {
    return `${this.options.viewport.width}x${this.options.viewport.height}${this.js ? '' : '-nojs'}`;
  }

  /** Starts a new step's record of what the page did. */
  fresh() {
    this.events = { pageErrors: [], consoleErrors: [], failedRequests: [], httpErrors: [], dialogs: [] };
    this.docs = [];
    this.posts = [];
  }

  /** What happened since the step started. */
  taken() {
    const taken = { events: this.events, docs: this.docs, posts: this.posts };
    this.fresh();
    return taken;
  }

  async open() {
    const o = this.options;
    this.context = await browser.newContext({
      viewport: o.viewport,
      deviceScaleFactor: 2,
      isMobile: o.mobile !== false,
      hasTouch: this.touch,
      javaScriptEnabled: this.js,
      acceptDownloads: true,
      locale: 'en-US',
      timezoneId: ZONE,
      ...(o.storageState ? { storageState: o.storageState } : {}),
      ...(o.ip ? { extraHTTPHeaders: { 'X-Real-IP': o.ip } } : {})
    });
    this.context.setDefaultTimeout(10_000);
    this.context.setDefaultNavigationTimeout(20_000);
    if (this.js) {
      // Says whether a page came back from the back/forward cache (Back after signing up).
      await this.context.addInitScript(() => {
        window.addEventListener('pageshow', (event) => {
          window.__pageshows = (window.__pageshows || []).concat(event.persisted ? 'from the cache' : 'loaded');
        });
      });
    }
    const page = await this.context.newPage();
    this.page = page;
    page.on('pageerror', (error) => this.events.pageErrors.push({ message: redact(String(error.message)).slice(0, 500), url: redact(page.url()) }));
    page.on('console', (message) => {
      if (message.type() === 'error') this.events.consoleErrors.push({ text: redact(message.text()).slice(0, 500), url: redact(page.url()), source: redact(message.location()?.url ?? '') });
    });
    page.on('requestfailed', (request) => this.events.failedRequests.push({ method: request.method(), url: redact(request.url()), error: request.failure()?.errorText ?? '' }));
    page.on('request', (request) => {
      if (request.method() === 'POST') this.posts.push(redact(request.url()));
    });
    page.on('response', (response) => {
      const request = response.request();
      const main = request.isNavigationRequest() && request.frame() === page.mainFrame();
      if (response.status() >= 400) this.events.httpErrors.push({ method: request.method(), url: redact(response.url()), status: response.status(), document: main });
      if (main) this.docs.push({ method: request.method(), url: response.url(), status: response.status() });
    });
    page.on('dialog', (dialog) => {
      this.events.dialogs.push(dialog.message());
      dialog.dismiss().catch(() => {});
    });
    return this;
  }

  async close() {
    await this.context?.close().catch(() => {});
    this.context = null;
  }

  say(sentence) {
    this.trail.push(sentence);
  }

  async go(target) {
    const url = new URL(target, BASE).href;
    this.say(`Open ${redact(pathAndQuery(url))}`);
    let response = await this.page.goto(url, { waitUntil: 'load' });
    // A server whose database was just made again may answer 503 once (scripts/preview-db.mjs reset): one retry.
    if (response && response.status() === 503) {
      await sleep(2500);
      response = await this.page.goto(url, { waitUntil: 'load' });
    }
    return response;
  }

  async press(locator) {
    if (this.touch) await locator.tap();
    else await locator.click();
  }

  /** A tap that does not leave the page (a summary, a label). */
  async tap(locator, sentence) {
    this.say(sentence);
    await this.press(locator);
  }

  /** A tap that loads another page (a link, a form's button), waiting until it has loaded. */
  async tapAndLoad(locator, sentence) {
    this.say(sentence);
    await this.loading(() => this.press(locator));
  }

  async loading(action, timeout = 20_000) {
    const page = this.page;
    let failure = null;
    const navigated = page.waitForEvent('framenavigated', { predicate: (frame) => frame === page.mainFrame(), timeout }).catch((error) => {
      failure = error;
    });
    await action();
    await navigated;
    if (failure) throw failure;
    await page.waitForLoadState('load', { timeout });
  }

  async type(locator, text, sentence) {
    this.say(sentence);
    await this.press(locator);
    await locator.pressSequentially(text);
  }

  async paste(locator, text, sentence) {
    this.say(sentence);
    await this.press(locator);
    await locator.fill(text);
  }

  /** A date or time field: its ISO value, as a phone's picker sets it. */
  async pick(locator, value, sentence) {
    this.say(sentence);
    await locator.fill(value);
  }

  async choose(locator, label, sentence) {
    this.say(sentence);
    await locator.selectOption({ label });
  }

  /** Back, which may restore the page from the back/forward cache (no load event then). */
  async back(sentence) {
    this.say(sentence);
    await this.page.goBack({ waitUntil: 'commit', timeout: 15_000 });
    await this.page.waitForLoadState('load', { timeout: 15_000 }).catch(() => {});
    await sleep(400);
  }

  /** A tap that answers a file: saved under downloads/ and read back. */
  async download(locator, sentence) {
    this.say(sentence);
    const waiting = this.page.waitForEvent('download', { timeout: 20_000 });
    await this.press(locator);
    const download = await waiting;
    const suggested = download.suggestedFilename();
    const file = `downloads/${String(stepCount + 1).padStart(3, '0')}-${suggested.replace(/[^A-Za-z0-9._-]/g, '_')}`;
    await download.saveAs(join(OUT, file));
    chmodSync(join(OUT, file), 0o600);
    const text = readFileSync(join(OUT, file), 'utf8');
    const entry = { step: stepCount + 1, file, suggested, url: redact(download.url()), bytes: Buffer.byteLength(text), failure: await download.failure() };
    report.downloads.push(entry);
    return { ...entry, text };
  }
}

async function openPhone(name, options) {
  const phone = new Phone(name, options);
  try {
    await phone.open();
  } catch (error) {
    report.scriptProblems.push({ phase, problem: `could not open the browser context ${name}`, error: errorText(error) });
    return phone;
  }
  phones[name] = phone;
  return phone;
}

// --- Steps, records and checks -------------------------------------------------------------------------------------------

/**
 * One step: the action (taps and typing), then the record of the page it left (screenshots, HTML, events, scan), then
 * its checks. A step whose action throws is recorded as it stands, as a failure.
 */
async function step(phone, id, title, action, verify, options = {}) {
  if (!phone?.page || !phone.context) {
    notExercised(id, title, 'its browser context could not be opened');
    return null;
  }
  phone.fresh();
  try {
    await action();
  } catch (error) {
    const entry = await record(phone, `${id}-stopped`, `${title} (stopped)`, options);
    entry.stoppedBy = errorText(error);
    check(entry, 'the step could be done with taps and typing', false, errorText(error));
    return null;
  }
  const entry = await record(phone, id, title, options);
  if (verify) {
    try {
      await verify(entry);
    } catch (error) {
      check(entry, 'its checks could run', false, errorText(error));
    }
  }
  classify(entry, options);
  return entry;
}

async function record(phone, id, title, options = {}) {
  const n = ++stepCount;
  const base = `${String(n).padStart(3, '0')}-${id}-${phone.label}`;
  const page = phone.page;
  const since = phone.taken();
  const last = since.docs.at(-1);
  const entry = {
    n,
    id,
    phase,
    title,
    actor: phone.name,
    viewport: phone.label,
    javascript: phone.js,
    url: redact(page.url()),
    status: last ? last.status : null,
    documents: since.docs.map((doc) => `${doc.method} ${redact(pathAndQuery(doc.url))} ${doc.status}`),
    posts: since.posts.length,
    h1: '',
    notices: [],
    shots: [],
    html: `html/${base}.html`,
    scan: null,
    checks: [],
    pageErrors: since.events.pageErrors,
    consoleErrors: since.events.consoleErrors,
    failedRequests: since.events.failedRequests,
    httpErrors: since.events.httpErrors,
    dialogs: since.events.dialogs
  };
  if (options.expectStatus) entry.expectStatus = options.expectStatus;
  entry.h1 = clean(await page.locator('h1').first().textContent({ timeout: 1500 }).catch(() => ''));
  entry.notices = (await page.locator('.notice').allInnerTexts().catch(() => [])).map(clean);
  entry.scan = await page.evaluate(scanPage).catch((error) => ({ error: errorText(error) }));
  if (entry.scan?.error) report.scriptProblems.push({ step: n, problem: 'the scan could not run', error: entry.scan.error });
  try {
    entry.shots = await screens(page, base, entry);
  } catch (error) {
    report.scriptProblems.push({ step: n, problem: 'screenshots failed', error: errorText(error) });
  }
  writePrivate(join(OUT, entry.html), await page.content().catch(() => ''));
  report.steps.push(entry);
  return entry;
}

/** The top of the page and each further screen down to its end (at most MAX_SCREENS: the first ones and the end). */
async function screens(page, base, entry) {
  const size = await page.evaluate(() => ({ height: window.innerHeight, total: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0) }));
  const count = Math.max(1, Math.ceil((size.total - 1) / size.height));
  let tops = [];
  for (let index = 0; index < count; index += 1) tops.push(Math.min(index * size.height, Math.max(0, size.total - size.height)));
  tops = [...new Set(tops)];
  if (tops.length > MAX_SCREENS) {
    entry.screensLeftOut = tops.length - MAX_SCREENS;
    tops = [...tops.slice(0, MAX_SCREENS - 1), tops.at(-1)];
  }
  entry.pageHeight = size.total;
  const shots = [];
  for (const [index, top] of tops.entries()) {
    await page.evaluate((y) => window.scrollTo(0, y), top);
    await sleep(80);
    const file = `shots/${base}-${index + 1}.png`;
    const shows = await page.evaluate(onScreen).catch(() => []);
    const scrollY = await page.evaluate(() => window.scrollY);
    await page.screenshot({ path: join(OUT, file) });
    chmodSync(join(OUT, file), 0o600);
    const where = tops.length === 1 ? 'the whole page' : index === 0 ? 'top of the page' : index === tops.length - 1 ? 'end of the page' : `screen ${index + 1} of ${tops.length}`;
    const shot = { file, step: `${entry.n} ${entry.id}`, viewport: entry.viewport, javascript: entry.javascript, scrollY, where, shows };
    shots.push(shot);
    report.screenshots.push(shot);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  return shots.map((shot) => shot.file);
}

function check(entry, name, ok, detail = '') {
  const result = { name, ok: Boolean(ok) };
  if (detail !== '' && detail !== undefined && detail !== null) result.detail = redact(String(detail)).slice(0, 500);
  entry.checks.push(result);
  if (!ok) {
    report.functionalFailures.push({
      step: `${entry.n} ${entry.id}`,
      phase: entry.phase,
      viewport: entry.viewport,
      javascript: entry.javascript,
      check: name,
      detail: result.detail ?? '',
      url: entry.url,
      reproduce: reproduceFor(entry)
    });
  }
}

function reproduceFor(entry) {
  const phone = phones[entry.actor];
  const trail = phone ? phone.trail.slice(-10) : [];
  return [
    `On a fresh preview database (node scripts/preview-db.mjs reset), run the steps before this one (report.json steps 1-${entry.n - 1}); then, as ${entry.actor} (${entry.viewport}, JavaScript ${entry.javascript ? 'on' : 'off'}):`,
    ...trail.map((line) => redact(line))
  ];
}

function notExercised(id, title, why) {
  report.notExercised.push({ phase, id, title, why });
}

/** Marks what a step expected: its own 4xx answer and the console line Chrome writes for it, a download's aborted load. */
function classify(entry, options) {
  for (const line of entry.consoleErrors) {
    const status = /status of (\d{3})/.exec(line.text)?.[1];
    if (status && options.expectStatus && Number(status) === options.expectStatus) line.expected = `the step's own ${status} answer`;
  }
  for (const failed of entry.failedRequests) {
    if (failed.error === 'net::ERR_ABORTED' && (options.download || options.aborts)) failed.expected = options.download ? 'a navigation that became a download' : options.aborts;
  }
  for (const error of entry.httpErrors) {
    if (error.document && options.expectStatus === error.status) error.expected = "the step's own answer";
  }
}

async function count(locator) {
  return locator.count().catch(() => -1);
}

async function textIn(scope, selector) {
  return clean(await scope.locator(selector).first().innerText({ timeout: 3000 }).catch(() => ''));
}

async function mainText(page) {
  return clean(await page.locator('main').innerText({ timeout: 3000 }).catch(() => ''));
}

function navLink(page, name) {
  return page.locator('nav.top').getByRole('link', { name, exact: true });
}

function mainButton(page, name) {
  return page.locator('main').getByRole('button', { name, exact: true });
}

function mainLink(page, name) {
  return page.locator('main').getByRole('link', { name, exact: true });
}

function dateSection(page, iso) {
  return page.locator('section.date').filter({ has: page.locator('.when .day', { hasText: exact(longDate(iso)) }) });
}

function slotOn(page, iso, label) {
  return dateSection(page, iso).locator('li.slot').filter({ has: page.locator('.slot-name', { hasText: exact(label) }) });
}

/** One person's line on the organizer's sheet page, under a date. */
function personLine(page, iso, name) {
  return dateSection(page, iso).locator('ul.rows > li').filter({ has: page.locator('a.name', { hasText: exact(name) }) });
}

/** A date's changes are folded under its "Change this date" button: this opens them (once). */
async function openDateMenu(phone, page, iso) {
  const menu = dateSection(page, iso).locator(':scope > details.manage');
  if (await menu.evaluate((element) => element.open).catch(() => false)) return;
  await phone.tap(menu.locator(':scope > summary'), `Tap "${W.changeDate}" under ${shortDate(iso)}`);
}

/** One of a date's changes, in its menu (openDateMenu first). */
function dateAction(page, iso, name) {
  return dateSection(page, iso).locator(':scope > details.manage .menu').getByRole('link', { name, exact: true });
}

/** The sheet's status, as the tag under its title says it. */
async function statusTag(page) {
  return textIn(page, 'main > p.person-line .tag');
}

function rosterLink(page, name) {
  return page.locator('main ul.rows').getByRole('link', { name, exact: true });
}

function sheetLink(page, title) {
  return page.locator('#sheets').getByRole('link', { name: title, exact: true });
}

/** The public sheet's places with their claim addresses: `<iso>|<label>` → slot id. */
async function learnSlots(page) {
  const found = await page.evaluate(() =>
    [...document.querySelectorAll('section.date')].flatMap((section) => {
      const day = section.querySelector('.when .day')?.textContent?.trim() ?? '';
      return [...section.querySelectorAll('li.slot')].map((slot) => ({
        day,
        label: slot.querySelector('.slot-name')?.textContent?.trim() ?? '',
        href: slot.querySelector('a.take')?.getAttribute('href') ?? ''
      }));
    })
  );
  const isoByDay = new Map([...DATES, WEEK_DATE, ...BULK_DAYS].map((iso) => [longDate(iso), iso]));
  for (const item of found) {
    const id = /\/slots\/(\d+)$/.exec(item.href)?.[1];
    const iso = isoByDay.get(item.day);
    if (id && iso) S.slots[`${iso}|${item.label}`] = id;
  }
}

/**
 * The page's WhatsApp, Text and Email links (TOFU.md, Share texts): words encoded with %20, never +; one number or
 * address before the query (several people only in bcc). Opening them in the apps is not something a browser can show.
 */
async function shareLinkChecks(entry, page) {
  const hrefs = await page
    .locator('main a[href^="sms:"], main a[href^="mailto:"], main a[href^="https://wa.me/"]')
    .evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? ''))
    .catch(() => []);
  const bad = hrefs.filter((href) => {
    const [target, query = ''] = href.split('?');
    const recipients = target.replace(/^(sms:|mailto:|https:\/\/wa\.me\/)/, '');
    return query.includes('+') || /\s/.test(href) || /[,;]/.test(recipients);
  });
  check(entry, `its ${hrefs.length} message links: %20 never +, one recipient before any bcc`, hrefs.length > 0 && bad.length === 0, bad.slice(0, 3).join(' | ') || `${hrefs.length} links`);
}

/** A calendar file's lines with folding undone. */
function icsLines(text) {
  return text.replace(/\r\n[ \t]/g, '').split('\r\n');
}

function icsChecks(entry, file, summary) {
  const text = file.text;
  check(entry, 'the answer is a calendar file', text.startsWith('BEGIN:VCALENDAR\r\n') && text.trimEnd().endsWith('END:VCALENDAR'), text.slice(0, 40));
  check(entry, 'every line ends in CRLF', !/[^\r]\n/.test(text) && !/\r(?!\n)/.test(text));
  const physical = text.split('\r\n');
  const long = physical.filter((line) => Buffer.byteLength(line, 'utf8') > 75);
  check(entry, 'no line is longer than 75 octets', long.length === 0, long[0] ?? '');
  const lines = text.replace(/\r\n[ \t]/g, '').split('\r\n');
  check(entry, 'one event', lines.filter((line) => line === 'BEGIN:VEVENT').length === 1);
  check(entry, 'the event has a UID and a SEQUENCE', lines.some((line) => /^UID:\S+/.test(line)) && lines.some((line) => /^SEQUENCE:\d+$/.test(line)));
  check(entry, 'its summary is the place and the group', lines.includes(`SUMMARY:${summary}`), lines.find((line) => line.startsWith('SUMMARY')) ?? '');
  check(entry, 'a timed event in UTC', lines.some((line) => /^DTSTART:\d{8}T\d{6}Z$/.test(line)));
  check(entry, 'it asks for alarms', lines.filter((line) => line === 'BEGIN:VALARM').length >= 1);
  check(entry, 'it is not marked cancelled', !lines.includes('STATUS:CANCELLED'));
  check(entry, "it carries the person's own private link, labelled", lines.some((line) => line.startsWith('DESCRIPTION:') && TOKEN.test(line) && line.includes('your private link')));
}

// --- The flows -------------------------------------------------------------------------------------------------------------

async function organizerFlow() {
  phase = 'organizer';
  const org = await openPhone('organizer', { viewport: PHONE, ip: IP.organizer });
  const p = () => org.page;

  await step(org, 'setup-page', "The fresh copy's / : the setup page", async () => {
    await org.go('/');
  }, async (s) => {
    check(s, 'answers 200', s.status === 200, `status ${s.status}`);
    check(s, 'shows the setup heading', s.h1 === W.setupHeading, s.h1);
    check(s, 'has the Set up button', (await count(mainButton(p(), W.setupButton))) === 1);
  });

  await step(org, 'setup-pressed', 'Set up pressed: the empty dashboard', async () => {
    await org.tapAndLoad(mainButton(p(), W.setupButton), `Tap "${W.setupButton}"`);
  }, async (s) => {
    check(s, 'lands on /organizer', pathOf(p().url()) === '/organizer', s.url);
    check(s, 'answers 200', s.status === 200, `status ${s.status}`);
    check(s, 'shows the dashboard', s.h1 === W.dashboardHeading, s.h1);
    check(s, 'says there are no sheets yet', (await mainText(p())).includes(W.noSheets));
  });

  await step(org, 'import-page', 'The import page', async () => {
    await org.tapAndLoad(navLink(p(), W.nav.importExport), `Tap "${W.nav.importExport}" in the menu`);
  }, async (s) => {
    check(s, 'shows the import page', s.h1 === W.importHeading, s.h1);
    check(s, 'has the file box, Check and Import', (await count(p().locator('#import-json'))) === 1 && (await count(mainButton(p(), W.importCheck))) === 1 && (await count(mainButton(p(), W.importApply))) === 1);
  });

  await step(org, 'import-checked', 'examples/soccer.json pasted and checked', async () => {
    await org.paste(p().locator('#import-json'), SOCCER_TEXT, 'Paste examples/soccer.json into the box');
    await org.tapAndLoad(mainButton(p(), W.importCheck), `Tap "${W.importCheck}"`);
  }, async (s) => {
    check(s, 'answers 200', s.status === 200, `status ${s.status}`);
    check(s, 'says what the file would make', s.notices.some((notice) => notice.startsWith(W.wouldMake)), s.notices.join(' | '));
    check(s, 'keeps the file in the box', (await p().locator('#import-json').inputValue()).includes('"signup-sheet/1"'));
  });

  await step(org, 'imported', 'The file imported', async () => {
    await org.tapAndLoad(mainButton(p(), W.importApply), `Tap "${W.importApply}"`);
  }, async (s) => {
    check(s, 'answers 200', s.status === 200, `status ${s.status}`);
    check(s, 'says what it imported', s.notices.some((notice) => notice.startsWith(W.imported)), s.notices.join(' | '));
  });

  await step(org, 'import-pressed-again', 'Import it pressed again on the page it answered', async () => {
    await org.tapAndLoad(mainButton(p(), W.importApply), `Tap "${W.importApply}" again`);
  }, async (s) => {
    check(s, 'answers 409', s.status === 409, `status ${s.status}`);
    check(s, 'says the file was imported only once', (await mainText(p())).includes(W.importRepeated), s.notices.join(' | '));
  }, { expectStatus: 409 });

  await step(org, 'sheet-admin', "The sheet's admin page", async () => {
    await org.tapAndLoad(navLink(p(), W.nav.organizer), `Tap "${W.nav.organizer}"`);
    await org.tapAndLoad(sheetLink(p(), SHEET.title), `Tap the sheet "${SHEET.title}"`);
  }, async (s) => {
    check(s, `opens /organizer/sheets/${SHEET.slug}`, pathOf(p().url()) === `/organizer/sheets/${SHEET.slug}`, s.url);
    check(s, 'shows the sheet', s.h1 === SHEET.title, s.h1);
    check(s, 'it is a draft', (await statusTag(p())) === 'Draft');
    check(s, 'Open for sign-ups is the main button', (await textIn(p(), '#status button.primary')) === W.makeOpen);
    check(s, 'every date of the file is on it', (await count(p().locator('#dates section.date'))) === DATES.length);
  });

  await step(org, 'sheet-opened', 'The sheet opened for sign-ups', async () => {
    await org.tapAndLoad(mainButton(p(), W.makeOpen), `Tap "${W.makeOpen}"`);
  }, async (s) => {
    check(s, 'says Saved.', s.notices.includes(W.saved), s.notices.join(' | '));
    check(s, 'its status reads Open', (await statusTag(p())) === 'Open');
    check(s, 'offers the group invite', (await count(p().locator('#share textarea#invite'))) === 1);
  });

  await step(org, 'dashboard-with-sheet', 'The dashboard with the sheet', async () => {
    await org.tapAndLoad(navLink(p(), W.nav.organizer), `Tap "${W.nav.organizer}"`);
  }, async (s) => {
    check(s, 'lists one sheet (the second Import it added nothing)', (await count(p().locator('#sheets .sheets-list > li'))) === 1);
    check(s, 'the sheet is Open', (await textIn(p(), '#sheets .sheets-list > li .tag')) === 'Open');
    check(s, 'has the group invite', (await count(p().locator('#invite textarea'))) === 1);
    const invite = await p().locator('#invite textarea').first().inputValue().catch(() => '');
    check(s, 'the invite carries the public link only', invite.includes(`/s/${SHEET.slug}`) && !TOKEN.test(invite), invite);
    await shareLinkChecks(s, p());
  });
}

async function membersFlow() {
  phase = 'members';
  const frank = await openPhone('frank', { viewport: PHONE, ip: IP.frank });
  const mike = await openPhone('mike', { viewport: PHONE, ip: IP.mike });
  const day = CLAIM_DATE;

  await step(frank, 'home-sheet-in-place', 'Frank opens / : the sheet in place', async () => {
    await frank.go('/');
  }, async (s) => {
    check(s, 'answers 200 at / (no redirect)', s.status === 200 && pathOf(frank.page.url()) === '/' && s.documents.length === 1, s.documents.join(', '));
    check(s, 'shows the sheet', s.h1 === SHEET.title, s.h1);
    const canonical = await frank.page.locator('link[rel="canonical"]').getAttribute('href').catch(() => null);
    check(s, "names the sheet's own address as canonical", Boolean(canonical?.endsWith(`/s/${SHEET.slug}`)), canonical ?? 'none');
    const lead = await textIn(frank.page, '.lead');
    check(s, 'the first box offers the next open place', lead.includes(`Next open place: ${SLOT}, ${shortDate(day)}`), lead);
    await learnSlots(frank.page);
    check(s, 'every place has a claim address', Boolean(S.slots[`${day}|${SLOT}`] && S.slots[`${DATES[3]}|${SLOT}`]), JSON.stringify(S.slots));
  });

  await step(frank, 'claim-form', `Frank taps Take it on ${shortDate(day)}`, async () => {
    await frank.tapAndLoad(slotOn(frank.page, day, SLOT).locator('a.take'), `Tap "${W.takeIt}" under ${longDate(day)}`);
  }, async (s) => {
    check(s, 'opens the claim form', pathOf(frank.page.url()) === `/s/${SHEET.slug}/slots/${S.slots[`${day}|${SLOT}`]}` && s.h1 === SLOT, `${s.url} ${s.h1}`);
    check(s, 'says one place left', (await textIn(frank.page, 'main p.count')) === '1 place left');
    check(s, 'the fields have labels', (await count(frank.page.getByLabel('Your name'))) === 1);
  });

  await step(frank, 'after-claim', 'Frank signs up: the after-claim panel', async () => {
    await frank.type(frank.page.locator('#new-name'), NAMES.frank, `Type the name "${NAMES.frank}"`);
    await frank.type(frank.page.locator('#new-contact'), CONTACT, `Type the contact ${CONTACT}`);
    await frank.type(frank.page.locator('#new-note'), 'Bringing oranges', 'Type the note "Bringing oranges"');
    await frank.tapAndLoad(mainButton(frank.page, W.signUp), `Tap "${W.signUp}"`);
  }, async (s) => {
    S.frankSignup = /^\/me\?new=(\d+)$/.exec(pathAndQuery(frank.page.url()))?.[1];
    check(s, 'a 303 to /me?new=<id>, then 200', Boolean(S.frankSignup) && s.status === 200 && s.documents[0]?.endsWith(' 303'), s.documents.join(', '));
    check(s, "says you're in", (await textIn(frank.page, '.done-line')) === W.confirmedNew(SLOT, shortDate(day)));
    check(s, 'offers Add to my calendar first', (await textIn(frank.page, '.after .actions')).startsWith(W.addCalendar));
    const link = await frank.page.locator('#my-link').inputValue().catch(() => '');
    check(s, 'shows the private link', TOKEN.test(link), redact(link));
    check(s, 'the address bar holds no link', !TOKEN.test(frank.page.url()));
    check(s, 'the title names nobody', (await frank.page.title()) === W.myPage);
    check(s, 'the page script ran: Copy link shows', (await count(frank.page.locator('#link button[data-copy]:visible'))) === 1);
    await shareLinkChecks(s, frank.page);
  });

  await step(frank, 'me-page', "Frank's private page /me", async () => {
    await frank.tapAndLoad(navLink(frank.page, W.nav.mine), `Tap "${W.nav.mine}" in the menu`);
  }, async (s) => {
    check(s, 'opens /me', pathAndQuery(frank.page.url()) === '/me', s.url);
    check(s, 'lists the sign-up as Confirmed', (await textIn(frank.page, `#s${S.frankSignup}`)).includes(W.confirmed));
    check(s, 'shows his own contact', (await frank.page.locator('#f-contact').inputValue().catch(() => '')) === CONTACT);
    check(s, 'shows his private link', TOKEN.test(await frank.page.locator('#my-link').inputValue().catch(() => '')));
  });

  await step(mike, 'sheet-date-full', `Mike opens / : ${shortDate(day)} is full`, async () => {
    await mike.go('/');
  }, async (s) => {
    const slot = slotOn(mike.page, day, SLOT);
    check(s, 'the place reads 1 of 1 taken', (await textIn(slot, '.count')) === '1 of 1 taken');
    const people = await textIn(slot, '.people');
    check(s, "shows Frank's name and note", people.includes(NAMES.frank) && people.includes('Bringing oranges'), people);
    check(s, 'offers Join the waitlist', (await textIn(slot, 'a.take')).startsWith(W.joinWaitlist));
    check(s, "no contact on the public page", !(await mike.page.content()).includes(CONTACT));
  });

  await step(mike, 'claim-form-full', 'Mike taps Join the waitlist', async () => {
    await mike.tapAndLoad(slotOn(mike.page, day, SLOT).locator('a.take'), `Tap "${W.joinWaitlist}" under ${longDate(day)}`);
  }, async (s) => {
    check(s, 'says the place is full', (await mainText(mike.page)).includes(W.full));
    check(s, "the button says he'd be #1", (await count(mainButton(mike.page, W.joinWaitlistButton(1)))) === 1);
  });

  await step(mike, 'waitlist-panel', 'Mike joins the waitlist: #1', async () => {
    await mike.type(mike.page.locator('#new-name'), NAMES.mike, `Type the name "${NAMES.mike}"`);
    await mike.type(mike.page.locator('#new-contact'), CONTACT, `Type the contact ${CONTACT}`);
    await mike.tapAndLoad(mainButton(mike.page, W.joinWaitlistButton(1)), `Tap "${W.joinWaitlistButton(1)}"`);
  }, async (s) => {
    S.mikeSignup = /^\/me\?new=(\d+)$/.exec(pathAndQuery(mike.page.url()))?.[1];
    check(s, 'lands on /me?new=<id>', Boolean(S.mikeSignup), s.url);
    check(s, 'says waitlist #1', (await textIn(mike.page, '.done-line')) === W.waitingNew(1));
    check(s, 'no calendar button for a waiting place', (await count(mike.page.getByRole('link', { name: W.addCalendar, exact: true }))) === 0);
  });

  await step(frank, 'cancel-confirm', 'Frank taps Cancel: the confirm page', async () => {
    await frank.tapAndLoad(frank.page.locator(`#s${S.frankSignup}`).getByRole('link', { name: W.cancel, exact: true }), 'Tap "Cancel" on his sign-up');
  }, async (s) => {
    check(s, 'asks the question', s.h1 === W.cancelQuestion(SLOT, shortDate(day)), s.h1);
    check(s, 'offers Yes, cancel and Keep it', (await count(mainButton(frank.page, W.yesCancel))) === 1 && (await count(mainLink(frank.page, W.keepIt))) === 1);
    check(s, 'offers the ask-to-swap message', (await count(frank.page.locator('textarea#swap'))) === 1);
    await shareLinkChecks(s, frank.page);
  });

  await step(frank, 'cancelled', 'Frank taps Yes, cancel: the page after', async () => {
    await frank.tapAndLoad(mainButton(frank.page, W.yesCancel), `Tap "${W.yesCancel}"`);
  }, async (s) => {
    check(s, 'lands on /me?cancelled=1&up=1&sheet=<slug>', pathAndQuery(frank.page.url()) === `/me?cancelled=1&up=1&sheet=${SHEET.slug}`, s.url);
    check(s, 'says Mike moved up into the place', s.notices.some((notice) => notice.startsWith(W.cancelledUp)), s.notices.join(' | '));
    check(s, 'offers the sheet again to pick another date', (await count(mainLink(frank.page, W.pickAnother))) === 1);
    check(s, 'he has no sign-ups left', (await mainText(frank.page)).includes(W.noSignups));
  });

  await step(mike, 'moved-up', "Mike's /me : he moved up", async () => {
    await mike.tapAndLoad(navLink(mike.page, W.nav.mine), `Tap "${W.nav.mine}" in the menu`);
  }, async (s) => {
    const item = await textIn(mike.page, `#s${S.mikeSignup}`);
    check(s, 'his place is Confirmed', item.includes(W.confirmed), item);
    check(s, 'says he moved up from the waitlist', item.includes(W.movedUpOn), item);
    check(s, 'now offers Add to my calendar', (await count(mike.page.locator(`#s${S.mikeSignup}`).getByRole('link', { name: W.addCalendar, exact: true }))) === 1);
  });

  let file = null;
  await step(mike, 'calendar-file', "Mike's calendar button answers a calendar file", async () => {
    file = await mike.download(mike.page.locator(`#s${S.mikeSignup}`).getByRole('link', { name: W.addCalendar, exact: true }), `Tap "${W.addCalendar}"`);
  }, async (s) => {
    s.download = file && { file: file.file, suggested: file.suggested, bytes: file.bytes };
    check(s, 'the download finished', file && !file.failure, file?.failure ?? 'no file');
    check(s, 'saved as an .ics file', /\.ics$/.test(file?.suggested ?? ''), file?.suggested);
    if (file) {
      icsChecks(s, file, `${SLOT} · ${SOCCER.group.name}`);
      const lines = icsLines(file.text);
      S.firstIcs = { uid: lines.find((line) => line.startsWith('UID:')), sequence: Number(lines.find((line) => line.startsWith('SEQUENCE:'))?.slice(9)) };
    }
  }, { download: true });
}

async function organizerAgainFlow() {
  phase = 'organizer again';
  const org = phones.organizer;
  if (!org) return notExercised('organizer-again', 'The organizer pages after the members', 'the organizer could not be opened');
  const p = () => org.page;
  const day = CLAIM_DATE;
  const movedUp = () => p().locator('#attention li').filter({ has: p().locator('.name', { hasText: exact(W.movedUpItem(NAMES.mike)) }) });

  await step(org, 'attention-moved-up', 'Needs attention lists the moved-up person', async () => {
    await org.tapAndLoad(navLink(p(), W.nav.organizer), `Tap "${W.nav.organizer}"`);
  }, async (s) => {
    check(s, `lists "${W.movedUpItem(NAMES.mike)}"`, (await count(movedUp())) === 1, await textIn(p(), '#attention'));
    check(s, 'with Told them', (await count(movedUp().getByRole('button', { name: W.toldThem, exact: true }))) === 1);
    check(s, 'with a message to his own contact', (await count(movedUp().getByRole('link', { name: 'Email', exact: true }))) === 1);
    await shareLinkChecks(s, p());
  });

  await step(org, 'told-them', 'Told them pressed', async () => {
    await org.tapAndLoad(movedUp().getByRole('button', { name: W.toldThem, exact: true }), `Tap "${W.toldThem}" next to ${NAMES.mike}`);
  }, async (s) => {
    check(s, `says "${W.toldDone(NAMES.mike)}"`, s.notices.some((notice) => notice.startsWith(W.toldDone(NAMES.mike))), s.notices.join(' | '));
    check(s, 'offers Undo', (await count(p().locator('.notice').getByRole('button', { name: W.undo, exact: true }))) === 1);
    check(s, 'he is no longer listed', (await count(movedUp())) === 0);
  });

  await step(org, 'told-undone', 'Undo pressed', async () => {
    await org.tapAndLoad(p().locator('.notice').getByRole('button', { name: W.undo, exact: true }), `Tap "${W.undo}"`);
  }, async (s) => {
    check(s, 'he is listed again', (await count(movedUp())) === 1, await textIn(p(), '#attention'));
  });

  await step(org, 'swap-page', `Swap: Mike's family on ${shortDate(DATES[0])} with whom`, async () => {
    await org.tapAndLoad(sheetLink(p(), SHEET.title), `Tap the sheet "${SHEET.title}"`);
    const line = personLine(p(), DATES[0], "Mike's family");
    await org.tap(line.locator('summary', { hasText: startsWith(W.change) }), `Tap "${W.change}" next to Mike's family on ${shortDate(DATES[0])}`);
    await org.tapAndLoad(line.getByRole('link', { name: W.swap, exact: true }), `Tap "${W.swap}"`);
  }, async (s) => {
    check(s, 'asks whom to swap with', s.h1 === `Swap Mike's family (${SLOT}, ${shortDate(DATES[0])}) with`, s.h1);
    check(s, "offers Frank's family", (await count(p().locator('label.choice', { hasText: "Frank's family" }))) === 1);
    check(s, 'the title names nobody', (await p().title()).startsWith('Swap places'));
  });

  await step(org, 'swapped', 'Swapped: who to tell', async () => {
    await org.tap(p().locator('label.choice', { hasText: "Frank's family" }), "Tap \"Frank's family\"");
    await org.tapAndLoad(mainButton(p(), W.swap), `Tap "${W.swap}"`);
  }, async (s) => {
    check(s, 'back on the sheet with both changed', /[?&]changed=\d+-\d+/.test(p().url()), s.url);
    const notice = await textIn(p(), '.notices');
    check(s, 'says Tell them about the change:', notice.includes(W.changedTell), notice);
    check(s, 'lists both people', notice.includes("Mike's family") && notice.includes("Frank's family"), notice);
    check(s, `Frank's family is now on ${shortDate(DATES[0])}`, (await count(personLine(p(), DATES[0], "Frank's family"))) === 1);
    check(s, `Mike's family is now on ${shortDate(DATES[1])}`, (await count(personLine(p(), DATES[1], "Mike's family"))) === 1);
    await shareLinkChecks(s, p());
  });

  await step(org, 'people', 'The people page', async () => {
    await org.tapAndLoad(navLink(p(), W.nav.people), `Tap "${W.nav.people}" in the menu`);
  }, async (s) => {
    const names = await p().locator('main ul.rows a.name').allInnerTexts();
    check(s, 'lists the four people', names.length === 4, names.join(', '));
    check(s, "Frank's family is not paid", (await textIn(p().locator('main ul.rows > li').filter({ has: p().locator('a.name', { hasText: exact("Frank's family") }) }), '.tag')) === W.notPaid);
  });

  await step(org, 'person', "Frank's family's page", async () => {
    await org.tapAndLoad(rosterLink(p(), "Frank's family"), "Tap \"Frank's family\"");
  }, async (s) => {
    check(s, 'shows the person', s.h1 === "Frank's family", s.h1);
    check(s, 'the title names nobody', (await p().title()).startsWith('Person'));
  });

  await step(org, 'marked-paid', "Frank's family marked paid", async () => {
    await org.tap(p().locator('label[for="f-paid"]'), 'Tap "Paid"');
    await org.type(p().locator('#f-amount'), '40.00', 'Type the amount 40.00');
    await org.type(p().locator('#f-note'), 'Cash at practice', 'Type the note "Cash at practice"');
    await org.tapAndLoad(mainButton(p(), W.savePaid), `Tap "${W.savePaid}"`);
  }, async (s) => {
    check(s, 'says Saved.', s.notices.includes(W.saved), s.notices.join(' | '));
    check(s, 'Paid stays ticked', await p().locator('#f-paid').isChecked().catch(() => false));
    check(s, 'the amount is kept', (await p().locator('#f-amount').inputValue().catch(() => '')) === '40.00');
  });

  await step(org, 'unpaid-only', 'The unpaid filter', async () => {
    await org.tapAndLoad(navLink(p(), W.nav.people), `Tap "${W.nav.people}" in the menu`);
    await org.tapAndLoad(mainLink(p(), W.showOnlyUnpaid), `Tap "${W.showOnlyUnpaid}"`);
  }, async (s) => {
    const names = await p().locator('main ul.rows a.name').allInnerTexts();
    check(s, 'shows only the unpaid people', names.includes(NAMES.frank) && names.includes(NAMES.mike) && !names.includes("Frank's family") && !names.includes("Mike's family"), names.join(', '));
  });

  await step(org, 'date-added', `One date added (${shortDate(WEEK_DATE)}, in the coming week)`, async () => {
    await org.tapAndLoad(navLink(p(), W.nav.organizer), `Tap "${W.nav.organizer}"`);
    await org.tapAndLoad(sheetLink(p(), SHEET.title), `Tap the sheet "${SHEET.title}"`);
    await org.pick(p().locator('#add-date'), WEEK_DATE, `Pick the date ${WEEK_DATE}`);
    await org.pick(p().locator('#add-start'), '09:00', 'Pick the start 09:00');
    await org.pick(p().locator('#add-end'), '10:30', 'Pick the end 10:30');
    await org.type(p().locator('#add-label'), 'Practice', 'Type the label "Practice"');
    if (!(await p().locator('#add-withSlots').isChecked())) await org.tap(p().locator('label[for="add-withSlots"]'), 'Tick "Give it the same places as the latest date"');
    await org.tapAndLoad(mainButton(p(), W.addDateButton), `Tap "${W.addDateButton}"`);
  }, async (s) => {
    check(s, 'says Saved.', s.notices.includes(W.saved), s.notices.join(' | '));
    check(s, `the date is on the sheet with ${SLOT}`, (await count(slotOn(p(), WEEK_DATE, SLOT))) === 1);
    check(s, "This week's reminder is now a link", (await count(p().locator('#share').getByRole('link', { name: W.weekReminder, exact: true }))) === 1);
  });

  await step(org, 'week-reminder', "This week's reminder page", async () => {
    await org.tapAndLoad(p().locator('#share').getByRole('link', { name: W.weekReminder, exact: true }), `Tap "${W.weekReminder}"`);
  }, async (s) => {
    check(s, 'shows the page', s.h1 === W.weekReminder, s.h1);
    const message = await p().locator('textarea#week').inputValue().catch(() => '');
    check(s, 'the message names the date in the coming week', message.includes(shortDate(WEEK_DATE)), message);
    check(s, 'the message carries the public link and no private one', message.includes(`/s/${SHEET.slug}`) && !TOKEN.test(message), message);
    await shareLinkChecks(s, p());
  });

  await step(org, 'add-someone-page', `Add someone to the full ${shortDate(DATES[0])}`, async () => {
    await org.tapAndLoad(mainLink(p(), W.backToSheet), `Tap "${W.backToSheet}"`);
    await org.tapAndLoad(slotOn(p(), DATES[0], SLOT).getByRole('link', { name: startsWith(W.addSomeone) }), `Tap "${W.addSomeone}" under ${shortDate(DATES[0])}`);
  }, async (s) => {
    check(s, 'says they join the waitlist as #1', (await mainText(p())).includes(W.addFull(1)));
  });

  await step(org, 'added-to-waitlist', 'Frank added to the waitlist', async () => {
    await org.choose(p().locator('#f-personId'), `${NAMES.frank} (${CONTACT})`, `Pick "${NAMES.frank} (${CONTACT})"`);
    await org.tapAndLoad(mainButton(p(), W.addThem), `Tap "${W.addThem}"`);
  }, async (s) => {
    check(s, 'says Added.', s.notices.includes(W.added), s.notices.join(' | '));
    check(s, 'Frank waits as #1', (await textIn(personLine(p(), DATES[0], NAMES.frank), '.person-line')).includes('Waiting #1'));
  });

  await step(org, 'waitlist-message', 'The waitlist message page', async () => {
    await org.tapAndLoad(p().locator('#share').getByRole('link', { name: W.messageWaitlist, exact: true }), `Tap "${W.messageWaitlist}"`);
  }, async (s) => {
    check(s, 'shows the page', s.h1 === W.messageWaitlist, s.h1);
    check(s, 'a message to everyone waiting', (await mainText(p())).includes(W.waitlistAll));
    check(s, 'a message to Frank', (await count(p().locator('main label', { hasText: exact(`To ${NAMES.frank}`) }))) === 1);
    await shareLinkChecks(s, p());
  });

  await step(org, 'weekly-preview', 'Add a date every week: the preview', async () => {
    await org.tapAndLoad(mainLink(p(), W.backToSheet), `Tap "${W.backToSheet}"`);
    await org.tapAndLoad(mainLink(p(), W.bulkLink), `Tap "${W.bulkLink}"`);
    await org.pick(p().locator('#f-from'), BULK_DAYS[0], `Pick the first date ${BULK_DAYS[0]}`);
    await org.pick(p().locator('#f-until'), BULK_DAYS[3], `Pick the last date ${BULK_DAYS[3]}`);
    await org.pick(p().locator('#f-start'), '09:00', 'Pick the start 09:00');
    await org.pick(p().locator('#f-end'), '10:30', 'Pick the end 10:30');
    await org.tapAndLoad(mainButton(p(), W.bulkPreview), `Tap "${W.bulkPreview}"`);
  }, async (s) => {
    check(s, 'lists the 4 dates', (await mainText(p())).includes(W.bulkWill(4)));
  });

  await step(org, 'weekly-added', 'Add a date every week: added', async () => {
    await org.tapAndLoad(mainButton(p(), W.bulkAdd(4)), `Tap "${W.bulkAdd(4)}"`);
  }, async (s) => {
    check(s, `says "${W.bulkAdded(4)}"`, s.notices.includes(W.bulkAdded(4)), s.notices.join(' | '));
    for (const day of BULK_DAYS) check(s, `${shortDate(day)} is on the sheet with ${SLOT}`, (await count(slotOn(p(), day, SLOT))) === 1);
  });

  await step(org, 'place-every-date', 'A place added to every date', async () => {
    await org.tap(p().locator('#add-slot summary'), `Tap "${W.addSlotEvery}"`);
    await org.type(p().locator('#every-label'), 'Bring water', 'Type the place name "Bring water"');
    await org.tapAndLoad(mainButton(p(), W.addEveryButton), `Tap "${W.addEveryButton}"`);
  }, async (s) => {
    check(s, 'says Saved.', s.notices.includes(W.saved), s.notices.join(' | '));
    const missing = [];
    for (const day of [WEEK_DATE, ...DATES, ...BULK_DAYS]) if ((await count(slotOn(p(), day, 'Bring water'))) !== 1) missing.push(day);
    check(s, 'every date ahead has Bring water', missing.length === 0, missing.join(', '));
  });

  await step(org, 'cancel-date-confirm', `Cancel ${shortDate(day)} (a rain-out): who to tell`, async () => {
    await openDateMenu(org, p(), day);
    await org.tapAndLoad(dateAction(p(), day, W.cancelDate), `Tap "${W.cancelDate}" under ${shortDate(day)}`);
  }, async (s) => {
    check(s, 'asks the question', s.h1 === W.cancelDateQuestion(`${shortDate(day)}, 9:00 AM`), s.h1);
    check(s, 'one person to tell', (await mainText(p())).includes(W.tellThese(1)));
    check(s, 'a message to Mike', (await count(p().locator('main label', { hasText: exact(`To ${NAMES.mike}`) }))) === 1);
    await shareLinkChecks(s, p());
  });

  await step(org, 'date-cancelled', `${shortDate(day)} cancelled: who to tell`, async () => {
    await org.tapAndLoad(mainButton(p(), W.yesCancelDate), `Tap "${W.yesCancelDate}"`);
  }, async (s) => {
    check(s, 'back on the sheet with cancelled=', /[?&]cancelled=\d+/.test(p().url()), s.url);
    check(s, 'says the date is cancelled and lists whom to tell', (await textIn(p(), '.notices')).includes(W.cancelledTell(shortDate(day))));
    check(s, 'the date shows Cancelled', (await textIn(dateSection(p(), day), '.when')).includes(W.cancelledTag));
    await shareLinkChecks(s, p());
  });

  // What a member sees while the date is cancelled.
  const mike = phones.mike;
  if (mike?.context) {
    await step(mike, 'cancelled-date-public', `While ${shortDate(day)} is cancelled: the public sheet`, async () => {
      await mike.tapAndLoad(navLink(mike.page, W.nav.home), `Tap "${W.nav.home}" in the menu`);
    }, async (s) => {
      const section = dateSection(mike.page, day);
      check(s, 'the date shows Cancelled', (await textIn(section, '.when')).includes(W.cancelledTag));
      check(s, 'nobody can take or join a place on it', (await count(section.locator('a.take'))) === 0);
    });
    let file = null;
    await step(mike, 'cancelled-date-me', `While ${shortDate(day)} is cancelled: Mike's /me and his calendar file`, async () => {
      await mike.tapAndLoad(navLink(mike.page, W.nav.mine), `Tap "${W.nav.mine}" in the menu`);
      file = await mike.download(mike.page.locator(`#s${S.mikeSignup}`).getByRole('link', { name: W.updateCalendar, exact: true }), `Tap "${W.updateCalendar}"`);
    }, async (s) => {
      const item = await textIn(mike.page, `#s${S.mikeSignup}`);
      check(s, 'says the date is cancelled', item.includes(W.meDateCancelled), item);
      check(s, 'no Cancel or Move on it', (await count(mike.page.locator(`#s${S.mikeSignup} .actions a.danger`))) === 0);
      const lines = icsLines(file?.text ?? '');
      check(s, 'the file marks the event cancelled, with no alarm', lines.includes('STATUS:CANCELLED') && !lines.includes('BEGIN:VALARM'));
      const sequence = Number(lines.find((line) => line.startsWith('SEQUENCE:'))?.slice(9));
      check(s, 'the same UID with a higher SEQUENCE than the first file', S.firstIcs && lines.includes(S.firstIcs.uid) && sequence > S.firstIcs.sequence, `first ${S.firstIcs?.sequence}, now ${sequence}`);
    }, { download: true });
  }

  await step(org, 'date-restored', `${shortDate(day)}: Undo the cancel`, async () => {
    await org.tapAndLoad(dateSection(p(), day).getByRole('button', { name: W.undoCancel, exact: true }), `Tap "${W.undoCancel}" under ${shortDate(day)}`);
  }, async (s) => {
    check(s, 'says Saved.', s.notices.includes(W.saved), s.notices.join(' | '));
    check(s, 'the date is no longer cancelled', !(await textIn(dateSection(p(), day), '.when')).includes(W.cancelledTag));
  });

  await step(org, 'settings', 'Settings', async () => {
    await org.tapAndLoad(navLink(p(), W.nav.settings), `Tap "${W.nav.settings}" in the menu`);
  }, async (s) => {
    check(s, 'shows Settings', s.h1 === W.settingsHeading, s.h1);
    check(s, "the group's name from the import", (await p().locator('#f-groupName').inputValue().catch(() => '')) === SOCCER.group.name);
  });

  await step(org, 'settings-saved', 'Settings saved', async () => {
    await org.tapAndLoad(mainButton(p(), W.save), `Tap "${W.save}"`);
  }, async (s) => {
    check(s, 'says Saved.', s.notices.includes(W.saved), s.notices.join(' | '));
  });

  // The dashboard's "Remind me each week" file.
  let reminder = null;
  await step(org, 'reminder-file', '"Remind me each week": the file (Thursday, 6:00 PM)', async () => {
    await org.tapAndLoad(navLink(p(), W.nav.organizer), `Tap "${W.nav.organizer}"`);
    reminder = await org.download(p().locator('#remind').getByRole('button', { name: W.remindButton, exact: true }), `Tap "${W.remindButton}" with the day and time it offers`);
  }, async (s) => {
    s.download = reminder && { file: reminder.file, suggested: reminder.suggested, bytes: reminder.bytes };
    const lines = icsLines(reminder?.text ?? '');
    check(s, 'the answer is a calendar file', (reminder?.text ?? '').startsWith('BEGIN:VCALENDAR\r\n'), reminder?.suggested);
    // The last date ahead is the last weekly one added (its deletion comes later).
    const rule = `RRULE:FREQ=WEEKLY;BYDAY=TH;UNTIL=${addDays(BULK_DAYS[3], 1).replace(/-/g, '')}T000000`;
    check(s, 'weekly on Thursdays, until the day after the last date', lines.includes(rule), lines.find((line) => line.startsWith('RRULE')) ?? 'no RRULE');
    check(s, 'its summary', lines.includes(`SUMMARY:${W.reminderSummary}`), lines.find((line) => line.startsWith('SUMMARY')) ?? '');
    check(s, 'no private link in it', !TOKEN.test(reminder?.text ?? ''));
  }, { download: true });

  await step(org, 'new-link-question', "Frank's family's first private link: the question", async () => {
    await org.tapAndLoad(navLink(p(), W.nav.people), `Tap "${W.nav.people}" in the menu`);
    await org.tapAndLoad(rosterLink(p(), "Frank's family"), "Tap \"Frank's family\"");
    await org.tapAndLoad(mainLink(p(), W.firstLink), `Tap "${W.firstLink}"`);
  }, async (s) => {
    check(s, 'asks the question (no old link to stop)', s.h1 === W.firstLinkQuestion("Frank's family"), s.h1);
  });

  await step(org, 'new-link-shown', 'The link, shown once', async () => {
    await org.tapAndLoad(mainButton(p(), W.firstLink), `Tap "${W.firstLink}"`);
  }, async (s) => {
    const link = await p().locator('#new-link').inputValue().catch(() => '');
    S.newLinkToken = TOKEN.exec(link)?.[0] ?? '';
    check(s, 'answers 200, the link in no address', s.status === 200 && !TOKEN.test(p().url()), s.documents.join(', '));
    check(s, "its heading names whose link it is, and the title names nobody", s.h1 === W.linkFor("Frank's family") && !(await p().title()).includes('Frank'), `${s.h1} | ${await p().title()}`);
    check(s, 'says it is shown once', (await mainText(p())).includes(W.firstLinkShown));
    check(s, 'shows a private link', Boolean(S.newLinkToken), redact(link));
    check(s, 'no contact: says to send it to them yourself, with the message to copy', (await mainText(p())).includes(W.newLinkNoContact) && (await count(p().locator('textarea#send-new-link'))) === 1);
    check(s, 'no Share button for this link (it goes to its own person only)', (await count(p().locator('[data-share-url], [data-share]'))) === 0);
    check(s, 'the organizer menu and a way back to the person', (await count(navLink(p(), W.nav.people))) === 1 && (await count(mainLink(p(), W.backToPerson("Frank's family")))) === 1);
  });

  await step(org, 'new-link-after', "Back to Frank's family: the person page without the link", async () => {
    await org.tapAndLoad(mainLink(p(), W.backToPerson("Frank's family")), `Tap "${W.backToPerson("Frank's family")}"`);
  }, async (s) => {
    check(s, 'says Link made …', (await mainText(p())).includes(W.linkMade));
    check(s, 'the link is not on the page', Boolean(S.newLinkToken) && !(await p().content()).includes(S.newLinkToken));
  });

  await step(org, 'remove-everywhere-question', "Remove Mike's family from every place: the confirmation", async () => {
    await org.tapAndLoad(navLink(p(), W.nav.people), `Tap "${W.nav.people}" in the menu`);
    await org.tapAndLoad(rosterLink(p(), "Mike's family"), "Tap \"Mike's family\"");
    await org.tapAndLoad(mainLink(p(), W.removeEverywhere), `Tap "${W.removeEverywhere}"`);
  }, async (s) => {
    check(s, 'asks the question', s.h1 === W.removeQuestion("Mike's family"), s.h1);
    check(s, 'lists the sign-up', (await textIn(p(), 'main ul.rows')).includes(SLOT), await textIn(p(), 'main ul.rows'));
    check(s, 'offers Yes, remove and Keep it', (await count(mainButton(p(), W.removeYes))) === 1 && (await count(mainLink(p(), W.keepIt))) === 1);
  });

  await step(org, 'delete-date-question', `Delete ${shortDate(DATES[1])}: the confirmation`, async () => {
    await org.tapAndLoad(mainLink(p(), W.keepIt), `Tap "${W.keepIt}"`);
    await org.tapAndLoad(navLink(p(), W.nav.organizer), `Tap "${W.nav.organizer}"`);
    await org.tapAndLoad(sheetLink(p(), SHEET.title), `Tap the sheet "${SHEET.title}"`);
    await openDateMenu(org, p(), DATES[1]);
    await org.tapAndLoad(dateAction(p(), DATES[1], W.deleteDate), `Tap "${W.deleteDate}" under ${shortDate(DATES[1])}`);
  }, async (s) => {
    check(s, 'asks the question', s.h1 === W.deleteDateQuestion(`${shortDate(DATES[1])}, 9:00 AM`), s.h1);
    check(s, 'one person to tell', (await mainText(p())).includes(W.tellThese(1)));
    check(s, 'offers Yes, delete and Keep it', (await count(mainButton(p(), W.yesDelete))) === 1 && (await count(mainLink(p(), W.keepIt))) === 1);
    check(s, 'offers to cancel the date instead', (await count(mainLink(p(), W.cancelDate))) === 1);
  });

  await step(org, 'delete-empty-date-question', `Delete ${shortDate(BULK_DAYS[3])} (nobody on it): the confirmation`, async () => {
    await org.tapAndLoad(mainLink(p(), W.keepIt), `Tap "${W.keepIt}"`);
    await openDateMenu(org, p(), BULK_DAYS[3]);
    await org.tapAndLoad(dateAction(p(), BULK_DAYS[3], W.deleteDate), `Tap "${W.deleteDate}" under ${shortDate(BULK_DAYS[3])}`);
  }, async (s) => {
    check(s, 'says nobody is signed up', (await mainText(p())).includes(W.nobodyHere));
  });

  await step(org, 'empty-date-deleted', 'The empty date deleted', async () => {
    await org.tapAndLoad(mainButton(p(), W.yesDelete), `Tap "${W.yesDelete}"`);
  }, async (s) => {
    check(s, 'says Deleted.', s.notices.includes(W.deleted), s.notices.join(' | '));
    check(s, 'the date is gone', (await count(dateSection(p(), BULK_DAYS[3]))) === 0);
    check(s, `${shortDate(DATES[1])} is still there`, (await count(dateSection(p(), DATES[1]))) === 1);
  });

  let exported = null;
  await step(org, 'export-json', 'The export file', async () => {
    await org.tapAndLoad(navLink(p(), W.nav.importExport), `Tap "${W.nav.importExport}" in the menu`);
    exported = await org.download(mainLink(p(), W.exportAll), `Tap "${W.exportAll}"`);
  }, async (s) => {
    s.download = exported && { file: exported.file, suggested: exported.suggested, bytes: exported.bytes };
    let data = null;
    try {
      data = JSON.parse(exported?.text ?? '');
    } catch {
      data = null;
    }
    check(s, 'the answer is a JSON file', data !== null && /\.json$/.test(exported?.suggested ?? ''), exported?.suggested);
    check(s, 'its format is signup-sheet/1', data?.format === 'signup-sheet/1', data?.format);
    check(s, 'one sheet, four people', data?.sheets?.length === 1 && data?.people?.length === 4, `${data?.sheets?.length} sheets, ${data?.people?.length} people`);
    check(s, 'no private link, token or hash in it', !TOKEN.test(exported?.text ?? '') && !hasKey(data, /token|hash/i));
  }, { download: true });

  let csv = null;
  await step(org, 'export-csv', 'The CSV answer', async () => {
    await org.tapAndLoad(navLink(p(), W.nav.organizer), `Tap "${W.nav.organizer}"`);
    await org.tapAndLoad(sheetLink(p(), SHEET.title), `Tap the sheet "${SHEET.title}"`);
    csv = await org.download(mainLink(p(), W.csv), `Tap "${W.csv}"`);
  }, async (s) => {
    s.download = csv && { file: csv.file, suggested: csv.suggested, bytes: csv.bytes };
    const text = csv?.text ?? '';
    check(s, 'saved as a .csv file', /\.csv$/.test(csv?.suggested ?? ''), csv?.suggested);
    check(s, 'starts with a byte order mark', text.startsWith('\uFEFF'));
    check(s, 'every line ends in CRLF', text.length > 0 && !/[^\r]\n/.test(text));
    check(s, 'the header row', text.slice(1).split('\r\n')[0] === W.csvHeader.map((name) => `"${name}"`).join(','), text.slice(1).split('\r\n')[0]);
    check(s, 'it has the sign-ups', text.includes("Frank's family") && text.includes(`"${NAMES.mike}"`));
    check(s, 'no private link in it', !TOKEN.test(text));
  }, { download: true });
}

async function widthsFlow() {
  phase = 'widths';
  const orgState = phones.organizer?.context ? await phones.organizer.context.storageState() : null;
  const mikeState = phones.mike?.context ? await phones.mike.context.storageState() : null;
  const claimSlot = S.slots[`${DATES[3]}|${SLOT}`];
  const pages = [
    { id: 'home', who: 'public', path: '/', title: '/ (the sheet in place)', h1: SHEET.title },
    { id: 'sheet', who: 'public', path: `/s/${SHEET.slug}`, title: 'The sheet', h1: SHEET.title },
    { id: 'claim-form', who: 'public', path: claimSlot ? `/s/${SHEET.slug}/slots/${claimSlot}` : null, title: `A claim form (${shortDate(DATES[3])})`, h1: SLOT },
    { id: 'after-claim', who: 'mike', path: S.mikeSignup ? `/me?new=${S.mikeSignup}` : null, title: "The after-claim panel (Mike's)", h1: W.myPage, done: W.confirmedNew(SLOT, shortDate(CLAIM_DATE)) },
    { id: 'me', who: 'mike', path: '/me', title: "/me (Mike's)", h1: W.myPage },
    { id: 'cancel-confirm', who: 'mike', path: S.mikeSignup ? `/me/signups/${S.mikeSignup}/cancel` : null, title: "The cancel confirm page (Mike's)", h1: W.cancelQuestion(SLOT, shortDate(CLAIM_DATE)) },
    { id: 'dashboard', who: 'organizer', path: '/organizer', title: 'The dashboard', h1: SOCCER.group.name },
    { id: 'sheet-admin', who: 'organizer', path: `/organizer/sheets/${SHEET.slug}`, title: "The sheet's admin page", h1: SHEET.title },
    { id: 'people', who: 'organizer', path: '/organizer/people', title: 'People', h1: 'People' },
    { id: 'import', who: 'organizer', path: '/organizer/import', title: 'Import', h1: W.importHeading },
    { id: 'week-reminder', who: 'organizer', path: `/organizer/sheets/${SHEET.slug}/share/week`, title: "This week's reminder", h1: W.weekReminder }
  ];
  for (const size of SIZES) {
    const viewport = { width: size.width, height: size.height };
    for (const who of ['public', 'mike', 'organizer']) {
      const state = who === 'mike' ? mikeState : who === 'organizer' ? orgState : null;
      if (who !== 'public' && !state) {
        for (const page of pages.filter((each) => each.who === who)) notExercised(`width-${page.id}`, `${page.title} at ${size.width}x${size.height}`, `no ${who} cookies to reuse`);
        continue;
      }
      const phone = await openPhone(`${who}@${size.width}x${size.height}`, {
        viewport,
        mobile: size.mobile,
        touch: size.touch,
        ip: who === 'organizer' ? IP.organizer : who === 'mike' ? IP.mike : IP.public,
        ...(state ? { storageState: state } : {})
      });
      for (const page of pages.filter((each) => each.who === who)) {
        if (!page.path) {
          notExercised(`width-${page.id}`, `${page.title} at ${size.width}x${size.height}`, 'the flow before it did not give its address');
          continue;
        }
        await step(phone, `width-${page.id}`, `${page.title} at ${size.width}x${size.height}`, async () => {
          await phone.go(page.path);
        }, async (s) => {
          check(s, 'answers 200', s.status === 200, `status ${s.status}`);
          check(s, 'shows the page', s.h1 === page.h1, s.h1);
          if (page.done) check(s, 'the after-claim line', (await textIn(phone.page, '.done-line')) === page.done);
        });
      }
      await phone.close();
    }
  }
}

async function noScriptFlow() {
  phase = 'javascript off';
  const member = await openPhone('member (no JavaScript)', { viewport: PHONE, js: false, ip: IP.noScript });
  const day = DATES[3];

  await step(member, 'nojs-home', 'JavaScript off: a member opens /', async () => {
    await member.go('/');
  }, async (s) => {
    check(s, 'shows the sheet', s.h1 === SHEET.title, s.h1);
    check(s, 'the page script did not run', !(await member.page.evaluate(() => document.documentElement.classList.contains('js'))));
  });

  await step(member, 'nojs-claim-form', `JavaScript off: Take it on ${shortDate(day)}`, async () => {
    await member.tapAndLoad(slotOn(member.page, day, SLOT).locator('a.take'), `Tap "${W.takeIt}" under ${longDate(day)}`);
  }, async (s) => {
    check(s, 'opens the claim form', s.h1 === SLOT, s.h1);
  });

  await step(member, 'nojs-after-claim', 'JavaScript off: signed up', async () => {
    await member.type(member.page.locator('#new-name'), NAMES.noScript, `Type the name "${NAMES.noScript}"`);
    await member.type(member.page.locator('#new-contact'), CONTACT, `Type the contact ${CONTACT}`);
    await member.type(member.page.locator('#new-note'), 'Juice boxes', 'Type the note "Juice boxes"');
    await member.tapAndLoad(mainButton(member.page, W.signUp), `Tap "${W.signUp}"`);
  }, async (s) => {
    S.noScriptSignup = /^\/me\?new=(\d+)$/.exec(pathAndQuery(member.page.url()))?.[1];
    check(s, 'lands on /me?new=<id>', Boolean(S.noScriptSignup), s.url);
    check(s, "says you're in", (await textIn(member.page, '.done-line')) === W.confirmedNew(SLOT, shortDate(day)));
    S.noScriptLink = await member.page.locator('#my-link').inputValue().catch(() => '');
    check(s, 'shows the private link', TOKEN.test(S.noScriptLink), redact(S.noScriptLink));
    check(s, 'the Copy button stays hidden without the script', (await count(member.page.locator('button[data-copy]:visible'))) === 0);
  });

  const other = await openPhone('member (no JavaScript, another phone)', { viewport: PHONE, js: false, ip: IP.noScriptLink });
  if (!S.noScriptLink) {
    notExercised('nojs-private-link', 'JavaScript off: the private link opened', 'the sign-up gave no link');
  } else {
    await step(other, 'nojs-private-link', 'JavaScript off: the private link opened on another phone', async () => {
      await other.go(S.noScriptLink);
    }, async (s) => {
      check(s, 'a 303 to /me', s.documents[0]?.endsWith(' 303') && pathAndQuery(other.page.url()) === '/me', s.documents.join(', '));
      check(s, 'the address bar holds no link', !TOKEN.test(other.page.url()));
      check(s, 'shows the sign-up', (await textIn(other.page, `#s${S.noScriptSignup}`)).includes(W.confirmed));
    });

    await step(other, 'nojs-cancel-confirm', 'JavaScript off: Cancel, the confirm page', async () => {
      await other.tapAndLoad(other.page.locator(`#s${S.noScriptSignup}`).getByRole('link', { name: W.cancel, exact: true }), 'Tap "Cancel"');
    }, async (s) => {
      check(s, 'asks the question', s.h1 === W.cancelQuestion(SLOT, shortDate(day)), s.h1);
    });

    await step(other, 'nojs-cancelled', 'JavaScript off: cancelled', async () => {
      await other.tapAndLoad(mainButton(other.page, W.yesCancel), `Tap "${W.yesCancel}"`);
    }, async (s) => {
      check(s, 'lands on /me?cancelled=1&sheet=<slug>', pathAndQuery(other.page.url()) === `/me?cancelled=1&sheet=${SHEET.slug}`, s.url);
      check(s, 'says Cancelled.', s.notices.some((notice) => notice.startsWith(W.cancelledDone)), s.notices.join(' | '));
    });
  }

  const orgState = phones.organizer?.context ? await phones.organizer.context.storageState() : null;
  if (!orgState) {
    notExercised('nojs-organizer', 'JavaScript off: the organizer removes someone', 'no organizer cookies to reuse');
  } else {
    const org = await openPhone('organizer (no JavaScript)', { viewport: PHONE, js: false, ip: IP.organizer, storageState: orgState });
    await step(org, 'nojs-organizer-sheet', "JavaScript off: the organizer's sheet page", async () => {
      await org.go(`/organizer/sheets/${SHEET.slug}`);
    }, async (s) => {
      check(s, 'shows the sheet', s.h1 === SHEET.title, s.h1);
    });

    await step(org, 'nojs-organizer-remove-question', `JavaScript off: Remove Frank's family from ${shortDate(DATES[0])}: the question`, async () => {
      const line = personLine(org.page, DATES[0], "Frank's family");
      await org.tap(line.locator('summary', { hasText: startsWith(W.change) }), `Tap "${W.change}" next to Frank's family on ${shortDate(DATES[0])}`);
      await org.tapAndLoad(line.getByRole('link', { name: W.remove, exact: true }), `Tap "${W.remove}"`);
    }, async (s) => {
      check(s, 'asks the question first (a tap removes nobody)', s.h1 === W.removeOneQuestion("Frank's family", SLOT, shortDate(DATES[0])), s.h1);
      check(s, 'offers Yes, remove and Keep it', (await count(mainButton(org.page, W.removeYes))) === 1 && (await count(mainLink(org.page, W.keepIt))) === 1);
    });

    await step(org, 'nojs-organizer-removed', `JavaScript off: the organizer removes Frank's family from ${shortDate(DATES[0])}`, async () => {
      await org.tapAndLoad(mainButton(org.page, W.removeYes), `Tap "${W.removeYes}"`);
    }, async (s) => {
      check(s, `says "${W.removedOneUp}"`, s.notices.includes(W.removedOneUp), s.notices.join(' | '));
      check(s, "Frank's family is off the date", (await count(personLine(org.page, DATES[0], "Frank's family"))) === 0);
      const frank = await textIn(personLine(org.page, DATES[0], NAMES.frank), '.person-line');
      check(s, 'Frank moved up and is to be told', frank.includes('Moved up: tell them') && !frank.includes('Waiting'), frank);
    });
    await org.close();
  }

  // A double tap with JavaScript off sends the form twice; it must sign up once.
  const twice = await openPhone('member (no JavaScript, double tap)', { viewport: PHONE, js: false, ip: IP.noScriptDouble });
  await step(twice, 'nojs-double-tap', 'JavaScript off: a double tap on Sign up', async () => {
    await twice.go('/');
    await twice.tapAndLoad(slotOn(twice.page, day, 'Bring water').locator('a.take'), `Tap "${W.takeIt}" for Bring water under ${longDate(day)}`);
    await twice.type(twice.page.locator('#new-name'), NAMES.noScriptDouble, `Type the name "${NAMES.noScriptDouble}"`);
    const button = mainButton(twice.page, W.signUp);
    await button.scrollIntoViewIfNeeded();
    const box = await button.boundingBox();
    twice.say(`Double-tap "${W.signUp}"`);
    await twice.loading(async () => {
      await twice.page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      await sleep(60);
      await twice.page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
    });
    await sleep(800);
  }, async (s) => {
    s.note = `${s.posts} POST(s) sent`;
    check(s, 'lands on /me?new=<id>', /^\/me\?new=\d+$/.test(pathAndQuery(twice.page.url())), s.url);
  }, { aborts: 'the first of two form posts, replaced by the second' });

  await step(twice, 'nojs-double-tap-sheet', 'JavaScript off: after the double tap, the sheet shows one sign-up', async () => {
    await twice.go(`/s/${SHEET.slug}`);
  }, async (s) => {
    const people = await slotOn(twice.page, day, 'Bring water').locator('.people li').allInnerTexts();
    check(s, `${NAMES.noScriptDouble} is on the sheet once`, people.filter((line) => line.startsWith(NAMES.noScriptDouble)).length === 1, people.join(' | '));
  });
  await member.close();
  await other.close();
  await twice.close();
}

async function edgeFlow() {
  phase = 'edge cases';
  let n = 0;
  /** A new phone signs up for a place with JavaScript on; the last step is the page the form answered. */
  const claimOn = async (phone, day, label, values) => {
    await phone.go('/');
    await phone.tapAndLoad(slotOn(phone.page, day, label).locator('a.take'), `Tap "${W.takeIt}" for ${label} under ${longDate(day)}`);
    await phone.type(phone.page.locator('#new-name'), values.name, `Type the name "${values.name}"`);
    if (values.contact) await phone.type(phone.page.locator('#new-contact'), values.contact, `Type the contact ${values.contact}`);
    if (values.note) await phone.type(phone.page.locator('#new-note'), values.note, `Type the note "${values.note}"`);
  };

  // An 80-character name.
  const long = await openPhone('member (80-character name)', { viewport: PHONE, ip: IP.edge(++n) });
  await step(long, 'long-name', 'An 80-character name: signed up', async () => {
    await claimOn(long, DATES[4], SLOT, { name: NAMES.long, contact: CONTACT, note: 'Long name check' });
    await long.tapAndLoad(mainButton(long.page, W.signUp), `Tap "${W.signUp}"`);
  }, async (s) => {
    check(s, 'lands on /me?new=<id>', /^\/me\?new=\d+$/.test(pathAndQuery(long.page.url())), s.url);
    check(s, 'the whole name is kept', (await long.page.locator('#f-name').inputValue().catch(() => '')) === NAMES.long);
  });
  await step(long, 'long-name-sheet', 'An 80-character name on the public sheet', async () => {
    await long.tapAndLoad(navLink(long.page, W.nav.home), `Tap "${W.nav.home}" in the menu`);
  }, async (s) => {
    check(s, 'the name shows in full', (await textIn(slotOn(long.page, DATES[4], SLOT), '.people')).includes(NAMES.long));
  });

  // A name with an emoji.
  const emoji = await openPhone('member (emoji name)', { viewport: PHONE, ip: IP.edge(++n) });
  await step(emoji, 'emoji-name', 'A name with an emoji: signed up', async () => {
    await claimOn(emoji, DATES[5], SLOT, { name: NAMES.emoji, note: 'Water bottles' });
    await emoji.tapAndLoad(mainButton(emoji.page, W.signUp), `Tap "${W.signUp}"`);
  }, async (s) => {
    check(s, 'lands on /me?new=<id>', /^\/me\?new=\d+$/.test(pathAndQuery(emoji.page.url())), s.url);
    check(s, 'the name with its emoji is kept', (await emoji.page.locator('#f-name').inputValue().catch(() => '')) === NAMES.emoji);
  });
  await step(emoji, 'emoji-name-sheet', 'A name with an emoji on the public sheet', async () => {
    await emoji.tapAndLoad(navLink(emoji.page, W.nav.home), `Tap "${W.nav.home}" in the menu`);
  }, async (s) => {
    check(s, 'the name shows with its emoji', (await textIn(slotOn(emoji.page, DATES[5], SLOT), '.people')).includes(NAMES.emoji));
  });

  // Markup in a note.
  const markup = await openPhone('member (markup note)', { viewport: PHONE, ip: IP.edge(++n) });
  await step(markup, 'markup-note', 'Markup in a note: signed up', async () => {
    await claimOn(markup, DATES[6], SLOT, { name: NAMES.markup, note: '<b>x</b>' });
    await markup.tapAndLoad(mainButton(markup.page, W.signUp), `Tap "${W.signUp}"`);
  }, async (s) => {
    check(s, 'lands on /me?new=<id>', /^\/me\?new=\d+$/.test(pathAndQuery(markup.page.url())), s.url);
    check(s, 'its own page shows the note as text', (await mainText(markup.page)).includes('<b>x</b>') && (await count(markup.page.locator('main b'))) === 0);
  });
  await step(markup, 'markup-note-sheet', 'Markup in a note on the public sheet', async () => {
    await markup.tapAndLoad(navLink(markup.page, W.nav.home), `Tap "${W.nav.home}" in the menu`);
  }, async (s) => {
    const slot = slotOn(markup.page, DATES[6], SLOT);
    check(s, 'the note shows as text', clean(await slot.locator('.people .note').first().innerText().catch(() => '')) === '<b>x</b>');
    check(s, 'no <b> element was made', (await count(slot.locator('.people b'))) === 0);
  });

  // A card number in the note.
  const card = await openPhone('member (card number)', { viewport: PHONE, ip: IP.edge(++n) });
  let rid = '';
  await step(card, 'card-refused', 'A card number in the note: refused', async () => {
    await claimOn(card, WEEK_DATE, SLOT, { name: NAMES.card, contact: CONTACT, note: '4111 1111 1111 1111' });
    rid = await card.page.locator('main form input[name="rid"]').first().inputValue();
    await card.tapAndLoad(mainButton(card.page, W.signUp), `Tap "${W.signUp}"`);
  }, async (s) => {
    check(s, 'answers 400 with the form again', s.status === 400 && s.h1 === SLOT, `status ${s.status}, ${s.h1}`);
    check(s, 'the refusal at the top', s.notices.some((notice) => notice.includes(W.card)), s.notices.join(' | '));
    check(s, 'the refusal at the note', (await textIn(card.page, '#new-note-error')) === W.card);
    check(s, 'the note is marked invalid', (await card.page.locator('#new-note').getAttribute('aria-invalid').catch(() => null)) === 'true');
    check(s, 'what was typed is kept', (await card.page.locator('#new-name').inputValue().catch(() => '')) === NAMES.card);
    check(s, 'the same request id', (await card.page.locator('main form input[name="rid"]').first().inputValue().catch(() => '')) === rid);
  }, { expectStatus: 400 });
  await step(card, 'card-fixed', 'The note fixed and sent again: signed up once', async () => {
    await card.page.locator('#new-note').fill('');
    await card.type(card.page.locator('#new-note'), 'Apples', 'Replace the note with "Apples"');
    await card.tapAndLoad(mainButton(card.page, W.signUp), `Tap "${W.signUp}"`);
  }, async (s) => {
    check(s, 'lands on /me?new=<id>', /^\/me\?new=\d+$/.test(pathAndQuery(card.page.url())), s.url);
  });

  // Cancelling a place in the coming week that nobody waits for.
  const week = await openPhone('member (cancels this week)', { viewport: PHONE, ip: IP.edge(++n) });
  await step(week, 'week-signed-up', `Signed up for Bring water on ${shortDate(WEEK_DATE)} (in the coming week)`, async () => {
    await claimOn(week, WEEK_DATE, 'Bring water', { name: NAMES.week, contact: CONTACT });
    await week.tapAndLoad(mainButton(week.page, W.signUp), `Tap "${W.signUp}"`);
  }, async (s) => {
    S.weekSignup = /^\/me\?new=(\d+)$/.exec(pathAndQuery(week.page.url()))?.[1];
    check(s, 'lands on /me?new=<id>', Boolean(S.weekSignup), s.url);
  });
  await step(week, 'week-cancelled', `Cancelled ${shortDate(WEEK_DATE)} with nobody waiting: ask the group`, async () => {
    await week.tapAndLoad(week.page.locator(`#s${S.weekSignup}`).getByRole('link', { name: W.cancel, exact: true }), 'Tap "Cancel" on the sign-up');
    await week.tapAndLoad(mainButton(week.page, W.yesCancel), `Tap "${W.yesCancel}"`);
  }, async (s) => {
    check(s, 'lands on /me?cancelled=1&open=<place>&sheet=<slug>', /^\/me\?cancelled=1&open=\d+&sheet=[a-z0-9-]+$/.test(pathAndQuery(week.page.url())), s.url);
    check(s, 'says nobody was waiting', (await mainText(week.page)).includes(W.askGroupHeading));
    const ask = await week.page.locator('textarea#ask-group').inputValue().catch(() => '');
    check(s, 'a message asking the group to take it, with the public link', ask.includes(`/s/${SHEET.slug}`) && !TOKEN.test(ask), ask);
    check(s, 'a message for the organizer', (await count(week.page.locator('textarea#tell-organizer'))) === 1);
    await shareLinkChecks(s, week.page);
  });

  // A double tap on Sign up with JavaScript on.
  const double = await openPhone('member (double tap)', { viewport: PHONE, ip: IP.edge(++n) });
  await step(double, 'double-tap', 'A double tap on Sign up (JavaScript on)', async () => {
    await claimOn(double, BULK_DAYS[0], SLOT, { name: NAMES.double });
    const button = mainButton(double.page, W.signUp);
    await button.scrollIntoViewIfNeeded();
    const box = await button.boundingBox();
    double.say(`Double-tap "${W.signUp}"`);
    await double.loading(async () => {
      await double.page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      await sleep(60);
      await double.page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
    });
  }, async (s) => {
    check(s, 'one POST was sent', s.posts === 1, `${s.posts} POSTs`);
    check(s, 'lands on /me?new=<id>', /^\/me\?new=\d+$/.test(pathAndQuery(double.page.url())), s.url);
  });
  await step(double, 'double-tap-sheet', 'After the double tap, the sheet shows one sign-up', async () => {
    await double.tapAndLoad(navLink(double.page, W.nav.home), `Tap "${W.nav.home}" in the menu`);
  }, async (s) => {
    const people = await slotOn(double.page, BULK_DAYS[0], SLOT).locator('.people li').allInnerTexts();
    check(s, `${NAMES.double} is on the sheet once`, people.filter((line) => line.startsWith(NAMES.double)).length === 1, people.join(' | '));
  });

  // Back after signing up, and the form sent again.
  const back = await openPhone('member (Back)', { viewport: PHONE, ip: IP.edge(++n) });
  let first = '';
  await step(back, 'back-signed-up', 'Signed up (before Back)', async () => {
    await claimOn(back, BULK_DAYS[1], SLOT, { name: NAMES.back, note: 'Cups' });
    await back.tapAndLoad(mainButton(back.page, W.signUp), `Tap "${W.signUp}"`);
  }, async (s) => {
    first = /^\/me\?new=(\d+)$/.exec(pathAndQuery(back.page.url()))?.[1] ?? '';
    check(s, 'lands on /me?new=<id>', Boolean(first), s.url);
  });
  let restored = false;
  await step(back, 'back-pressed', 'Back after signing up: the page Back shows', async () => {
    await back.back('Press Back');
  }, async (s) => {
    const shows = await back.page.evaluate(() => window.__pageshows ?? []).catch(() => []);
    const name = await back.page.locator('#new-name').inputValue().catch(() => null);
    restored = name === NAMES.back;
    s.note = `pageshow: ${shows.join(', ') || 'none'}; ${restored ? 'the form came back with what was typed' : 'the form was loaded again'}`;
    check(s, 'shows the claim form', s.h1 === SLOT, s.h1);
    if (!restored) check(s, "says you're already signed up here", (await mainText(back.page)).includes(W.alreadyHere));
  });
  if (restored) {
    await step(back, 'back-sent-again', 'The form sent again after Back: the same answer', async () => {
      await back.tapAndLoad(mainButton(back.page, W.signUp), `Tap "${W.signUp}" again`);
    }, async (s) => {
      const again = /^\/me\?new=(\d+)$/.exec(pathAndQuery(back.page.url()))?.[1] ?? '';
      check(s, 'the same sign-up as the first answer', again === first, `first ${first}, again ${again || s.url}`);
      check(s, 'not refused as a used form', s.status === 200 && !(await mainText(back.page)).includes(W.formReused), `status ${s.status}`);
    });
  } else {
    notExercised('back-sent-again', 'The same form sent again after Back', 'Back loaded the claim page again (no back/forward cache restore), so the form that was sent is not on the screen to send again; the page says the person is already signed up');
  }
  await step(back, 'back-sheet', 'After Back, the sheet shows one sign-up', async () => {
    await back.go(`/s/${SHEET.slug}`);
  }, async (s) => {
    const people = await slotOn(back.page, BULK_DAYS[1], SLOT).locator('.people li').allInnerTexts();
    check(s, `${NAMES.back} is on the sheet once`, people.filter((line) => line.startsWith(NAMES.back)).length === 1, people.join(' | '));
  });

  // The potluck: imported, opened, and its required note left empty.
  const org = phones.organizer;
  if (!org) {
    notExercised('potluck', 'The potluck import and its required note', 'the organizer could not be opened');
  } else {
    const p = () => org.page;
    await step(org, 'potluck-checked', 'examples/potluck.json pasted and checked (Import opened again from the menu)', async () => {
      await org.tapAndLoad(navLink(p(), W.nav.importExport), `Tap "${W.nav.importExport}" in the menu`);
      await org.paste(p().locator('#import-json'), POTLUCK_TEXT, 'Paste examples/potluck.json into the box');
      await org.tapAndLoad(mainButton(p(), W.importCheck), `Tap "${W.importCheck}"`);
    }, async (s) => {
      check(s, 'says what the file would make', s.notices.some((notice) => notice.startsWith(W.wouldMake)), s.notices.join(' | '));
    });
    await step(org, 'potluck-imported', 'The potluck imported', async () => {
      await org.tapAndLoad(mainButton(p(), W.importApply), `Tap "${W.importApply}"`);
    }, async (s) => {
      check(s, 'answers 200 (a new form imports the next file)', s.status === 200, `status ${s.status}`);
      check(s, 'says what it imported', s.notices.some((notice) => notice.startsWith(W.imported)), s.notices.join(' | '));
    });
    await step(org, 'potluck-admin', "The potluck's admin page", async () => {
      await org.tapAndLoad(navLink(p(), W.nav.organizer), `Tap "${W.nav.organizer}"`);
      await org.tapAndLoad(sheetLink(p(), POTLUCK_SHEET.title), `Tap the sheet "${POTLUCK_SHEET.title}"`);
    }, async (s) => {
      check(s, 'shows the sheet', s.h1 === POTLUCK_SHEET.title, s.h1);
      check(s, 'it is open', (await statusTag(p())) === 'Open');
    });
    await step(org, 'potluck-public', 'The potluck opened: its public page', async () => {
      await org.tapAndLoad(mainLink(p(), W.publicPage), `Tap "${W.publicPage}"`);
    }, async (s) => {
      check(s, 'shows the sheet', s.h1 === POTLUCK_SHEET.title, s.h1);
    });
  }
  const pot = await openPhone('member (potluck)', { viewport: PHONE, ip: IP.edge(++n) });
  const potDay = POTLUCK_SHEET.dates[0].date;
  const potSlot = POTLUCK_SHEET.dates[0].slots[0].label;
  await step(pot, 'required-note-empty', 'The required note left empty: Sign up tapped', async () => {
    await pot.go(`/s/${POTLUCK_SHEET.slug}`);
    await pot.tapAndLoad(slotOn(pot.page, potDay, potSlot).locator('a.take'), `Tap "${W.takeIt}" for ${potSlot}`);
    await pot.type(pot.page.locator('#new-name'), NAMES.potluck, `Type the name "${NAMES.potluck}"`);
    pot.fresh();
    await pot.tap(mainButton(pot.page, W.signUp), `Tap "${W.signUp}" with the note empty`);
    await sleep(1500);
  }, async (s) => {
    const field = await pot.page.locator('#new-note').evaluate((el) => ({ missing: el.validity.valueMissing, message: el.validationMessage })).catch(() => null);
    s.note = `the browser's own message at the field: "${field?.message ?? ''}"`;
    check(s, 'nothing was sent', s.posts === 0, `${s.posts} POSTs`);
    check(s, 'the browser stops at the note, with its message there', field?.missing === true && Boolean(field?.message), JSON.stringify(field));
    check(s, 'the note is labelled with what the sheet asks for', (await textIn(pot.page, 'label[for="new-note"]')) === POTLUCK_SHEET.noteLabel);
  });
  await step(pot, 'required-note-blank', 'The required note only a space: the error at the field', async () => {
    await pot.type(pot.page.locator('#new-note'), ' ', 'Type a single space in the note');
    await pot.tapAndLoad(mainButton(pot.page, W.signUp), `Tap "${W.signUp}"`);
  }, async (s) => {
    check(s, 'answers 400 with the form again', s.status === 400 && s.h1 === potSlot, `status ${s.status}, ${s.h1}`);
    check(s, 'the error at the field', (await textIn(pot.page, '#new-note-error')) === W.noteRequired);
    check(s, 'the error at the top', s.notices.includes(W.noteRequired), s.notices.join(' | '));
  }, { expectStatus: 400 });
  await step(pot, 'required-note-filled', 'The note filled: signed up', async () => {
    await pot.page.locator('#new-note').fill('');
    await pot.type(pot.page.locator('#new-note'), 'Apple pie', 'Type the note "Apple pie"');
    await pot.tapAndLoad(mainButton(pot.page, W.signUp), `Tap "${W.signUp}"`);
  }, async (s) => {
    check(s, 'lands on /me?new=<id>', /^\/me\?new=\d+$/.test(pathAndQuery(pot.page.url())), s.url);
  });

  // A sheet that shows only "Taken".
  if (org) {
    const p = () => org.page;
    // The organizer is on the potluck's public page, whose menu is the public one: its footer leads back.
    await step(org, 'organizer-from-public-footer', 'The public footer\'s "Organizer sign-in", tapped by the signed-in organizer', async () => {
      await org.tapAndLoad(p().locator('footer').getByRole('link', { name: W.organizerSignIn, exact: true }), `Tap "${W.organizerSignIn}" at the foot of the public page`);
    }, async (s) => {
      check(s, 'it opens the dashboard', pathOf(p().url()) === '/organizer' && (await count(p().locator('#attention'))) === 1, s.url);
      // The coming week's date: the person on it with their note and their contact's buttons.
      const coming = await textIn(p(), '#coming');
      check(s, 'Coming up shows who brings what, with their contact', coming.includes(NAMES.card) && coming.includes('Apples') && (await count(p().locator('#coming .send a[href^="mailto:"]'))) >= 1, coming);
    });
    await step(org, 'edit-sheet-page', `${SHEET.title}: the sheet's settings page`, async () => {
      await org.tapAndLoad(sheetLink(p(), SHEET.title), `Tap the sheet "${SHEET.title}"`);
      await org.tapAndLoad(mainLink(p(), W.editSheet), `Tap "${W.editSheet}"`);
    }, async (s) => {
      check(s, 'shows the settings', s.h1 === W.editSheet, s.h1);
      check(s, 'the time zone is fixed now that people signed up', (await mainText(p())).includes(W.timezoneLocked) && (await count(p().locator('select[name="timezone"]'))) === 0);
    });
    await step(org, 'taken-saved', `${SHEET.title} set to show only "Taken"`, async () => {
      await org.tap(p().locator('label.choice', { hasText: W.namesTaken }), `Tap "${W.namesTaken}"`);
      await org.tapAndLoad(mainButton(p(), W.saveChanges), `Tap "${W.saveChanges}"`);
    }, async (s) => {
      check(s, 'says Saved.', s.notices.includes(W.saved), s.notices.join(' | '));
    });
  }
  const anon = await openPhone('visitor (Taken sheet)', { viewport: PHONE, ip: IP.edge(++n) });
  await step(anon, 'taken-public', 'A sheet that shows only "Taken": the public page', async () => {
    await anon.go(`/s/${SHEET.slug}`);
  }, async (s) => {
    const entries = await anon.page.locator('.people li').allInnerTexts();
    check(s, 'every name reads Taken', entries.length > 0 && entries.every((line) => clean(line).startsWith(W.taken)), entries.join(' | '));
    const main = await mainText(anon.page);
    const names = ["Mike's family", "Frank's family", NAMES.long, NAMES.emoji, NAMES.markup, NAMES.card, NAMES.double, NAMES.back, NAMES.noScriptDouble];
    const seen = names.filter((name) => main.includes(name)).concat(/\b(Mike|Frank)\b/.test(main.replace(/Mike's|Frank's/g, '')) ? ['Mike or Frank'] : []);
    check(s, 'no name in the page', seen.length === 0, seen.join(', '));
    check(s, 'the notes still show', main.includes('Oranges') || main.includes('Apples'));
  });
  await step(anon, 'taken-claim-form', 'A sheet that shows only "Taken": its claim form', async () => {
    await anon.tapAndLoad(slotOn(anon.page, DATES[5], 'Bring water').locator('a.take'), `Tap "${W.takeIt}" for Bring water under ${longDate(DATES[5])}`);
  }, async (s) => {
    check(s, 'says the name shows only as Taken', (await mainText(anon.page)).includes(W.privacyTaken));
    check(s, "the note's hint says the name is hidden but the note is public", (await textIn(anon.page, '#new-note-hint')).startsWith(W.takenNoteHint));
  });

  // Remove someone from every place, through to the end.
  if (org) {
    const p = () => org.page;
    await step(org, 'removed-everywhere', `${NAMES.emoji} removed from every place`, async () => {
      await org.tapAndLoad(navLink(p(), W.nav.people), `Tap "${W.nav.people}" in the menu`);
      await org.tapAndLoad(rosterLink(p(), NAMES.emoji), `Tap "${NAMES.emoji}"`);
      await org.tapAndLoad(mainLink(p(), W.removeEverywhere), `Tap "${W.removeEverywhere}"`);
      await org.tapAndLoad(mainButton(p(), W.removeYes), `Tap "${W.removeYes}"`);
    }, async (s) => {
      check(s, `says "${W.removed}"`, s.notices.some((notice) => notice.startsWith(W.removed)), s.notices.join(' | '));
      check(s, 'the person is gone', (await count(rosterLink(p(), NAMES.emoji))) === 0);
    });
  }
  for (const phone of [long, emoji, markup, card, week, double, back, pot, anon]) await phone.close();
}

// --- The report ----------------------------------------------------------------------------------------------------------

function summarize() {
  const scanTypes = {
    wider: 'page wider than the window',
    smallTargets: 'target under 44x44 CSS px',
    smallInlineLinks: 'link in running text under 44x44 CSS px',
    overlaps: 'overlapping text',
    clipped: 'text clipped by an overflow ancestor',
    smallFontInputs: 'input under 16 px',
    unlabelledInputs: 'input without a label',
    unnamedControls: 'button or link without a name'
  };
  const groups = {};
  const occurrences = Object.fromEntries(Object.keys(scanTypes).map((key) => [key, 0]));
  for (const entry of report.steps) {
    const scan = entry.scan;
    if (!scan || scan.error) continue;
    const key = pageKey(entry.url);
    const group = (groups[key] ??= { page: key, visits: [], violations: {} });
    group.visits.push(`${entry.n} ${entry.id} ${entry.viewport}`);
    const add = (type, what, detail) => {
      occurrences[type] += 1;
      const list = (group.violations[scanTypes[type]] ??= []);
      let item = list.find((each) => each.what === what);
      if (!item) {
        item = { what, seenIn: [] };
        list.push(item);
      }
      item.seenIn.push(`${entry.n} ${entry.viewport}${detail ? ` (${detail})` : ''}`);
    };
    if (scan.wider) add('wider', `scrollWidth ${scan.scrollWidth} > window ${scan.viewport.width}`, scan.wide.map((each) => each.el).slice(0, 4).join('; '));
    for (const item of scan.smallTargets) add('smallTargets', item.el, `${item.width}x${item.height}${item.via ? ` with ${item.via}` : ''}`);
    for (const item of scan.smallInlineLinks) add('smallInlineLinks', item.el, `${item.width}x${item.height}`);
    for (const item of scan.overlaps) add('overlaps', `${item.a} / ${item.b}`, `${item.width}x${item.height}`);
    for (const item of scan.clipped) add('clipped', `${item.el} by ${item.by}`, item.overflow);
    for (const item of scan.smallFontInputs) add('smallFontInputs', item.el, `${item.fontSize}px`);
    for (const item of scan.unlabelledInputs) add('unlabelledInputs', item.el, '');
    for (const item of scan.unnamedControls) add('unnamedControls', item.el, '');
  }
  report.scanByPage = groups;

  for (const entry of report.steps) {
    const where = `${entry.n} ${entry.id} ${entry.viewport}`;
    for (const item of entry.pageErrors) report.pageErrors.push({ step: where, ...item });
    for (const item of entry.consoleErrors) report.consoleErrors.push({ step: where, ...item });
    for (const item of entry.failedRequests) report.failedRequests.push({ step: where, ...item });
    for (const item of entry.httpErrors) report.httpErrors.push({ step: where, ...item });
  }
  const unexpected = (list) => list.filter((item) => !item.expected).length;
  const unique = (type) => Object.values(groups).reduce((sum, group) => sum + (group.violations[scanTypes[type]]?.length ?? 0), 0);
  report.summary = {
    steps: report.steps.length,
    screenshots: report.screenshots.length,
    functionalChecks: report.steps.reduce((sum, entry) => sum + entry.checks.length, 0),
    functionalFailures: report.functionalFailures.length,
    pageErrors: report.pageErrors.length,
    consoleErrors: { all: report.consoleErrors.length, unexpected: unexpected(report.consoleErrors) },
    failedRequests: { all: report.failedRequests.length, unexpected: unexpected(report.failedRequests) },
    httpErrors: { all: report.httpErrors.length, unexpected: unexpected(report.httpErrors) },
    scan: Object.fromEntries(Object.entries(scanTypes).map(([type, label]) => [label, { occurrences: occurrences[type], uniquePerPage: unique(type) }])),
    notExercised: report.notExercised.length,
    scriptProblems: report.scriptProblems.length
  };
}

function writeReport() {
  report.finishedAt = new Date().toISOString();
  report.notCovered = NOT_COVERED.map(([what, why]) => ({ what, why }));
  summarize();
  writePrivate(join(OUT, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
}

// --- Start --------------------------------------------------------------------------------------------------------------

async function loadPlaywright() {
  const directory = process.env.PLAYWRIGHT_CORE;
  if (directory) {
    const entryFile = join(directory, 'index.mjs');
    if (!existsSync(entryFile)) stop(`playwright-core was not found at ${directory}: set PLAYWRIGHT_CORE to a playwright-core directory (this check installs nothing).`);
    return { playwright: await import(pathToFileURL(entryFile).href), from: directory };
  }
  try {
    return { playwright: await import('playwright-core'), from: 'playwright-core' };
  } catch {
    stop('playwright-core was not found: set PLAYWRIGHT_CORE to a playwright-core directory, or run npm install --no-save playwright-core (this check installs nothing).');
  }
}

async function main() {
  const { playwright, from } = await loadPlaywright();
  const chromium = playwright.chromium ?? playwright.default?.chromium;
  if (!chromium) stop(`${from} does not export chromium: set PLAYWRIGHT_CORE to a playwright-core directory.`);

  if (existsSync(OUT) && readdirSync(OUT).length > 0) stop(`${OUT} is not empty: give a new directory for each run.`);
  mkdirSync(OUT, { recursive: true, mode: 0o700 });
  chmodSync(OUT, 0o700);
  for (const sub of ['shots', 'html', 'downloads']) {
    mkdirSync(join(OUT, sub), { recursive: true, mode: 0o700 });
    chmodSync(join(OUT, sub), 0o700);
  }

  try {
    browser = await chromium.launch(LAUNCH);
  } catch (error) {
    stop(`Chromium could not start: ${errorText(error)}`);
  }
  report.browser = { engine: 'chromium', version: browser.version(), headless: true, args: LAUNCH.args, leftOut: LAUNCH.ignoreDefaultArgs };
  const interrupted = () => {
    report.scriptProblems.push({ phase, problem: 'interrupted' });
    browser?.close().catch(() => {});
  };
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  try {
    for (const flow of [organizerFlow, membersFlow, organizerAgainFlow, widthsFlow, noScriptFlow, edgeFlow]) {
      try {
        await flow();
      } catch (error) {
        report.scriptProblems.push({ phase, problem: 'the flow stopped', error: errorText(error) });
      }
    }
  } finally {
    for (const phone of Object.values(phones)) await phone.close();
    await browser.close().catch(() => {});
    writeReport();
  }

  const s = report.summary;
  console.log(`[browser-check] ${s.steps} steps, ${s.screenshots} screenshots, ${s.functionalChecks} checks: ${OUT}/report.json`);
  console.log(`[browser-check] functional failures ${s.functionalFailures}; page errors ${s.pageErrors}; console errors ${s.consoleErrors.unexpected} unexpected of ${s.consoleErrors.all}; failed requests ${s.failedRequests.unexpected} unexpected of ${s.failedRequests.all}; not exercised ${s.notExercised}; script problems ${s.scriptProblems}`);
  for (const [label, numbers] of Object.entries(s.scan)) console.log(`[browser-check] scan: ${label}: ${numbers.occurrences} (${numbers.uniquePerPage} different per page)`);
  console.log(`[browser-check] RESULT ${s.functionalFailures === 0 && s.pageErrors === 0 && s.scriptProblems === 0 ? 'PASS' : 'FAIL'}`);
  process.exitCode = s.functionalFailures === 0 && s.pageErrors === 0 && s.scriptProblems === 0 ? 0 : 1;
}

await main();
