# Verification: what is proven, and how

This is the living checklist of the template's checks. Each line says the **level** a requirement is proven at today.
It does not record suite counts: run the commands and read their summaries.

Levels, weakest first:

- **unit**: pure functions (`test/unit`, `qa/test_live_check.py`), no database. The live check's unit tests use a fake
  transport and a fake clock: its page reader, budgets, deadline, pace, retry rules, stops, redaction, state and lock.
- **db**: real PostgreSQL 14 from the old Supabase defaults, one throwaway cluster per test file (`test/db`). Route
  handlers are called directly (a `Request` in, a `Response` out) and their whole answer is read. This proves what the
  handlers answer and what their HTML holds. It is **not** HTTP: Next.js's routing, `next.config.ts` headers, its own
  logs and several processes behind a real server are not exercised.
- **pooler**: the same, through PgBouncer in transaction mode with `max_prepared_statements=0` (`test/db/pgbouncer.test.ts`
  and the pooled tests). Only the tests that say so ran through it.
- **control**: a negative control (`test/db/controls.test.ts`, and the live check's in `test/db/live-check.test.ts`)
  runs a copy of the source with one protection removed and requires the matching probe or line to fail.
- **bridge**: `qa/live-check.py` and `qa/local-http-check.py` run whole, unchanged, against the real route handlers
  and a throwaway database through two pipes (`test/support/bridge.ts`, `test/db/live-check.test.ts`). The bridge adds
  `next.config.ts`'s headers by the same rules itself, and several "servers" there are one process. This proves what
  the scripts send, read and decide, with the app's real pages and forms. It is **not** HTTP and not several processes.
- **HTTP**: the built app under `next start`, reached over HTTP on this machine. Each server is started by hand with
  `scripts/preview-server.mjs`, never by a test or a script.
- **browser**: `qa/browser-check.mjs`, one headless Chromium tapping and typing through the flows on a running copy, at
  phone sizes and larger, with and without JavaScript (Browser check, below).
- **QA**: a copy deployed on Tofu (the live check, `qa/live-check.py`).
- **device**: a real iPhone and Android phone (calendar files and their alerts).

## Commands

```sh
export PATH=/opt/homebrew/opt/postgresql@14/bin:$PATH   # macOS with Homebrew (README: elsewhere); pgbouncer on PATH too
npm run typecheck
npm run test:unit
npx tsx --test --test-concurrency=1 test/db/<file>.test.ts   # one file
npm test                                                      # everything, one file at a time
npm run test:qa                                               # the live check's unit tests (python3 -I)
env -u DATABASE_URL npm run build                             # migrate (nothing without DATABASE_URL), then next build
```

Tests start and stop their own clusters in `/tmp/ss-pg-*` and remove only those. Run one test process at a time.
The commands for local servers (a preview database, the servers, the live check and the local suites against them)
are in TOFU.md, Local servers. The browser check runs against one of those servers:

```sh
node scripts/preview-db.mjs reset --dir /tmp/ss-preview          # setup open, for the check to take the seat (restart the servers if a password was on)
PLAYWRIGHT_CORE=<playwright-core directory> node qa/browser-check.mjs --url http://127.0.0.1:3101 --out <a new empty directory> [--examples examples]
```

Without `PLAYWRIGHT_CORE` it looks for `playwright-core` in `node_modules` (`npm install --no-save playwright-core`); it
installs nothing itself. Each run needs its own new `--out` directory, outside the repository.

## Browser check

`qa/browser-check.mjs` drives one headless Chromium (playwright-core, loaded from `PLAYWRIGHT_CORE`; it installs nothing
and starts no server) through the real flows of a copy nobody has set up, with taps and typing, never by sending a form
itself. Each simulated phone is its own browser context and sends its own `X-Real-IP` from 192.0.2.0/24, as the local
suites do. It pastes `examples/soccer.json` and `examples/potluck.json`, whose dates are fixed (a season to copy): once
the soccer season's first day is less than two weeks off in its time zone, it moves every date of both files by the
same whole number of weeks (each keeps its weekday), so it runs on any day.

- The organizer: the setup page and Set up; the import page (a file pasted, checked, imported, and the same form
  pressed again); the sheet opened; the dashboard.
- Members: the sheet in place on `/`, a claim, the after-claim panel and `/me`; a second member on the waitlist; a
  cancel and its confirmation; the first waiting person moved up; the calendar file.
- The organizer again: Needs attention with Told them and Undo; a swap and who to tell; people, paid and the unpaid
  filter; a date added and this week's reminder; someone added to a full place and the waitlist message; Add a date
  every week; a place added to every date; a date cancelled (who to tell, what a member sees meanwhile and the
  cancelled calendar file) and restored; settings; the weekly reminder file; a first private link shown once, and
  the button back to the person; the remove-everywhere and delete confirmations (a date ahead offering to be cancelled
  instead) and an empty date deleted; the export and the CSV.
- The main pages again at 320×640, 844×390, 768×1024 and 1280×800 (the flows run at 390×844).
- JavaScript off: a claim, the private link opened in another browser, a cancel, the organizer's Remove through its
  question, a double tap.
- Edge cases: an 80-character name, an emoji, markup in a note, a card number refused and then fixed, a double tap with
  JavaScript on, Back after signing up, a cancel in the coming week with nobody waiting, the potluck's required note
  (the browser's own check, then a blank note refused at the field), a sheet that shows only "Taken", someone removed
  from every place.

For every step it keeps viewport screenshots (2× pixels; the top of the page and each screen down to its end, at most
six, never one full-page capture), the page's HTML, page errors, console errors, failed requests, and a scan: a page
wider than the window, targets under 44×44 CSS px (links inside running text listed apart), text boxes of different
elements overlapping, text clipped by an overflow ancestor, inputs under 16 px, inputs without a label, buttons and
links without a name. It writes `report.json` (every step, its checks, its scan, the scan grouped by page, and steps to
reproduce each failure), `shots/`, `html/` and `downloads/` under `--out`, a new directory outside the repository
(700, files 600: they hold the run's private links). It exits 0 only when every functional check passed, no page
error happened and the check itself had no problem (a scan or a screenshot that could not be taken).

The script follows the pages as they are now (a date's changes and a place's changes folded under "Change this date"
and "Change this place", Remove asking first, the sheet's status as the tag under its title, the first-link words). Its
last run, on the first pin's code, passed: 137 steps and 350 checks, no functional failure, no page error; its scan found
no page wider than the window, no overlapping or clipped text, and no target under 44 px but one link inside a sentence.
Run it again after any change to the pages, `public/`, the examples or the script, and read its scan before relying on
the layout lines below.

**What it proves:** the flows above work in a real browser on a `next start` server, with and without JavaScript, as a
person taps through them: forms, redirects and cookies; the private link leaving the address bar; the downloads
(calendar files, the weekly reminder, the export, the CSV) as attachments through Next.js; `public/app.js` loading and
running (Copy appears; a double tap sends the form once); the sentences of `src/words.ts` it looks for, word for word;
the message links' encoding (`%20`, never `+`; one recipient before any bcc); and the layout at five sizes, as far as
the scan sees it.

**What it does not prove:** real phones (Safari and WebKit, Chrome on Android, chat apps' in-app browsers); device
calendars accepting the files and showing alerts; WhatsApp, Messages, Mail and Google Calendar opening from their links;
the clipboard and the share sheet (headless Chromium has none, so Share stays hidden); several servers at once; the
organizer password and the locked states; the pages and states it does not reach (each report lists them under
`notCovered`); Tofu. Back after signing up loads the claim page again in Chromium (it is `no-store`), which then says
the person is already signed up, so the same form sent again after Back is not exercised by a browser: the replay
itself is tested at the db and bridge levels and by `qa/local-http-check.py --suite replay`. The scan lists targets
under 44 px; whether each matters is a design call it does not make.

## Requirements and their proof

| Requirement | Proven now | Still to prove |
|---|---|---|
| T01 last-place race through several `next start` processes | db and pooler: claim races at the function and handler level; bridge: the local race suite (rounds of claims at once, each claimer's own waitlist number, the public count); HTTP: `qa/local-http-check.py --suite race` on two servers and on five, one database (15 claims at once for one place, five rounds, and six for two places) | — |
| T02–T08 capacity, waitlist, promotion, backstop | db (+ pooler for cancel/promotion races); bridge: T02 round | — |
| T09 same `rid` twice and in parallel; replay with the cookie; other input → 409 | db (handlers); control: replay probe; bridge: live check M12 and the replay suite; HTTP (two servers, then five): `--suite replay` | QA M12 |
| T10 row-level security, revokes, old default grants | db; control: the imitated old defaults do grant | QA: Tofu's own grants pass |
| T11 three migrations at once; T12 empty `DATABASE_URL` | db and pooler; `scripts/preview-db.mjs` migrates a local preview database | QA build log |
| T13 file modes (`git archive`, no executable bits, `npm ci && npm run build && npm start`) | build: `git archive` of the commit, every executable bit taken off, then `npm ci` (the lockfile's packages) and `npm run build` with no `DATABASE_URL` pass, every route dynamic | start: the first QA deploy |
| T14 TLS with a self-made CA, verified; no CA fails before connecting | db (local TLS cluster) | QA build log shows verified TLS |
| T15–T20 seat, windows, password states, cookie keys, sign-in throttle | db (handlers) and pooler (seat race); bridge: live check `seat`, `fresh` M05–M07 and `password`, the seat-race suite; HTTP: `--suite seat-race` on two servers and on five, and the live check's `fresh` and `password` | QA `fresh` and `password` |
| T21 every POST guarded (static and per-route probe) | unit (static) and db (handlers); control: guard removed, one route unwrapped; bridge: the origin suite over every POST route, and the live check's M03–M05 and M22, with their control (guard removed: the live check fails at M04); HTTP (two servers, then five): `--suite origin` | QA M04, M05, M22 |
| T22 privacy of every public page | db: the whole HTML of `/`, `/s/<slug>`, the claim form (a remembered person's form shows no contact), a Taken sheet, `/me` without a cookie (the organizer's name, never their contact); views; control: a view that selects a contact; bridge: live check M13 and M21, with their control (that view: the live check fails at M13 and M21); HTTP: the live check's `fresh` (M13, M21) and `read` | QA M21 |
| T23 unknown and malformed links, one 404 | db (handlers); bridge: the links suite, live check M17; HTTP (two servers, then five): `--suite links` | — |
| T24 import refusals, examples, dues-only, unknown fields, slug `new` reserved | unit and db (JSON and the import page's form); bridge: live check M08–M10b, `--mode import` with `examples/soccer.json` and `examples/dues.json` | QA `--mode import` on a real draft |
| A replace's summary counts the sign-ups that go with the sheets it replaces | db (dry run and applied) | — |
| An export's sign-up history is restored: who added each sign-up, when it was made (`signedUpAt`), when it moved up, whether its person was told (told at the export's own `exportedAt`), each time never later than the import; an ordinary file's history fields are read and ignored | unit (the reader: an export's history, its defaults, a malformed `promotedAt` or `signedUpAt` refused with its path, and so is a time an export never writes (an offset, no seconds, a day or hour that does not exist, before 2000) and an `exportedAt`, `signedUpAt` or `promotedAt` later than now, a few minutes of another clock aside; an ordinary file's ignored); db: T25 compares the history of a fresh copy's export with the source's, each sign-up's time included (a member's, the organizer's and imported sign-ups, one moved up and not told, back in Needs attention, one told at `exportedAt`); a `signedUpAt` from 2000 comes back as the sign-up's time, and its calendar SEQUENCE is a whole number within an int that grows by a day with a change a day after everything else; one a few minutes ahead, with its move up and its told, is stored at the import's own time, while a sign-up never moved up nor told stays so; a restored sign-up a member made refuses a later `replace` of its sheet and nothing changes, while the same file without `exportedAt` (the control) imports it as made by the import and the replace goes ahead | — |
| A second file into a copy in use: the summary names each group setting it changes as a change ("changes the group name from … to … on every sheet", "removes the organizer's email or phone", "turns off the dues …"), never writing a contact out | db (the potluck example after the soccer one, whose organizer has no contact: the saved one goes; a file with another contact) | — |
| The import page's form imports once; opening the page again from the menu gives a new form that imports the next file | db; browser: Import it pressed again on the page it answered is 409 "This form was already used, so the file was imported only once. …" and nothing more is made; the page opened again from the menu imports the next file | — |
| T25 export → import into a fresh copy | db (functions, each sign-up's time and history included); db through the route handlers at the import's people and sign-up limits (500, 2,000): the export route's own bytes (about 480 KB, written without indentation; indented they would pass 512 KB) go through the import route into a fresh copy whole; browser: the export button answers `/organizer/export.json` through Next.js as a `.json` attachment, `signup-sheet/1`, with no link, token or hash | Restoring stops at the import's limits, below the copy's row caps (TOFU.md, Import and export): not a gap in the tests, a limit of the format. A change the organizer made and told nobody about is not in the format, so it does not come back |
| T26 CSV quoting, BOM, CRLF, formula guard | unit and db; bridge: live check M24; browser: the sheet's button answers the `.csv` attachment through Next.js with the BOM, CRLF and the header row | — |
| T27 ICS: UTC across daylight saving, alarms, folding, escaping, cancelled dates | unit and db; bridge: live check M19; browser: the after-claim and `/me` buttons answer the file (CRLF, lines of 75 octets at most, one event with UID and SEQUENCE, UTC times, alarms, the person's own link labelled); while the date is cancelled, "Update my calendar" answers the same UID with a higher SEQUENCE, `STATUS:CANCELLED` and no alarm | device: iPhone and Android accept the files, update by UID and SEQUENCE, and show alerts |
| The organizer's weekly reminder: its SEQUENCE grows with every change that can move the season's last day (a date deleted, cancelled or moved; a sheet opened, closed or deleted; an import), shorter seasons included, and never on a download | unit (the file) and db (each change through the organizer's own writes, then the route); browser: the dashboard's "Download the reminder" answers the weekly rule until the day after the last date | device: a calendar replaces the earlier reminder with the later file |
| T28 share texts word for word, `%20` never `+`, one number per text, bcc | unit (texts, links) and db (the pages' links, HTML-escaped); browser: every message link on the pages it checks (Needs attention, a swap, this week's reminder, the waitlist, a cancelled date, the invite, the after-claim and cancel pages) has `%20`, never `+`, and one recipient before any bcc | device: the links open WhatsApp, Messages and Mail |
| T29 usage counts (both of them) | db (activity rows per actor); bridge: `password` and `read` add no member activity | QA usage query on a real copy |
| T30 phone-size pass (390×844, 320×640) with no page errors | browser: every flow at 390×844 and the main pages at 320×640, 844×390, 768×1024 and 1280×800 with no page error; the scan finds no page wider than the window, no overlapping or clipped text, no input under 16 px, no input without a label and no control without a name; it lists the targets under 44 px in each report | real phones |
| T31 JavaScript off: claim, cancel, organizer remove | db: every form is a plain POST and its page renders without the script; bridge: the live check posts every form it uses as a plain form; browser with JavaScript off: a claim, the private link opened in another browser (303 to `/me`, no link left in the address), a cancel through its confirmation, the organizer's Remove through its question page (the person waiting moved up), a double tap that signs up once | — |
| One tap never removes: the sheet page links Remove's question; its POST answers how many moved up (`removed=<n>`) | db (the sheet page has no form that removes; the question page; Yes, remove; the notice); browser with JavaScript off (the question, then Yes, remove) | — |
| Remove's question promises that the first person waiting moves up only where that happens: a confirmed sign-up on a date neither cancelled nor started | db (a date ahead, the control: the line, and the person waiting moves up; a cancelled date and a started one: no line, `removed=0`, nobody moved up) | — |
| The dashboard's "Send this week's reminder" and the sheet page's button agree: a coming date with no places has nothing to send | db (a date in two days with no places: neither links the reminder; with a place, both do, and its page has the message) | — |
| The seat notice says when the seat ends, in the first sheet's time zone by the sheet form's name for it (UTC before there is a sheet) | db | — |
| T32 headers on `/`, `/s/x`, `/me`, `/organizer` | unit (config values); db: every page sets `Cache-Control: private, no-store` itself; bridge: the headers suite and live check M23 (the bridge adds the config's headers itself: this proves the checks, not Next.js); HTTP (two servers, then five): `--suite headers` (the headers Next.js adds, on the exact and dotted paths; no `'unsafe-eval'`, no X-Powered-By) | — |
| T33 `/` is 200 in every healthy state and never redirects; 503 without a database | db: setup, held (no, one, several sheets), password (one, several), short, expired, unclaimed; 503 for `/`, a sheet, a claim form, `/me` (with and without a cookie), `/organizer`; bridge: live check M02 and R02; HTTP: the live check's `fresh`, `password` and `read` | QA `fresh` |
| T34 full/full swap with waitlists, and a racing claim | db | — |
| T35 A's cookie on B's note, cancel, move, ICS and confirmation pages → 404 | db (handlers and pages); control: person filter removed; bridge: the ownership suite, live check M17b, with its control (W2's person filter removed: the live check fails at M17b); HTTP (two servers, then five): `--suite ownership` | QA M17b |
| A member's own cancel, move and note change nothing once the sheet is closed or the date cancelled or started (a cancel or a note: 303 `/me?e=locked`, which says so; a move: back to its page, which says why; the confirmation page and `/me` say which: closed, started or cancelled); the organizer can still remove, move and change notes | db (the functions, on a closed sheet, a started date and a cancelled date, with an open control; the routes, the confirmation page's "closed" reason and `/me`); browser: while a date is cancelled, the person's `/me` says so and offers no Cancel or Move, and the public sheet offers no place on it | browser: a closed sheet and a started date |
| A cancelled date on the public sheet shows who was on it, but no count, no "You're in" and no Take it; the first box marks the phone's own place on it "cancelled" | db (the page, for the person this phone remembers); browser: the date shows Cancelled, with no count and no Take it | browser: the first box's "cancelled" mark |
| T36 organizer routes: static inventory, POST and GET probes with no, forged, wrong-key and retired cookies | unit (static) and db (every organizer POST and every organizer page GET); controls: organizer check removed from POSTs, from the import, from page GETs; bridge: the organizer-gets suite, live check M07, M10b, M21's export and P03; HTTP (two servers, then five): `--suite organizer-gets` | — |
| T37 a changed deletion list refuses and shows the new list | db (structure and the pages' confirmation, `seen`) | — |
| T38 card and bank numbers refused across forms and import; phones accepted | unit and db; browser: the claim form's refusal | — |
| T39 logs carry no private values | unit and db (the app's own log lines); unit and bridge: the logs suite finds a private link in a log, and names only the line; HTTP: `--suite logs` over the captured logs of every server of a run (two, then five; Next.js's own lines included) | — (the platform's own logs: Not proven anywhere yet) |
| T40 opposing moves keep lock order | db (deterministic, with pauses); control | — |
| T41 a held lock answers 503 after about 6 seconds | db (busy classification, lock timeouts) | HTTP |
| T42 a new link kills the old link and cookie | db (members' and organizer's new link, through the pages); bridge: live check M25; HTTP: the live check's `fresh` (M25) | QA M25 |
| T43 an unprefixed cookie is ignored over https | unit | QA (https only) |
| Pages escape every value; markup and quotes in names, notes, titles, contacts and links stay text | unit (the renderer refuses unchecked addresses, handlers, styles, unquoted values) and db (pages seeded with markup); browser: a note `<b>x</b>` shows as text on the person's page and the public sheet with no element made; names with an apostrophe, an emoji and 80 characters show whole | — |
| The claim form shown again keeps what was typed and its request id; a fixed resend signs up once | db; browser (JavaScript on): a card number in the note is refused at the field and at the top (400), the typed values and the request id are kept, and the fixed form signs up once; the potluck's required note left blank is refused at the field | browser with JavaScript off |
| A note refused on a sheet that names its note ("What you'll bring") says that name at the top of the page and at its field: the claim form, `/me`, Add someone | db (`/me` and Add someone: the alert and the field say the same; a note too long is named the same way); browser: the potluck's claim form refuses a blank note at the field, by its name | — |
| Organizer pages: Needs attention, Told them and Undo, who to tell after a move, swap, new day or cancelled date | db (Needs attention, Told/Undo); the messages render from the sheet's data; bridge: live check M18 (moved up listed); browser: Needs attention lists the person moved up with a message to their contact, Told them and Undo; who to tell after a swap and after a cancelled date; Coming up shows the coming week's people with their notes and contact links | browser: who to tell after an organizer move and after a date's new day, time or place |
| On a sheet that hides names ("Taken"), a message naming someone with no phone or email (moved up, changed, the waitlist's own) is labelled for the organizer to send them, never offered as a group message | db (the dashboard and the waitlist page, with a sheet that shows names as the control) | browser |
| Private pages' titles name nobody (a person's own pages; the organizer's pages about one person) | db (the `<title>` of `/me`, of the organizer's move and swap pages and of the organizer's new-link page); browser: the titles of the after-claim panel, the swap page and the organizer's person page; the remove-everywhere page has a fixed title in the code, not asserted | — |
| "Add a date every week": preview, add, second press adds nothing, 60-week cap | db; browser: the preview lists the dates and Add adds them, with the latest date's places | — |
| The new-link pages show a link once, with a heading, their menu and a button on (never only Back onto the form that made it); no link box offers the share sheet, nor does "Send it to myself", which goes to the person's own saved contact when it reads only one way (mail to their address, or a text and WhatsApp to a number with its country code), else by Messages and Mail addressed to nobody (a number without one is never guessed at), never WhatsApp's chat list; a failure reading that contact after a member's own new link is made still answers the link and its cookie; the organizer's goes to the person's own contact only; a first link (someone who never had one) speaks of no old link; the link of someone signed up from another person's phone tells the reader not to open it on their own phone | db (the member's and the organizer's pages: heading, menu, the way on, no share sheet, a generic title; "Send it to myself" on `/me` (an email address saved) and after a new link (a number with its country code saved, one without it, and none); a changed copy whose read of the contact fails after the new link is made (the link, its cookie, the box addressed to nobody, one log line); the first link's question, page and message; the claim for someone else's hint); bridge: live check M25; browser: the organizer's first link is shown once in a 200 answer (never in an address), with its heading, menu and "Back to …", no Share button, and for someone with no contact the sentence to send it yourself | browser: a member's own new link |
| Mark paid on the unpaid list: one tap, the amount and note kept, the list again with "Marked … paid." and Undo (the line only while the person is paid: after Undo, Back to its address shows them unpaid with no such line); the person page's form still sets amount and note | db | browser |
| Live check: every mode passes; a must-run line that does not run fails; budgets, deadline, pace, retries, stops at a checkpoint or an access-code page; nothing private printed or kept | unit (fake transport); bridge: `fresh`, `password`, `read`, `seat`, `import`, `delivery` (and `--cleanup-only`) pass, the state file is 600 and the evidence 700/600 with no link, token, seat cookie or password in it; HTTP: `fresh`, `password` and `read` against a local server | QA: `fresh` and `password` on a copy of the pin (the pin's own commit), `read` after handover |
| `read` mode's R05 says what it looked for: the contacts and words earlier runs of the check made (it cannot know the organizer's real contacts), or "not exercised" when the state holds none. R05, R06 and R08 have no positive control (no cookie, no link by design), nor does G01; M21's public-page lines are controlled on other paths (the person's own page, the export) | unit (with and without probes, and a probe found on the page) and bridge (`read` after `fresh`) | — (a limit of the mode, said in TOFU.md) |
| Delivery changes nothing of the organizer's | bridge: every business row is identical before and after a delivery run, also one that stops part-way (it still removes its own sheet and people); no zz-check sheet or QA person is left | QA on the organizer's real copy, while the agent holds the seat |
| `TOFU.md` | written: repository and pins, settings, access, links and the token formula, pages, requests, privacy, database and TLS, migrations, concurrency, calendar limits, import and export, logs, usage queries, the live check, local servers, the delivery runbook | read against a real delivery |

## Not proven anywhere yet

- T41 over HTTP: a held lock answering 503 after about 6 seconds through a running server.
- `public/app.js`'s Copy and Share: the browser check sees Copy appear once the script runs and a double tap send the
  form once, but neither the clipboard nor a phone's share sheet (headless Chromium has none).
- Unknown paths get Next.js's built-in 404 page, not the app's own; it carries no app data.
- `scripts/preview-server.mjs` has no test of its own: it starts a server, which no test does. It started every
  server of the HTTP runs.
- Real calendar apps: whether they accept the files, update by UID and SEQUENCE, drop cancelled events and show alerts.
- Tofu: the build's TLS verification, the grants, the platform's own headers and logs, the access code door with deep
  links, shared Wi-Fi budgets, the security checkpoint's exact answer (the live check stops at any 403 or 429 that is
  not the app's own page).
