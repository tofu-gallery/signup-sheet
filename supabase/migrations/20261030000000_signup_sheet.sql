-- The sign-up sheet's schema (see TOFU.md, Database). scripts/tofu-migrate.mjs applies this file at build time, whole,
-- in one transaction. A later migration ends with the same row-level-security and revoke lines for whatever it adds.

-- One row: the organizer's setup seat and the group's own settings.
--
-- Each `revised_at` below is when something a person's own calendar file shows from that row last changed (the
-- group's name and organizer, a sheet's title and place, a date's day, times, words and cancellation, a slot's words, a
-- person's name, a sign-up's note and place). A calendar file's SEQUENCE counts the seconds from its sign-up's creation
-- to the latest of them, so it grows exactly when the event changes, never just because it is downloaded again.
create table public.app_state (
  id smallint primary key default 1 check (id = 1),
  created_at timestamptz not null default now(),
  seat_state text not null default 'open' check (seat_state in ('open', 'held', 'retired')),
  seat_hash bytea check (seat_hash is null or octet_length(seat_hash) = 32),
  seat_taken_at timestamptz,
  seat_until timestamptz,
  retired_at timestamptz,
  group_name text not null default '' check (char_length(group_name) <= 80),
  organizer_name text not null default '' check (char_length(organizer_name) <= 60),
  organizer_contact text not null default '' check (char_length(organizer_contact) <= 200),
  dues_label text not null default '' check (char_length(dues_label) <= 60),
  dues_amount_cents integer check (dues_amount_cents between 0 and 10000000),
  revised_at timestamptz not null default now(),
  -- The last import the import page applied: sha256 of its form's request id, so a second press of the button (no
  -- JavaScript, or a page sent again) imports nothing more. Checked and set under the import's lock on this row.
  import_request_hash bytea check (import_request_hash is null or octet_length(import_request_hash) = 32),
  check ((seat_state = 'held') = (seat_hash is not null and seat_until is not null)),
  check ((seat_state = 'retired') = (retired_at is not null))
);
insert into public.app_state (id) values (1) on conflict (id) do nothing;

create table public.sheets (
  id bigint generated always as identity primary key,
  slug text not null unique check (slug ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$'),
  title text not null check (char_length(btrim(title)) between 1 and 120),
  description text not null default '' check (char_length(description) <= 1000),
  timezone text not null default 'America/New_York' check (char_length(timezone) between 1 and 64),
  place text not null default '' check (char_length(place) <= 200),
  names text not null default 'full' check (names in ('full', 'taken')),
  status text not null default 'draft' check (status in ('draft', 'open', 'closed')),
  listed boolean not null default true,
  note_label text not null default '' check (char_length(note_label) <= 40),
  note_required boolean not null default false,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revised_at timestamptz not null default now()
);

create table public.dates (
  id bigint generated always as identity primary key,
  sheet_id bigint not null references public.sheets (id) on delete cascade,
  on_date date not null,
  starts_at time,
  ends_at time,
  label text not null default '' check (char_length(label) <= 80),
  place text not null default '' check (char_length(place) <= 200),
  cancelled_at timestamptz,
  revised_at timestamptz not null default now(),
  unique (id, sheet_id),
  check (ends_at is null or (starts_at is not null and ends_at > starts_at))
);
create index dates_by_sheet on public.dates (sheet_id, on_date, starts_at);
-- A sheet has one date per day and start time (24:00, which no start can be, stands for "no time"), so a day and a
-- time always name one date: in the import and export format, in share texts, and after a repeated "Add a date".
create unique index dates_one_per_time on public.dates (sheet_id, on_date, coalesce(starts_at, time '24:00'));

-- A slot's sheet_id and date_id never change after it is made (the lock order in src/lib/locks.ts relies on it).
create table public.slots (
  id bigint generated always as identity primary key,
  sheet_id bigint not null,
  date_id bigint not null,
  label text not null check (char_length(btrim(label)) between 1 and 80),
  description text not null default '' check (char_length(description) <= 300),
  capacity integer not null check (capacity between 1 and 500),
  confirmed_count integer not null default 0,
  position integer not null default 0,
  revised_at timestamptz not null default now(),
  foreign key (date_id, sheet_id) references public.dates (id, sheet_id) on delete cascade,
  constraint slots_within_capacity check (confirmed_count >= 0 and confirmed_count <= capacity),
  -- A date and a label name one slot (the import and export format, share texts, a repeated "Add a slot").
  constraint slots_one_label_per_date unique (date_id, label)
);
create index slots_by_date on public.slots (date_id, position, id);
create index slots_by_sheet on public.slots (sheet_id);

create table public.people (
  id bigint generated always as identity primary key,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  contact text not null default '' check (char_length(contact) <= 200),
  token_hash bytea unique check (token_hash is null or octet_length(token_hash) = 32),
  link_made_at timestamptz,
  paid boolean not null default false,
  paid_amount_cents integer check (paid_amount_cents between 0 and 10000000),
  paid_note text not null default '' check (char_length(paid_note) <= 200),
  paid_at timestamptz,
  added_by text not null check (added_by in ('member', 'organizer', 'import')),
  created_at timestamptz not null default now(),
  revised_at timestamptz not null default now()
);

-- request_hash is sha256 of the claim form's request id, never the id itself (see TOFU.md, Members and their links).
create table public.signups (
  id bigint generated always as identity primary key,
  slot_id bigint not null references public.slots (id) on delete cascade,
  person_id bigint not null references public.people (id) on delete restrict,
  status text not null check (status in ('confirmed', 'waiting')),
  note text not null default '' check (char_length(note) <= 200),
  queued_at timestamptz not null default clock_timestamp(),
  promoted_at timestamptz,
  changed_at timestamptz,
  told_at timestamptz,
  added_by text not null check (added_by in ('member', 'organizer', 'import')),
  request_hash bytea unique check (request_hash is null or octet_length(request_hash) = 32),
  created_at timestamptz not null default now(),
  revised_at timestamptz not null default now(),
  unique (slot_id, person_id)
);
create index signups_queue on public.signups (slot_id, status, queued_at, id);
create index signups_by_person on public.signups (person_id);
-- The organizer's Needs attention list: moved up or changed by the organizer, and not marked told yet.
create index signups_to_tell on public.signups (id)
  where told_at is null and (promoted_at is not null or changed_at is not null);

create table public.activity (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor text not null check (actor in ('member', 'organizer')),
  kind text not null check (kind ~ '^[a-z_]{1,20}$'),
  browser text not null check (browser ~ '^[A-Za-z0-9_-]{22}$'),
  sheet_id bigint references public.sheets (id) on delete set null
);
create index activity_by_actor on public.activity (actor, at);
-- For pruning rows older than 120 days, and for the sheet delete's "set null", which would otherwise scan the table.
create index activity_by_time on public.activity (at);
create index activity_by_sheet on public.activity (sheet_id) where sheet_id is not null;

create table public.throttle (
  key text primary key check (char_length(key) <= 80),
  window_start timestamptz not null,
  hits integer not null check (hits >= 0)
);

-- The organizer's "Remind me each week" file repeats until the day after the last date ahead on an open sheet. Every
-- write that can move that day (a sheet's status, time zone or deletion; a date added, changed, cancelled, restored or
-- deleted; an import of sheets) takes the next value here, and the file's SEQUENCE is the latest one, so it only ever
-- grows: a shorter season replaces the longer one in a calendar instead of reading as an older version of it.
create sequence public.reminder_revision;

-- The capacity backstop: every change to a confirmed sign-up moves its slot's count by one, on the slot's row, so
-- slots_within_capacity refuses an over-full slot even if the app's own check were wrong. A trigger that counted rows
-- would not hold under READ COMMITTED; an UPDATE of one row serializes.
create function public.signups_keep_count() returns trigger
  language plpgsql
  security invoker
  set search_path = ''
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') and old.status = 'confirmed' then
    update public.slots set confirmed_count = confirmed_count - 1 where id = old.slot_id;
  end if;
  if tg_op in ('INSERT', 'UPDATE') and new.status = 'confirmed' then
    update public.slots set confirmed_count = confirmed_count + 1 where id = new.slot_id;
  end if;
  return null;
end
$$;
create trigger signups_keep_count after insert or delete or update of status, slot_id on public.signups
  for each row execute function public.signups_keep_count();

-- Row-level security on, with no policy: the app's own connection owns the tables; the Data API's roles get nothing.
-- On databases made before 2026-10-30, Supabase's old default privileges grant every new table, sequence and function
-- in public to anon and authenticated as it is created, so the revokes below are needed as well.
alter table public.app_state enable row level security;
alter table public.sheets enable row level security;
alter table public.dates enable row level security;
alter table public.slots enable row level security;
alter table public.people enable row level security;
alter table public.signups enable row level security;
alter table public.activity enable row level security;
alter table public.throttle enable row level security;
revoke execute on function public.signups_keep_count() from public;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = r) then
      execute format('revoke all on table public.app_state, public.sheets, public.dates, public.slots, public.people, public.signups, public.activity, public.throttle from %I', r);
      execute format('revoke all on all sequences in schema public from %I', r);
      execute format('revoke all on function public.signups_keep_count() from %I', r);
    end if;
  end loop;
end
$$;
