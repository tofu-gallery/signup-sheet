# Sign-up sheet on Tofu

A sign-up sheet for a group's turns, shifts, dishes and dues. The organizer makes a sheet of dates with places (one
family brings snacks each Saturday, two drivers per away game, mains, sides and desserts for a potluck). People open
one link from the group chat, tap a date, type a name, and keep the private link it gives them to change or cancel.
When someone cancels, the first person waiting moves up by themselves. The organizer sees who moved up and who to tell,
sends this week's reminder to the group chat in one tap, and ticks who has paid the dues. Members need no account.

It is for organizers of recurring groups (5 to 50 people, in the US, in English, not developers). This file is for
whoever runs, delivers, checks or changes a copy.

## Repository, pins and copies

- **Repository:** `tofu-gallery/signup-sheet`, public, MIT, default branch `main`. No upstream, no mirror branch.
- **Pins** are tags `pin/<UTC date>[.N]` on `main` (the date from `date -u +%F` on the day the tag is made; `.2`, `.3`
  for a second pin that day). A pin never moves. Nobody invents a future pin date.
- **A copy is a snapshot of one pin.** Tofu copies the pinned commit into the organizer's account; the copy never
  follows `main` or a later pin. Delivery changes only data (the import, the organizer pages), settings and words in
  the database, never code. An organizer who needs a later fix gets it only in a new copy.
- **Changing the code after a pin** needs a new pin, and the QA runs again on a copy of that pin (`fresh`, then
  `password`). Tofu's gallery offers a pin only once both runs passed on a copy of that pin's own commit.

## How Tofu runs it

- Preset `nextjs`, root directory `''`, `npm ci`, build `node scripts/tofu-migrate.mjs && next build`, start
  `next start`. Node 22, the committed `package-lock.json`. Four runtime dependencies: `next`, `react`, `react-dom`,
  `pg`.
- **The database is made at build.** Because the build command runs the migrate script, Tofu leaves
  `supabase/migrations` to the build for every owner. The schema exists before the first request, so there is no
  start race, and Tofu's own grants step (which covers only migrations Tofu applies itself) never touches these
  tables.
- Row-level security is on for every table, with no policy (the app's own connection owns the tables), and the
  migration revokes everything from `anon` and `authenticated`, because databases made before 2026-10-30 still grant
  new objects to them by default.
- Every page and route is dynamic (`dynamic = 'force-dynamic'`); the build's route table shows each one as `ƒ`. No
  middleware or proxy, no server actions, no `output` setting, no `next/image`, no X-Powered-By.
- **How a copy starts:** a new copy has no settings saved; the first deploy makes the database; the build applies the
  schema and makes the one `app_state` row; `/` answers 200 with the setup page. `/` must answer 200 on an empty
  database with no password, or the first deploy fails and its rollback deletes the database.

## Settings

| Setting | Kind | What it does |
|---|---|---|
| `ORGANIZER_PASSWORD` | hidden; the app's owner saves it in Keys & settings | Any non-blank value retires the setup seat for good. 12 characters or more lets the organizer sign in from any device. A new value signs every organizer browser out. Removing it locks the organizer page; sign-ups go on. |
| `MAKE_ONE_URL` | public, optional | An `https://` address for the public footer's "Make one for your group". Anything else is ignored. Not set in a new copy. |
| `DATABASE_URL`, `SUPABASE_CA_CERT` | from Tofu | The database, and the root its certificate chains to. A new `DATABASE_URL` signs out organizers who signed in with the password (a held seat keeps working) and keeps member links working (only their hashes are stored). |

There is no session secret to save: every key derives from `DATABASE_URL` (and, for organizer password cookies, the
password).
The Supabase URL and keys are not used.

## Organizer access

One row, `app_state`, holds the setup seat. Each request that needs it computes the state:

| State | When | `/organizer` shows |
|---|---|---|
| `setup-open` | no password, no seat yet, within 24 hours of the database's creation | the setup page: "This sign-up sheet has no organizer yet" and "Set up this app as its organizer" |
| `held` | a browser pressed Set up; at most 7 days | the dashboard to that browser, with when the seat ends (in the first sheet's time zone, named as the sheet form names it, like "Nov 5, 6:30 PM Pacific time"; in UTC before there is a sheet) and Give up setup; "This sign-up sheet already has an organizer" to any other, with how to save `ORGANIZER_PASSWORD` (no sign-in form, which could not work) |
| `password` | `ORGANIZER_PASSWORD` has 12 characters or more | the dashboard when signed in, otherwise "Organizer sign-in" |
| `locked-short` | a password shorter than 12 | its sentence; no form (the length is never shown) |
| `locked-removed` | the password was removed after the seat retired | its sentence |
| `locked-expired` | the seat's 7 days passed, or Give up setup | its sentence |
| `locked-unclaimed` | nobody pressed Set up in the first 24 hours | its sentence |

- **Taking the seat** is one POST to `/organizer/setup` and one `update … where seat_state = 'open' and now() <
  created_at + 24 hours`. The winner's cookie is `__Host-ss_org=seat.<32 random bytes, base64url>`; the row keeps only
  its SHA-256. A GET never takes it. The losing POST gets 403 "Someone else pressed Set up first. …".
- **Signing in** compares SHA-256 of the typed, trimmed password with SHA-256 of the saved one in constant time. The
  cookie is `pw.<issued unix seconds>.<HMAC-SHA256(K_org, "org\0" + issued)>`, 90 days, with K_org =
  HKDF-SHA256(`DATABASE_URL` + "\0" + password, salt `signup-sheet`, info `organizer v1`, 32 bytes). A wrong password
  waits 1 second; failures are throttled in the database (Requests).
- **Give up setup** (seat holder only) ends the seat at once; it never reopens.
- **Handover** is `app_state.retired_at`: the moment a saved password retired the seat. The usage counts start there.
- The order this forces on a delivery is in the delivery runbook below: everything the agent does needs the seat, and
  the agent has no way in once the password is saved and deployed. Every later edit exists in the organizer pages
  (above all "Add a date" and "Add a date every week").

## Members and their links

- **A private link** is `/me/<token>`: 32 bytes as 43 base64url characters. Only SHA-256(token) is stored.
- **A new person's first link** is derived, so the same claim form sent again gets the same link back:
  `base64url(HMAC-SHA256(K_link, "edit-link\0" + rid + "\0" + personId))`, K_link = HKDF-SHA256(`DATABASE_URL`, salt
  `signup-sheet`, info `edit links v1`, 32 bytes). `rid` is the claim form's server-issued UUIDv4; the row keeps only
  SHA-256(rid) in `signups.request_hash`. The person id is in it because ids are never reused: a form sent again
  after its sign-up is gone makes a new person with a link nobody has had. Neither rid, token nor K_link is stored.
- **A new link** (the member's own, or the organizer's for someone) is 32 fresh random bytes. The old link and every
  cookie holding it stop working at once. It is shown once, in a 200 answer, never in an address, on a page with a
  heading, its menu and a button on (back to the person's page, the organizer's person page or the sheet), so nobody
  has to press Back onto the form that made it. A link's own box has Copy but never the phone's share sheet (it offers
  the chats used last, the group chat first). The ways to send it: the organizer's message to the person's own contact,
  and "Send it to myself" (on `/me`, and after the member's own new link), a message to the contact the person saved
  when it reads only one way: mail to their own address, or a text and WhatsApp to their own number written with its
  country code (+…). Their page shows that contact already. A number without one may be another country's, and reading
  it as a US number would send the link to a stranger (155 1234 5678, a mobile number in China, reads as a US number
  in area code 551): with such a number, or no contact a link can reach, it opens Messages or Mail with the link and
  nobody in To, for the person to type their own. Never WhatsApp's list of chats (it puts the group chat first too)
  and never the share sheet. Once the member's own new link is made, a failure reading their contact for that box
  never undoes the answer: the page still shows the link and moves the cookie, with the box addressed to nobody. The
  organizer's first link for someone who never had one (imported, or added by the organizer) says so, and its message
  speaks of no old link.
- `GET /me/<token>` sets `__Host-ss_me` (400 days) and answers 303 to `/me`, so the token leaves the address bar at
  once; no Location ever carries a token. Unknown and malformed links get the same 404. `/me` reads the cookie: the
  person's own name and contact, every sign-up, calendar buttons for confirmed ones, and the private-link box. Without
  a cookie it answers 200 with how to get back in and the public footer (the organizer's name, never a contact); it
  reads the database for that name, so without one it answers 503 "This sheet is waking up. …" as the other pages do.
  A cookie that stopped working gets the 404 and is cleared.
- Every member route checks `id = <sign-up> and person_id = <me>` inside its transaction: someone else's sign-up id is
  the same 404 and changes nothing.
- A member changes their own sign-ups (cancel, move, the note) only while the sheet is open and the date is neither
  cancelled nor started. After that their page offers no Cancel, Move or note and says why (that the date is
  cancelled, or "… Ask the organizer."), and a form sent anyway changes nothing: a cancel or a note answers
  `/me?e=locked`, which says so; a move goes back to its own page, which says why. The organizer can still remove, move
  or change anyone.
- The same claim form sent again (same rid, same input) answers the same sign-up, Location and cookie; the same rid
  with other input or another place is 409 "This form was already used. Reload the page and try again." A claim that
  makes a new person while the phone remembers someone else answers 200 with the new person's link once ("Send this
  link to them": a message to their own contact when one was typed, else Copy), and the phone keeps its own person:
  the page tells the reader not to open the link on their own phone, which would then take them for that person. Names
  are never merged.
- Calendar files have the token in their address (`/me/<token>/calendar/<id>.ics`, `/me/<token>/calendar.ics`)
  because calendar apps send no cookie.

## Pages

Every document is a route handler answering a whole HTML page through one renderer (`src/lib/html.ts`) that escapes
every value; only fragments it made itself pass unescaped, and addresses must be checked paths or absolute addresses on
this copy, share or calendar targets, or an https page (the footer's "Make one for your group"). No page of the app's
own is a React page or carries an RSC payload, and nothing uses `dangerouslySetInnerHTML`; an unknown path gets
Next.js's built-in 404 page (through `src/app/layout.tsx`), which holds no app data. One CSS file and one small script
(`public/app.js`: Copy, Share and one submit per tap); every form works with JavaScript off: plain POSTs, and two GET
forms (the weekly reminder's download and the preview of "Add a date every week"). Every HTML answer is
`Cache-Control: private, no-store`. `/` answers 200 in every healthy state and never redirects: the setup page, one
open listed sheet in place (canonical `/s/<slug>`), a list, or "Nothing is open for sign-up yet." What takes someone
off a place asks first, on its own page: Remove (one sign-up), Remove from every place, Cancel this date, and deleting
a sheet, date or place (a date still ahead is offered "Cancel the date instead"). Cancel this date and the three
deletes list who to tell, each with a message. Remove and Remove from every place list nobody to tell: the people they
move up from a waitlist (only on a date that is not cancelled and has not started, as their pages say) are marked to
tell, in Needs attention. A page that refuses something says so in its title ("Error: …").

## Requests

- **The Origin guard** wraps every POST. It passes when `Origin` equals this copy's origin
  (`<first X-Forwarded-Proto, else https, http for loopback>://<first X-Forwarded-Host, else Host>`), or, with no
  Origin, when `Sec-Fetch-Site: same-origin`. Everything else gets 403 "This form has to be sent from this sheet's own
  page. Go back, reload the page and try again." An app on another host of the same site (the same registrable
  domain) is same-site with a copy, so SameSite=Lax alone would not stop its forms. **Scripted clients send `Origin:
  https://<copy host>` explicitly.**
- **Cookies** are `HttpOnly; Secure; SameSite=Lax; Path=/`, no Domain, with the `__Host-` prefix over https:
  `__Host-ss_org` (organizer), `__Host-ss_me` (a member's link, 400 days), `__Host-ss_b` (the browser's id, 22
  characters, 400 days, for the usage count). Over https the same names without the prefix are ignored. Over plain
  http (local only) the names have no prefix and no Secure.
- **Headers** (`next.config.ts`): `Content-Security-Policy` with `frame-ancestors 'none'`, `X-Frame-Options: DENY`,
  `Referrer-Policy: same-origin` (never `no-referrer`, under which browsers send `Origin: null` on the app's own
  forms), `X-Content-Type-Options: nosniff`, `X-Robots-Tag: noindex, nofollow`; `Cache-Control: private, no-store` on
  `/me`, `/organizer` and everything under them.
- **Body limits** (Content-Length and the bytes read): form posts 16 KB; the JSON import 512 KB (413 beyond); the
  import page's form about 1.5 MB, since the file in it is percent-encoded (413 beyond), the file itself held to 512 KB
  (400 "This file is bigger than 512 KB. Nothing was imported.").
- **Throttles** live in the database (several processes run at once), keyed by HMAC-SHA256 of the address
  (`x-vercel-forwarded-for`, else `x-real-ip`, else the first `x-forwarded-for`, else `unknown`) with HKDF(`DATABASE_URL`,
  `signup-sheet`, `ip v1`):

  | Limit | Per |
  |---|---|
  | organizer sign-in failures: 5 in 15 minutes, 50 an hour | connection, copy |
  | setup POSTs: 5 an hour | connection |
  | member writes (claim, cancel, move, profile, note, new link): 30 in 10 minutes, 2,000 an hour | connection, copy |
  | links that match nobody: 30 in 10 minutes | connection |
  | imports and dry runs (each POST to `/organizer/import`): 30 an hour, counted once the organizer is known | copy |

  People on one Wi-Fi share one address, so a family or a team on the same network shares the per-connection
  limits. Rows older than a day are pruned on about 1 in 50 writes.
- **A GET changes nothing a request controls.** Three exceptions: `/me/<token>` sets a cookie; a link that matches
  nobody (at `/me/<token>` or in a calendar file's address) counts one hit against its throttle; and any request may
  retire the seat once a password is saved (that depends only on the saved setting).

## Privacy

| Answer | May carry | Never |
|---|---|---|
| Public pages (`/`, `/s/*`, the claim form, `/me` without a cookie, `/health`, error pages) | group name; sheet, date and slot words; capacities and counts; names (or "Taken"); notes; the organizer's name | contacts, paid state, dues, tokens, person ids, sign-up times, waitlist names |
| A remembered person's claim form | their name | their contact (the field is empty) |
| `/me` and the person's own calendar files | their own name, contact, notes and sign-ups; the public words of those places; their own link; the organizer's name and contact | anyone else's contact, link or paid state |
| Organizer pages, CSV, export | everything except links (only hashes exist); a new link appears once, in its own answer | tokens, hashes |
| Logs | a fixed place name; a SQLSTATE and constraint, an error's class and code, or a fixed sentence (Logs) | names, contacts, notes, tokens, URLs, `DATABASE_URL`, error objects |

No analytics, beacons, fonts or other sites' resources. WhatsApp, Messages, Mail and Google Calendar are plain links
the person taps. Names, notes and paid notes refuse 12 or more digits in a row and IBAN-shaped text; contacts refuse
Luhn-valid 13–19 digit numbers ("That looks like a card or bank number. This app never keeps those."); ordinary US
phone numbers are fine. No medical, age or child fields; the note hint says not to include health or allergy details.

## Database

- `scripts/tofu-database.mjs` makes the connection settings for the migrate script and the app alike. It removes the
  URL's TLS parameters (node-postgres would read some as file paths and let them replace the `ssl` object) and, when
  the URL asks for TLS (any `sslmode` but `disable`, `ssl=true`, or a certificate parameter), verifies the server
  against Node's roots plus `SUPABASE_CA_CERT`. **Every TLS mode, `prefer` and `no-verify` included, is a fully
  verified connection; verification is never switched off.** `sslmode=disable` is for a local database only. A URL
  that asks for TLS without a CA fails before connecting: `SUPABASE_CA_CERT is not set: it is needed to check the
  database server's certificate.` (prefixed `[tofu-migrate] ` in the build). An invalid URL: `DATABASE_URL must be a
  PostgreSQL URL.` Neither ever prints the URL or a driver error. A missing CA on a Tofu copy is a problem to report,
  never a reason to turn verification off. That the build on Tofu verified TLS is proven only by a real build log.
- **The pool** (one per process): at most 3 connections, idle 5 s, connect 10 s, a 15 s reply deadline,
  `allowExitOnIdle`. Tofu reaches the database through a transaction pooler, so: no named statements, nothing set for
  the session (only `SET LOCAL`), no session advisory locks, no `LISTEN`, no temporary tables. Every write's
  transaction starts with `lock_timeout 5s` and `statement_timeout 10s`, and the export's read-only snapshot with
  `statement_timeout 10s` (it takes no row locks); on failure it rolls back and the connection is destroyed.
- **The migrate script** (`scripts/tofu-migrate.mjs`, a port of the one in `tofu-gallery/cactoide`): an empty `DATABASE_URL` prints
  `[tofu-migrate] DATABASE_URL is not set; nothing to apply.` and exits 0. Otherwise each transaction takes
  `pg_advisory_xact_lock(hashtext('scripts/tofu-migrate.mjs'))` (waiting at most 120 s), reads the Supabase CLI's
  ledger `supabase_migrations.schema_migrations` again under the lock, and applies each file it lacks whole, with its
  ledger row, in one transaction. Two builds at once: one applies, the other waits and finds it recorded. Its own
  reply deadline is 10 minutes, so the app's 15 s never cuts a migration short. It prints what it applied and, on a
  failure, one line, never an error object: for a database error the file, its SQLSTATE and the objects it names, with
  PostgreSQL's own message only for syntax and catalog errors (any other can quote a row's values); for any other
  failure its message.
- **Adding a migration:** a new file `supabase/migrations/<14 digits>_<name>.sql` whose name sorts after the others;
  never edit or rename an applied file. It runs whole in one transaction. It ends with row-level security on, and the
  same revokes from `anon` and `authenticated`, for everything it adds (tables, sequences, functions); functions are
  `SECURITY INVOKER` with `SET search_path = ''` and qualified names. No database read at module import time.
  A new pin then needs the QA runs again, which apply it on a copy's first build.

## Concurrency

Several app processes run at once. The capacity backstop is the trigger-kept `slots.confirmed_count` with `CHECK
(confirmed_count <= capacity)` (`slots_within_capacity`): an update of one slot row serializes even under READ
COMMITTED, so an over-full slot is refused by the database even if the app's own check were wrong.

The code names the writes: W1 claim, W2 cancel or remove, W3 move, W4 swap, W5 a member's name, contact or note, W6
a slot's capacity, W7 deleting a sheet, date or slot, W8 a new private link, W9 paid, W10 the import, W11 removing a
person from every place. G6 is the rule that every read or write a member makes of a sign-up filters by its owner
(`id = <sign-up> and person_id = <me>`), so someone else's sign-up id finds nothing.

Every write follows one lock order (`src/lib/locks.ts`): `app_state` (imports only) → sheets in id order (FOR SHARE by
sign-up changes, FOR UPDATE by changes to a sheet, its dates or slots) → slots ascending → sign-ups ascending → people
→ the row caps' advisory lock. Two steps come after the people lock, and neither can close a cycle: a promotion locks
waiting sign-ups, only of slots the write already holds, which nobody else can hold without those slots; an import's
replace deletes the sheets it holds FOR UPDATE, with their slots and sign-ups, while no sign-up change can be on them
(locks.ts, importer.ts). After locking, a write reads again what it read before and starts over from BEGIN if anything
moved (at most twice, then 503). Promotion uses the slot actually vacated, and waiting people move up before
a newcomer can take a place. Waitlist position is 1 + the earlier waiting rows by `(queued_at, id)`, never a stored
number.

Row caps per copy: 2,000 people, 10,000 sign-ups, 50 sheets, 5,000 slots, enforced under concurrency through one
advisory lock (claims share it; other writes that add rows take it alone). SQLSTATE 55P03, 57014, 40001 and 40P01
answer 503 "Busy for a moment. Go back and try again." (a claim's deadlock or capacity check gets one retry from BEGIN
with the same rid). A database that cannot be reached, or a reply the pooler lost, answers 503 "This sheet is waking
up. Try again in a minute." with Retry-After. A row cap answers 409 with its sentence (the organizer's names the cap
and how to make room); a body the app will not read answers 400, 413 or 415. Anything else is a plain 500 with no
details.

## Time

A date's day, start and end are civil values in its sheet's time zone, shown as they are ("Sat, Nov 7 · 9:00
AM–10:30 AM"). A date takes claims until its start in that zone; a date with no time until 23:59. Past cancellations
promote nobody. A sheet's time zone cannot change once people have signed up. When every date is past, the sheet
says "This season is over. Thanks, everyone!" Calendar files convert to UTC (Calendar files).

## Calendar files

- One-shot `.ics` files (RFC 5545: CRLF, lines folded at 75 octets of UTF-8, TEXT escaped, timed events in UTC) and an
  "Add to Google Calendar" link, for confirmed sign-ups only (a waiting one's file is 404, and so is someone else's).
  **No subscribable feed:** Tofu's access-code door would block calendar apps from it.
- Each event's UID is its sign-up's, so a file taken again replaces the event. Its SEQUENCE counts the seconds from
  the sign-up's creation (for one restored from an export, the time it was first made) to the latest change of what
  the event shows, so it grows exactly when that changes, never just because it is downloaded again: the date's day,
  times, label, place or cancellation; the sign-up's place, its note, or its move up from the waitlist; the slot's name
  or description; the sheet's title, place or time zone; the group's name, or the organizer's name or contact; the
  person's name or private link. A date the organizer cancels comes as the same event with `STATUS:CANCELLED` and no
  alarms.
- **What a file can and cannot do:** it asks for alarms (the day before and 2 hours before a timed event; 9 AM the
  day before an all-day one). The calendar app decides whether and how they show; parsing the file proves nothing about
  a phone. Whether iPhone and Android calendars accept the files, update by UID and SEQUENCE, drop or strike cancelled
  events and show the alerts is verified only on real phones. The Google link uses the person's own reminder settings
  ("Google Calendar uses your own reminder settings."). The page's words say this; nobody promises an alert.
- A person's own file carries their own private link, labelled as theirs, and the public sheet link: their calendar
  is where they look when plans change. A calendar they share with others carries that link too.
- The organizer's "Remind me each week" file is a weekly floating-time event (`RRULE:FREQ=WEEKLY;BYDAY=…;UNTIL=` the
  day after the last date ahead), so it stays at the same local hour through daylight saving. Its UID names the day
  and time. Its SEQUENCE is the reminder revision (the sequence `reminder_revision`), which every write that can move
  the last date takes (a sheet opened, closed, deleted or given another time zone; a date added, moved to another day,
  cancelled, restored or deleted; an import of sheets) and which never goes back, so the file taken after a shorter
  season replaces the longer one instead of reading as an older version; downloading it again changes nothing.

## Share texts

All texts are in `src/words.ts` and are filled in from the public sheet only: names (or "Taken"), counts, the sheet's
words and its public link, never a contact, paid state, dues or private link. A text with a private link goes only to
its own person, never to a group share: the organizer's new or first link, and the link of someone signed up from
another person's phone, to that person's own contact; "Send it to myself" to the contact the person saved when it is
an email address or a number with its country code, else by Messages or Mail with nobody in To (Members and their
links). Links use `encodeURIComponent` (`%20`, never `+`); a text message or WhatsApp link goes to one number (a US
number becomes 1 + 10 digits for WhatsApp); one email to several people uses bcc only. The texts:
Invite your group (two lines), This week's reminder, Message the waitlist, Moved up: tell them, a date or place
deleted, a whole sheet deleted (no link: its address goes with it), a date cancelled ("nothing is needed from you that
day"; delete it from your calendar), a change made by the organizer (the old and the new date where the old one is
known; "If the old date is in your calendar, delete it and add the new one", with "from your private link" for
someone who has one), asking the group to swap instead (on the cancel question) or to take the place (after
cancelling), and telling the organizer. Someone with a private link is told to use it (to cancel after moving up, to
add the new date after a change); someone without one (imported, or added by the organizer) never is: the moved-up
text is for people with a link, and its one variant leaves out "Cancel with your link". For someone with no phone or
email, a message about them is offered for the group (several people with the same message share one box), except on
a sheet that hides names ("Taken"): there a message that names them (moved up, changed, the waitlist's own message) is
for the organizer to send them directly, labelled "not in the group".

## Import and export

One format, `signup-sheet/1`, both ways. Examples: `examples/soccer.json` (a draft snack sheet with a roster and
dues), `examples/potluck.json` (an open potluck whose note "What you'll bring" is required) and `examples/dues.json` (a
roster and dues with no sheets).

- `POST /organizer/import` takes the file as `application/json` (agents and the live check) or as the import page's
  form. In this order: the Origin guard (403, its HTML page), the organizer (401 JSON `{"error": "Sign in as the
  organizer first."}`; 403 for the form), the copy's import limit (429), the media type (415), the size (413), then the
  file. Past the Origin guard and the organizer, every answer to JSON is JSON: `{"ok": true, "dryRun", "summary",
  "counts"}` or `{"ok": false, "error", "path"}`. The file's own `dryRun` decides for JSON.
- The whole file is checked before anything is written; the first thing wrong refuses all of it with one sentence
  ending "Nothing was imported.": a path and what is wrong there, or one of the exact sentences (a weekday that does not
  match the date, a slot over capacity, an unknown person key or slot, an existing slug without `replace`, a replace of
  a sheet people signed up on themselves, an unknown time zone, more than 512 KB). Unknown fields and fields written
  twice are refused with their path; `from` (anywhere) and the fields only an export writes are accepted: in an
  export, each sign-up's `addedBy`, `signedUpAt`, `promotedAt` and `told` are restored (below); in any other file
  they, and the rest of the export-only fields, are read and ignored. An export's `exportedAt`, `signedUpAt` and
  `promotedAt` are times as an export writes them (UTC, like `2026-10-29T19:00:00.000Z`: a day and time that exist,
  from the year 2000 on) and never later than now, give or take a few minutes of another copy's clock. Weekday
  conflicts are never corrected silently.
- `group` changes the group's name, organizer and dues only for the keys it gives; a file without `group` changes
  none of them, so **a file that adds a sheet to a copy in use leaves `group` out**. `organizer` sets the organizer's
  name and contact together: one without `contact` removes the contact saved. The summary names a setting the file
  changes from something else as a change ("changes the group name from U9 Tigers to Maple Street neighbors on every
  sheet", "removes the organizer's email or phone", "turns off the dues (Season dues $40.00): the paid list is
  hidden"), and never writes a contact out. `sheets: []` is a valid dues-only roster. Once a file is imported, the
  import page links each sheet it made, to check and open.
- A person's `id` in an ordinary file names someone already here, kept exactly as they are. **A file with
  `exportedAt` is an export from some copy:** its person ids are that copy's, never matched with anyone here; everyone
  in it is added as a new person, and the dry run's summary says so. Imported people have no private link until the
  organizer makes one ("No private link yet").
- The export (`/organizer/export.json`) is one consistent snapshot, written as one line of JSON (indenting it would
  make it about 70% larger): the group, the roster in order with contacts and paid state, every sheet with its dates
  (cancelled ones too), slots and sign-ups with notes, waitlists in order, each sign-up's time and history (`addedBy`,
  `signedUpAt`, `promotedAt`, `told`), and for people to read: ids and `hasLink`. Never a link or a hash.
- **Importing an export into a fresh copy** restores the group, the roster with contacts and paid state, every sheet's
  settings, dates (cancelled ones too) and slots in order, and every sign-up with its note, confirmed or waiting in
  order, and its history: who added it, when it was made (`signedUpAt`), when it moved up from the waitlist
  (`promotedAt`), and whether the organizer marked its person told, each time never later than the import (another
  copy's clock may run a few minutes ahead). **The rule for `told`:** the file says only that the organizer had marked
  them told by the time of the export, so a restored sign-up is told at the export's own `exportedAt`. Because who
  added each sign-up is restored, one a member made in the old copy still refuses a later import with `replace` of its
  sheet, as it did there; someone moved up and not yet told is back in Needs attention ("… moved up from the
  waitlist", tagged "Moved up: tell them" on its sheet). It does not restore private links or a change the organizer
  made that nobody was told about yet (the export has no field for it, so the sheet's "Changed: tell them" does not
  come back). Only a file with `exportedAt` is restored this way: any other file's sign-ups are made by the import,
  never moved up and not told, whatever those fields say. The summary of an import that replaces sheets says how many
  sign-ups go with them ("replaces: snacks and its 12 sign-ups"); read it in the dry run first.
- **Restoring has the import's limits**, which are below the copy's own row caps: one file of at most 512 KB, 500
  people, 20 sheets of up to 200 dates (20 places each) and 2,000 sign-ups. A copy at the people and sign-up limits
  with short names, contacts and notes exports to about 480 KB (the database test measures it), so long notes can take
  such a copy past 512 KB. The export of a copy past any of these limits is a complete record to read, but it cannot
  be imported back in one go. The export's page says so.
- The CSV (`/organizer/sheets/<slug>/export.csv`): RFC 4180, every field quoted, UTF-8 with a byte order mark, CRLF; a
  cell starting with `= + - @`, a tab or a carriage return gets a leading `'`. Organizer only: it has contacts.

## Logs

`src/lib/log.ts` is the only way the app writes to its log: a fixed place name and, for a database error, its SQLSTATE
and constraint; for another error its class and code (like `Error ECONNREFUSED`); for a bad database setting its fixed
sentence. Never an error's message (PostgreSQL's can quote the failing values), a URL (a private link carries its
token), a name, a contact, a token or an error object. Route handlers catch their own errors, so no error object
reaches Next.js's log. That Next.js's own log holds no private link is proven from the captured log of a local server
(`qa/local-http-check.py --suite logs`); the platform's access logs can be read only on a real copy.

## Usage

The activity table records POSTs only, one row per successful business write inside its own transaction, by browser
(`__Host-ss_b`): `organizer` when the request carries a valid organizer cookie (even on a member's route), else
`member`. GETs record nothing. Rows older than 120 days are pruned. Two read-only queries:

```sql
-- Distinct member browsers in days 8–21 after handover.
select count(distinct a.browser) from activity a, app_state s
 where a.actor = 'member' and a.at >= s.retired_at + interval '7 days' and a.at < s.retired_at + interval '21 days';

-- The same, leaving out any browser that ever acted as the organizer.
select count(distinct a.browser) from activity a, app_state s
 where a.actor = 'member' and a.at >= s.retired_at + interval '7 days' and a.at < s.retired_at + interval '21 days'
   and a.browser not in (select browser from activity where actor = 'organizer');
```

Before handover `retired_at` is null and both count nothing, so a delivery check's member writes never count.

## What works differently on Tofu

- No emails, texts or reminders are sent; the calendar files' alarms and the organizer's weekly reminder file do that
  job, and the share buttons open the person's own WhatsApp, Messages or Mail.
- Pages show changes on reload; nothing is pushed.
- Behind Tofu's access code, a private link opened on a new phone may land on the copy's home page after the code is
  entered. The private-link box and the calendar file say: "If a page asks for an access code first, enter it, then
  open this link again." The public footer says: "Opened your private link and landed here? Open the link again."
  (Not yet seen on a real copy: check it against Tofu's current behaviour before promising anything exact.)
- A chat app's in-app browser keeps its own cookies: a person who opened their link in Safari and then the sheet inside
  WhatsApp is not remembered there. The answer is the same: open the private link again in that browser.
- Shared Wi-Fi shares the per-connection limits (Requests). How many people on one network an event can take before
  the limits matter is an observation to make on a real copy, not a number to promise.
- No calendar subscription.

## The live check

`qa/live-check.py`, Python 3 standard library only (3.9 or later), one copy at a time:

```sh
python3 -I qa/live-check.py https://<copy host> --mode <mode> --state <private dir>/state.json [options]
QA_PW=… python3 -I qa/live-check.py https://<copy host> --mode password --state …   # or --qa-pw-file <file>
python3 -I qa/live-check.py https://<copy host> --mode import --file draft.json [--apply] --state …
```

| Mode | When | Requests at most |
|---|---|---|
| `fresh` | a QA copy nobody has set up: setup, the import, claims, the four-claim race, the waitlist and promotion, links, calendar file, paid, privacy, Origin, headers, CSV, a rotated link | 55 |
| `delivery` | an organizer's copy while the agent holds the seat: the same core on an unlisted `zz-check-<random>` sheet with its own people, then it deletes them and proves from the export that the organizer's data is as it was | 60 |
| `password` | after QA_PW is saved as `ORGANIZER_PASSWORD` and the copy redeployed: the state, setup closed, the old seat refused, a wrong password refused, QA_PW signs in; no member writes | 12 |
| `read` | GET only, no cookies, safe after handover: `/`, the sheet (`--sheet <slug>` unless `/` shows one sheet in place), `/health`, headers, privacy of public pages | 8 |
| `seat` | right after the first deploy is online: takes the seat (one POST) and keeps its cookie in the state file | 4 |
| `import` | a dry run of `--file` with the saved seat; `--apply` imports it after the dry run passes | 4 |

The rules it keeps, whatever the mode:

- It prints `ok   `, `FAIL ` and `info ` lines and ends with `RESULT PASS` or `RESULT FAIL` (exit 0 or 1), within a
  170-second deadline. A line that must run and did not is a FAIL; nothing is skipped silently. Input it cannot read
  (a missing form, an unexpected page) is a FAIL, never a skip. In `fresh`, `delivery` and `password` each negative
  line has a positive control: on the same path wherever the mode can make one (the same address with this copy's
  Origin, a working cookie or a working link); the public pages' privacy lines (M21) look for values the same run saw
  on the pages allowed to show them (the person's own page, the organizer's export); G01 reads every Location the run
  was answered with and has no control. `read` has no cookie and no link by design, so its negative lines (R05, R06,
  R08) have no positive control, and R05 can look only for the contacts and words this check made itself in an earlier
  run on the copy, never the organizer's real ones: it prints how many it looked for, or that it had none ("not
  exercised").
- A browser User-Agent ending in `tofu-gallery-live-check`; this copy's Origin on every POST it means to be accepted.
  One request at a time, 400 ms apart; only the four-claim race is parallel. It never follows a link or redirect it
  did not name and never crawls; this is not a load test.
- Retries: 502, 503 and 504, three times, 5 seconds apart, only for a GET or a claim sent again with the same request
  id. Any other POST is never sent twice: the line fails, and what happened is read from the copy's state. A setup
  answer lost while the seat became held is a FAIL that says "Delete this copy and make a new one": nobody guesses who
  holds a seat.
- **It stops at once** at the platform's security checkpoint (a 403 or 429 that is not the app's own page, or
  `x-vercel-mitigated`): wait 10 minutes, never retry sooner or in a loop. It stops when sent to `/_tofu/access`: run
  the acceptance before an access code is set. It stops before a request that would exceed its budget.
- One run per copy at a time (a lock next to the state file). The state file is mode 600, refused inside a git
  checkout or when others can read it, and belongs to one copy. Evidence is kept next to it (`<state>.evidence/`, mode
  700): each answer the check read, with private links, cookie values and the password replaced, and in delivery mode
  the organizer's real people's names and contacts too. It is never committed or attached; a delivery run's evidence
  stays private all the same. No output line carries a link or a cookie.
- Its member writes come from one address: about a dozen per `fresh` or `delivery` run, against the 30-in-10-minutes
  limit. Wait 10 minutes before running a third time on one copy.
- Delivery never sends `group`, so the organizer's name, group and dues never change; its sheet is unlisted, so `/`
  never shows it. It removes only its own sheet and the people whose ids it recorded (or, if it stopped before reading
  them, whose names only it gives), and fails if the organizer's export differs afterwards. On a copy with no dues, its
  paid probe is optional and reported as not run. If it stopped at the checkpoint, `--mode delivery --cleanup-only`
  after 10 minutes removes what it left.

## Local servers

For a run of the built app over HTTP on this machine (docs/verification.md says what it proves). No check or test
starts a server: start each one yourself, in its own terminal, and stop it with Ctrl-C.

```sh
node scripts/preview-db.mjs setup --dir /tmp/ss-preview     # a cluster on 127.0.0.1:5439x, migrated; env.json (600)
env -u DATABASE_URL npm run build                           # once
node scripts/preview-server.mjs --env /tmp/ss-preview/env.json --port 3101 2>&1 | tee /tmp/ss-preview/server-3101.log
                                                            # a second terminal: 3102, and so on, up to 3105 for the
                                                            # five-server race; each log is for --suite logs
python3 -I qa/live-check.py http://127.0.0.1:3101 --mode fresh --state /tmp/ss-preview/live/state.json
node scripts/preview-db.mjs password --on --dir /tmp/ss-preview   # then restart the servers: that is the redeploy
python3 -I qa/live-check.py http://127.0.0.1:3101 --mode password --qa-pw-file /tmp/ss-preview/qa-pw --state /tmp/ss-preview/live/state.json
python3 -I qa/live-check.py http://127.0.0.1:3101 --mode read --state /tmp/ss-preview/live/state.json
node scripts/preview-db.mjs reset --dir /tmp/ss-preview          # setup open again (restart the servers if a password was on)
python3 -I qa/local-http-check.py --url http://127.0.0.1:3101 --url http://127.0.0.1:3102 --state /tmp/ss-preview/local/state.json
python3 -I qa/local-http-check.py --url … --state … --suite logs --log-file /tmp/ss-preview/server-3101.log --log-file /tmp/ss-preview/server-3102.log
node scripts/preview-db.mjs stop --remove --dir /tmp/ss-preview
```

`preview-server.mjs` refuses an `env.json` that is not this user's own mode-600 file naming a 127.0.0.1 database, and
starts `next start -H 127.0.0.1`. `preview-db.mjs` touches only a directory it marked as its own and only the postgres
whose command line names it. The local suites (`--suite all`: seat race, every POST route's Origin rule, headers on
exact paths, links, every organizer GET with forged cookies, ownership, the replayed form, the T01 race across the
given servers) send each simulated phone's own `X-Real-IP` from 192.0.2.0/24 so the per-connection limit counts phones
apart, as it would for real ones; no limit changes. Use a new state file after each reset.

## Delivery runbook

An agent delivers a copy by hand for one organizer. Nothing in a copy's code changes; the pin used is final for that
organizer. While the agent holds a copy's seat, it opens that copy's organizer pages in a browser profile of its own
with the seat's cookie from the state file (`seat.cookie`, sent as `__Host-ss_org`); `--mode import` uses it too. A
draft sheet shows only there.

1. **Material.** Collect the organizer's material (schedule, roster, dues list, paper sheet). Write at most five
   to-confirm items: a child's first name to change to a family name, an ambiguous date, a weekday that does not match
   its date, whether to include contacts (only if the organizer agrees), whether names show or "Taken". Drop medical
   notes, payment handles and affiliations the material does not support.
2. **Draft.** Write the `signup-sheet/1` file with `from` on each object (where in the material it came from). Run it
   on a test copy first: take that copy's seat (`--mode seat`), `--mode import --file draft.json` (dry run), import it
   there (`--apply`), and take screenshots of the sheet with the seat for the organizer to approve. Never correct a
   weekday silently.
3. **The account step (the organizer, not the agent):** the organizer signs in to Tofu and approves the agent's
   access to their account. The agent never asks for, receives or types the organizer's credentials.
4. **Copy, deploy, take the seat.** Copy the verified pin into the organizer's account and deploy. As soon as the copy
   is online: `--mode seat` (within minutes; the window is 24 hours from the database's creation, but anyone who opens
   the address meanwhile could take it). A seat that cannot be taken, or a lost setup answer, means a new copy, never
   a guess. Set `MAKE_ONE_URL` now if it is wanted (it is a public setting, saved before the password redeploy).
5. **Import and open.** `--mode import --file final.json` (dry run), then `--apply`. Open the sheet for sign-ups on
   its organizer page with the seat (Status: Open for sign-ups) when it looks right.
6. **Check.** `--mode delivery`: the whole core on a throwaway unlisted sheet, then removed, with the organizer's data
   proven unchanged. Then a person checks it by hand: open the public link on a real phone that is signed in to
   nothing here, sign up once as `Test (Tofu)` and cancel. The agent then deletes `Test (Tofu)` on the People page with
   the seat (before step 7, after which it has no way in), and compares five rows of the material with the sheet.
7. **The password (the organizer):** the organizer saves `ORGANIZER_PASSWORD` (at least 12 characters) in the app's
   Keys & settings in Tofu with "Hide this value after saving" on, then puts it online again ("Put it online now").
   The agent never sees it. From now on the agent has no way in. The app's own sentences say these steps in Tofu's
   words ("Keys & settings", "Hide this value after saving on", "put it online again"), never "deploy".
8. **Read check and hand over.** `--mode read` (with `--sheet <slug>` when `/` does not show one sheet in place: several
   open sheets, or an unlisted one). The organizer signs in on the organizer page with the password.
9. **Sharing.** If the organizer chose an access code, it is set now, after every check. Give the organizer: the
   public address and a QR code made outside the app, the two invite lines (Invite your group), and how to send this
   week's reminder (the dashboard's button, and "Remind me each week" for their own calendar). Tell them what the
   calendar files can and cannot do (Calendar files): the app sends nothing, and an alert depends on each person's
   calendar app. Never choose or change the organizer's sharing policy for them.

## Verification

`docs/verification.md` lists every requirement with the level it is proven at: unit, database, pooler, negative
control, the live check through the local bridge, HTTP on local servers, a browser, QA on a Tofu copy, and real
phones. What only a real deploy can show: the build's verified TLS and Tofu's grants, the platform's headers and logs,
the access-code door, shared-Wi-Fi behaviour, and calendar alerts on real phones.

## Licence

MIT (`LICENSE`), Copyright (c) 2026 Tofu. No third-party assets, fonts or code.
