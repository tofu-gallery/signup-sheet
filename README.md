# Sign-up sheet

Sign-ups for a group's turns, shifts, dishes and dues. Share one link: people pick a date by name, and a waitlist
moves up by itself when someone cancels.

- Make a sheet of dates with places, like one family bringing snacks each Saturday, two drivers per away game, or
  mains, sides and desserts for a potluck.
- People sign up with just a name, with no account, and change or cancel with their own private link. A calendar file
  and an "Add to Google Calendar" link put each date in their own calendar, which can remind them (the file asks for a
  reminder; the calendar app decides).
- The organizer sees who moved up from the waitlist and who to tell, sends this week's reminder to the group chat,
  ticks who has paid the dues (a record only: the app takes no payments), and imports or exports everything as one
  file.

It is a Next.js app with a PostgreSQL database, made to run on [Tofu](https://trytofu.ai). `TOFU.md` explains how it
runs there, who can open the organizer pages, what each page may show, and how a copy is delivered and checked.

## Use it on Tofu

1. Copy it from Tofu's app gallery. Your copy has its own address and its own database.
2. Within 24 hours of the copy first going online, open its address and press "Set up this app as its organizer". That
   browser is the organizer for up to 7 days.
3. To sign in from any device, save `ORGANIZER_PASSWORD` (at least 12 characters) in the app's Keys & settings in Tofu
   with "Hide this value after saving" on, then put it online again. This also opens the organizer page if nobody
   pressed Set up in time.
4. Make a sheet, or paste a file like the ones in `examples/`, with your own dates, into Import and export (Check this
   file, then Import it). Open it for sign-ups and send "Invite your group" to the group chat.

## Run it locally

Node 22 and PostgreSQL 14. The tests also need PgBouncer (its own install, for the pooled tests), Python 3.9 or later
(the live check and its tests) and openssl (the TLS test). The PATH line below is for macOS with Homebrew; elsewhere,
put PostgreSQL 14's bin directory (`initdb`, `pg_ctl`) on PATH or name it in `SIGNUP_SHEET_PG_BIN`, and put
`pgbouncer` on PATH or name it in `SIGNUP_SHEET_PGBOUNCER`.

```sh
npm ci
export PATH=/opt/homebrew/opt/postgresql@14/bin:$PATH   # initdb, pg_ctl; pgbouncer must be on PATH too
npm run typecheck
npm test                    # unit tests, then every database test, one file at a time, each on a throwaway cluster
python3 -I qa/test_live_check.py                        # the live check's own unit tests
```

To look at the app itself: `node scripts/preview-db.mjs setup` makes a local database and saves its settings
privately, `env -u DATABASE_URL npm run build` builds once (without `DATABASE_URL` the migrate step applies nothing),
and `node scripts/preview-server.mjs --env /tmp/ss-preview/env.json --port 3101` serves it on 127.0.0.1 (see TOFU.md,
Local servers).

## Files

- `src/app/**/route.ts`: every page and form (route handlers answering HTML; no client framework).
- `src/lib/`: access, the Origin guard, cookies, sign-ups and their locks, import and export, calendar files, share
  texts, time rules, the HTML renderer. `src/words.ts`: every sentence the app shows or shares.
- `supabase/migrations/`: the schema, applied by `scripts/tofu-migrate.mjs` at build time.
- `examples/`: a soccer snack rotation with dues, a potluck, a dues-only roster.
- `qa/live-check.py`: the plain-HTTP check of a copy; `qa/local-http-check.py`: the local server checks;
  `qa/browser-check.mjs`: the browser check of a running copy (docs/verification.md).
- `docs/verification.md`: what is proven, and at which level.

## Licence

MIT. See `LICENSE`.
