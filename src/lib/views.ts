// What each audience may read (see TOFU.md, Privacy): one query function per audience, each selecting only the columns
// its pages may carry. A public page must never be handed a row with a contact, paid state, token, person id or sign-up
// time (what a page is handed can end up in its HTML): these functions never select them for it. On a sheet whose
// names are 'taken', the public query selects no names.
import type { Db } from './db';
import type { SignupEvent } from './ics';
import { civilToday } from './time';

type DateRow = { id: string; onDate: string; startsAt: string | null; endsAt: string | null; label: string; place: string; cancelled: boolean };
type SlotRow = { id: string; dateId: string; label: string; description: string; capacity: number; confirmed: number; waiting: number };

const SHEET_PUBLIC = `h.slug, h.title, h.description, h.timezone, h.place, h.names, h.status, h.listed, h.note_label as "noteLabel",
  h.note_required as "noteRequired"`;

// --- Anyone -------------------------------------------------------------------------------------------------------

export type PublicEntry = {
  /** The name as typed, or null on a sheet whose names are taken (the page shows "Taken"). */
  name: string | null;
  /** Notes are public on every sheet. */
  note: string;
};

export type PublicSheet = {
  slug: string;
  title: string;
  description: string;
  timezone: string;
  place: string;
  names: 'full' | 'taken';
  status: 'draft' | 'open' | 'closed';
  listed: boolean;
  noteLabel: string;
  noteRequired: boolean;
  groupName: string;
  /** The organizer's name for the public footer (never their contact). */
  organizerName: string;
  dates: (DateRow & { slots: (Omit<SlotRow, 'dateId'> & { entries: PublicEntry[] })[] })[];
};

/**
 * A sheet for its public page and claim form, in three queries: the sheet with the group's public words, its dates and
 * slots with counts, and the confirmed sign-ups' names (only on a 'full' sheet) and notes. Waiting people are a count.
 * A draft is null unless `draft` is allowed (the organizer's preview).
 */
export async function publicSheetView(db: Db, slug: string, options: { draft: boolean }): Promise<PublicSheet | null> {
  const head = await db.query<Omit<PublicSheet, 'dates'> & { id: string }>(
    `select h.id, ${SHEET_PUBLIC}, a.group_name as "groupName", a.organizer_name as "organizerName"
       from sheets h cross join app_state a
      where h.slug = $1 and a.id = 1`,
    [slug]
  );
  const sheet = head.rows[0];
  if (!sheet || (sheet.status === 'draft' && !options.draft)) return null;

  const places = await db.query<DateRow & { slot: Omit<SlotRow, 'dateId'> | null }>(
    `select d.id, d.on_date as "onDate", d.starts_at as "startsAt", d.ends_at as "endsAt", d.label, d.place,
            d.cancelled_at is not null as cancelled,
            case when s.id is null then null else json_build_object(
              'id', s.id::text, 'label', s.label, 'description', s.description, 'capacity', s.capacity,
              'confirmed', s.confirmed_count,
              'waiting', (select count(*) from signups w where w.slot_id = s.id and w.status = 'waiting')) end as slot
       from dates d left join slots s on s.date_id = d.id
      where d.sheet_id = $1
      order by d.on_date, d.starts_at nulls first, d.id, s.position, s.id`,
    [sheet.id]
  );
  const entries = await db.query<{ slotId: string; name: string | null; note: string }>(
    sheet.names === 'full'
      ? `select g.slot_id as "slotId", p.name, g.note
           from signups g join slots s on s.id = g.slot_id join people p on p.id = g.person_id
          where s.sheet_id = $1 and g.status = 'confirmed'
          order by g.slot_id, g.queued_at, g.id`
      : `select g.slot_id as "slotId", null::text as name, g.note
           from signups g join slots s on s.id = g.slot_id
          where s.sheet_id = $1 and g.status = 'confirmed'
          order by g.slot_id, g.queued_at, g.id`,
    [sheet.id]
  );

  const bySlot = new Map<string, PublicEntry[]>();
  for (const row of entries.rows) {
    const list = bySlot.get(row.slotId) ?? [];
    list.push({ name: row.name, note: row.note });
    bySlot.set(row.slotId, list);
  }
  const dates: PublicSheet['dates'] = [];
  for (const row of places.rows) {
    let date = dates.at(-1);
    if (!date || date.id !== row.id) {
      const { slot: _, ...fields } = row;
      date = { ...fields, slots: [] };
      dates.push(date);
    }
    if (row.slot) date.slots.push({ ...row.slot, entries: bySlot.get(row.slot.id) ?? [] });
  }
  const { id: _, ...publicFields } = sheet;
  return { ...publicFields, dates };
}

export type ListedSheet = { slug: string; title: string; description: string; place: string; timezone: string; dates: { onDate: string; startsAt: string | null }[] };

/**
 * The home page's open sheets: only sheets that are open and listed, with their dates that are not cancelled (the page
 * keeps those from today on). One query.
 */
export async function listedOpenSheets(db: Db): Promise<ListedSheet[]> {
  const { rows } = await db.query<ListedSheet>(
    `select h.slug, h.title, h.description, h.place, h.timezone,
            coalesce((select json_agg(json_build_object('onDate', d.on_date, 'startsAt', d.starts_at) order by d.on_date, d.starts_at nulls first)
                        from dates d where d.sheet_id = h.id and d.cancelled_at is null and d.on_date >= current_date - 1), '[]') as dates
       from sheets h
      where h.status = 'open' and h.listed
      order by h.position, h.id`
  );
  return rows.map((row) => ({ ...row, dates: row.dates.map((date) => ({ onDate: date.onDate, startsAt: date.startsAt?.slice(0, 5) ?? null })) }));
}

/** The places the person this phone remembers holds on one sheet: their own, by slot (no contact, no other person). */
export type MyPlaces = { name: string; places: { signupId: string; slotId: string; status: 'confirmed' | 'waiting'; position: number | null }[] };

export async function myPlacesOnSheet(db: Db, personId: string, slug: string): Promise<MyPlaces | null> {
  const person = await db.query<{ name: string }>('select name from people where id = $1', [personId]);
  if (!person.rows[0]) return null;
  const { rows } = await db.query<MyPlaces['places'][number]>(
    `select g.id as "signupId", g.slot_id as "slotId", g.status,
            case when g.status = 'waiting' then 1 + (select count(*)::int from signups w
              where w.slot_id = g.slot_id and w.status = 'waiting' and (w.queued_at, w.id) < (g.queued_at, g.id)) end as position
       from signups g join slots s on s.id = g.slot_id join sheets h on h.id = s.sheet_id
      where g.person_id = $1 and h.slug = $2
      order by g.id`,
    [personId, slug]
  );
  return { name: person.rows[0].name, places: rows };
}

/** A slot's public words, for the message that asks the group to take a place someone left. */
export type SlotWords = {
  slotLabel: string;
  onDate: string;
  startsAt: string | null;
  sameDay: number;
  sheetSlug: string;
  sheetTitle: string;
  sheetStatus: string;
};

export async function slotWords(db: Db, slotId: string): Promise<SlotWords | null> {
  const { rows } = await db.query<SlotWords>(
    `select s.label as "slotLabel", d.on_date as "onDate", d.starts_at as "startsAt",
            (select count(*)::int from dates o where o.sheet_id = d.sheet_id and o.on_date = d.on_date) as "sameDay",
            h.slug as "sheetSlug", h.title as "sheetTitle", h.status as "sheetStatus"
       from slots s join dates d on d.id = s.date_id join sheets h on h.id = s.sheet_id
      where s.id = $1 and h.status <> 'draft'`,
    [slotId]
  );
  return rows[0] ?? null;
}

// --- The person themselves (their private page and their own calendar files) ------------------------------------

export type MySignup = {
  id: string;
  status: 'confirmed' | 'waiting';
  /** 1 + the waiting sign-ups ahead in the slot, for a waiting one. */
  position: number | null;
  note: string;
  promotedAt: Date | null;
  changedAt: Date | null;
  queuedAt: Date;
  slotId: string;
  slotLabel: string;
  slotDescription: string;
  onDate: string;
  startsAt: string | null;
  endsAt: string | null;
  dateLabel: string;
  datePlace: string;
  dateCancelled: boolean;
  sheetSlug: string;
  sheetTitle: string;
  sheetTimezone: string;
  sheetPlace: string;
  sheetStatus: 'open' | 'closed';
  noteLabel: string;
  noteRequired: boolean;
};

export type MeView = {
  name: string;
  /** Their own contact, on their own page only. */
  contact: string;
  groupName: string;
  organizerName: string;
  organizerContact: string;
  signups: MySignup[];
};

const MY_SIGNUP = `select g.id, g.status, g.note, g.promoted_at as "promotedAt", g.changed_at as "changedAt", g.queued_at as "queuedAt",
       case when g.status = 'waiting' then 1 + (select count(*)::int from signups w
         where w.slot_id = g.slot_id and w.status = 'waiting' and (w.queued_at, w.id) < (g.queued_at, g.id)) end as position,
       s.id as "slotId", s.label as "slotLabel", s.description as "slotDescription",
       d.on_date as "onDate", d.starts_at as "startsAt", d.ends_at as "endsAt", d.label as "dateLabel", d.place as "datePlace",
       d.cancelled_at is not null as "dateCancelled",
       h.slug as "sheetSlug", h.title as "sheetTitle", h.timezone as "sheetTimezone", h.place as "sheetPlace", h.status as "sheetStatus",
       h.note_label as "noteLabel", h.note_required as "noteRequired"
  from signups g join slots s on s.id = g.slot_id join dates d on d.id = s.date_id join sheets h on h.id = s.sheet_id`;

/** A person's own page: their name and contact, and their sign-ups on sheets that are not drafts. */
export async function meView(db: Db, personId: string): Promise<MeView | null> {
  const person = await db.query<Omit<MeView, 'signups'>>(
    `select p.name, p.contact, a.group_name as "groupName", a.organizer_name as "organizerName",
            a.organizer_contact as "organizerContact"
       from people p cross join app_state a where p.id = $1 and a.id = 1`,
    [personId]
  );
  if (!person.rows[0]) return null;
  const signups = await db.query<MySignup>(
    `${MY_SIGNUP} where g.person_id = $1 and h.status <> 'draft' order by d.on_date, d.starts_at nulls first, s.position, s.id, g.id`,
    [personId]
  );
  return { ...person.rows[0], signups: signups.rows };
}

/** One of the person's own sign-ups (G6: another person's id finds nothing), for its calendar file or a confirm page. */
export async function mySignup(db: Db, personId: string, signupId: string): Promise<MySignup | null> {
  const { rows } = await db.query<MySignup>(`${MY_SIGNUP} where g.id = $1 and g.person_id = $2 and h.status <> 'draft'`, [signupId, personId]);
  return rows[0] ?? null;
}

// --- The organizer ------------------------------------------------------------------------------------------------

export type OrganizerSignup = {
  id: string;
  personId: string;
  name: string;
  contact: string;
  hasLink: boolean;
  /** Paid state, only when the group has dues. */
  paid: boolean | null;
  status: 'confirmed' | 'waiting';
  position: number | null;
  note: string;
  addedBy: 'member' | 'organizer' | 'import';
  signedUpAt: Date;
  promotedAt: Date | null;
  changedAt: Date | null;
  toldAt: Date | null;
  /** How many places this person holds on this sheet (the page marks more than 3). */
  placesOnSheet: number;
};

export type OrganizerSheet = Omit<PublicSheet, 'dates' | 'organizerName'> & {
  id: string;
  duesLabel: string;
  dates: (DateRow & { slots: (Omit<SlotRow, 'dateId'> & { signups: OrganizerSignup[] })[] })[];
};

/** A sheet for the organizer: everything but links (only whether a person has one). Any status. */
export async function organizerView(db: Db, slug: string): Promise<OrganizerSheet | null> {
  const head = await db.query<Omit<OrganizerSheet, 'dates'>>(
    `select h.id, ${SHEET_PUBLIC}, a.group_name as "groupName", a.dues_label as "duesLabel"
       from sheets h cross join app_state a where h.slug = $1 and a.id = 1`,
    [slug]
  );
  const sheet = head.rows[0];
  if (!sheet) return null;
  const places = await db.query<DateRow & { slot: Omit<SlotRow, 'dateId'> | null }>(
    `select d.id, d.on_date as "onDate", d.starts_at as "startsAt", d.ends_at as "endsAt", d.label, d.place,
            d.cancelled_at is not null as cancelled,
            case when s.id is null then null else json_build_object(
              'id', s.id::text, 'label', s.label, 'description', s.description, 'capacity', s.capacity,
              'confirmed', s.confirmed_count,
              'waiting', (select count(*) from signups w where w.slot_id = s.id and w.status = 'waiting')) end as slot
       from dates d left join slots s on s.date_id = d.id
      where d.sheet_id = $1
      order by d.on_date, d.starts_at nulls first, d.id, s.position, s.id`,
    [sheet.id]
  );
  const people = await db.query<OrganizerSignup & { slotId: string }>(
    `select g.id, g.slot_id as "slotId", p.id as "personId", p.name, p.contact, p.token_hash is not null as "hasLink",
            case when a.dues_label <> '' then p.paid end as paid, g.status, g.note, g.added_by as "addedBy",
            g.created_at as "signedUpAt", g.promoted_at as "promotedAt", g.changed_at as "changedAt", g.told_at as "toldAt",
            case when g.status = 'waiting' then 1 + (select count(*)::int from signups w
              where w.slot_id = g.slot_id and w.status = 'waiting' and (w.queued_at, w.id) < (g.queued_at, g.id)) end as position,
            (select count(*)::int from signups o join slots os on os.id = o.slot_id
              where o.person_id = g.person_id and os.sheet_id = s.sheet_id) as "placesOnSheet"
       from signups g join slots s on s.id = g.slot_id join people p on p.id = g.person_id cross join app_state a
      where s.sheet_id = $1 and a.id = 1
      order by g.slot_id, g.status, g.queued_at, g.id`,
    [sheet.id]
  );
  const bySlot = new Map<string, OrganizerSignup[]>();
  for (const { slotId, ...row } of people.rows) {
    const list = bySlot.get(slotId) ?? [];
    list.push(row);
    bySlot.set(slotId, list);
  }
  const dates: OrganizerSheet['dates'] = [];
  for (const row of places.rows) {
    let date = dates.at(-1);
    if (!date || date.id !== row.id) {
      const { slot: _, ...fields } = row;
      date = { ...fields, slots: [] };
      dates.push(date);
    }
    if (row.slot) date.slots.push({ ...row.slot, signups: bySlot.get(row.slot.id) ?? [] });
  }
  return { ...sheet, dates };
}

/** A sheet's name, for the organizer's confirmations (any status). */
export async function sheetHead(db: Db, slug: string): Promise<{ slug: string; title: string; status: string } | null> {
  const { rows } = await db.query<{ slug: string; title: string; status: string }>('select slug, title, status from sheets where slug = $1', [slug]);
  return rows[0] ?? null;
}

/** The group's words and dues, for the organizer's pages. */
export type GroupView = { groupName: string; organizerName: string; organizerContact: string; duesLabel: string; duesAmountCents: number | null };

export async function groupView(db: Db): Promise<GroupView> {
  const { rows } = await db.query<GroupView>(
    `select group_name as "groupName", organizer_name as "organizerName", organizer_contact as "organizerContact",
            dues_label as "duesLabel", dues_amount_cents as "duesAmountCents"
       from app_state where id = 1`
  );
  if (!rows[0]) throw new Error('app_state has no row');
  return rows[0];
}

export type SheetSummary = {
  id: string;
  slug: string;
  title: string;
  status: 'draft' | 'open' | 'closed';
  listed: boolean;
  timezone: string;
  /** Every date with its places' totals; the page keeps the ones ahead. */
  dates: { onDate: string; startsAt: string | null; cancelled: boolean; capacity: number; confirmed: number; waiting: number }[];
};

/** A sign-up the organizer should tell someone about: moved up from the waitlist, or changed by the organizer. */
export type ToTell = {
  id: string;
  personId: string;
  name: string;
  contact: string;
  status: 'confirmed' | 'waiting';
  promotedAt: Date | null;
  changedAt: Date | null;
  /** Whether they have a private link (their message tells them to use it only then). */
  hasLink: boolean;
  slotLabel: string;
  onDate: string;
  startsAt: string | null;
  endsAt: string | null;
  cancelled: boolean;
  sheetSlug: string;
  sheetTitle: string;
  sheetTimezone: string;
  /** The sheet's names: on a 'taken' sheet a message naming the person is never offered for the group. */
  sheetNames: 'full' | 'taken';
  /** How many dates of the sheet fall on that day (a sentence names the time when more than one does). */
  sameDay: number;
};

/** A date in the next days with its places and the people confirmed on them (organizer only: contacts). */
export type ComingDate = {
  sheetSlug: string;
  sheetTitle: string;
  sheetTimezone: string;
  dateId: string;
  onDate: string;
  startsAt: string | null;
  endsAt: string | null;
  label: string;
  place: string;
  slots: { id: string; label: string; capacity: number; confirmed: number; waiting: number; people: { id: string; name: string; contact: string; note: string }[] }[];
};

export type OrganizerHome = {
  group: GroupView;
  sheets: SheetSummary[];
  toTell: ToTell[];
  coming: ComingDate[];
  /** People not marked paid, when the group has dues; else null. */
  unpaid: number | null;
};

/**
 * The organizer's home page in five queries: the group, every sheet with its dates' totals, the sign-ups to tell
 * about, the dates of open sheets around the next week (with who is on them), and how many have not paid.
 */
export async function organizerHome(db: Db): Promise<OrganizerHome> {
  const group = await groupView(db);
  const sheets = await db.query<SheetSummary>(
    `select h.id, h.slug, h.title, h.status, h.listed, h.timezone,
            coalesce((select json_agg(json_build_object(
                'onDate', d.on_date, 'startsAt', d.starts_at, 'cancelled', d.cancelled_at is not null,
                'capacity', (select coalesce(sum(s.capacity), 0) from slots s where s.date_id = d.id),
                'confirmed', (select coalesce(sum(s.confirmed_count), 0) from slots s where s.date_id = d.id),
                'waiting', (select count(*) from signups w join slots s on s.id = w.slot_id where s.date_id = d.id and w.status = 'waiting')
              ) order by d.on_date, d.starts_at nulls first) from dates d where d.sheet_id = h.id), '[]') as dates
       from sheets h order by h.position, h.id`
  );
  const toTell = await db.query<ToTell>(
    `select g.id, p.id as "personId", p.name, p.contact, g.status, g.promoted_at as "promotedAt", g.changed_at as "changedAt",
            p.token_hash is not null as "hasLink",
            s.label as "slotLabel", d.on_date as "onDate", d.starts_at as "startsAt", d.ends_at as "endsAt",
            d.cancelled_at is not null as cancelled, h.slug as "sheetSlug", h.title as "sheetTitle", h.timezone as "sheetTimezone",
            h.names as "sheetNames",
            (select count(*)::int from dates o where o.sheet_id = d.sheet_id and o.on_date = d.on_date) as "sameDay"
       from signups g join people p on p.id = g.person_id join slots s on s.id = g.slot_id join dates d on d.id = s.date_id
            join sheets h on h.id = s.sheet_id
      where g.told_at is null and (g.changed_at is not null or (g.promoted_at is not null and g.status = 'confirmed'))
        and d.on_date >= current_date - 1
      order by d.on_date, d.starts_at nulls first, g.id
      limit 200`
  );
  const coming = await db.query<Omit<ComingDate, 'slots'> & { slot: ComingDate['slots'][number] | null }>(
    `select h.slug as "sheetSlug", h.title as "sheetTitle", h.timezone as "sheetTimezone", d.id as "dateId", d.on_date as "onDate",
            d.starts_at as "startsAt", d.ends_at as "endsAt", d.label, case when d.place <> '' then d.place else h.place end as place,
            case when s.id is null then null else json_build_object(
              'id', s.id::text, 'label', s.label, 'capacity', s.capacity, 'confirmed', s.confirmed_count,
              'waiting', (select count(*) from signups w where w.slot_id = s.id and w.status = 'waiting'),
              'people', coalesce((select json_agg(json_build_object('id', g.id::text, 'name', p.name, 'contact', p.contact, 'note', g.note)
                                                  order by g.queued_at, g.id)
                                    from signups g join people p on p.id = g.person_id
                                   where g.slot_id = s.id and g.status = 'confirmed'), '[]')) end as slot
       from sheets h join dates d on d.sheet_id = h.id left join slots s on s.date_id = d.id
      where h.status = 'open' and d.cancelled_at is null and d.on_date between current_date - 1 and current_date + 8
      order by d.on_date, d.starts_at nulls first, h.position, h.id, d.id, s.position, s.id`
  );
  const unpaid = group.duesLabel
    ? (await db.query<{ n: number }>('select count(*)::int as n from people where not paid')).rows[0]?.n ?? 0
    : null;

  const dates: ComingDate[] = [];
  for (const { slot, ...row } of coming.rows) {
    let date = dates.at(-1);
    if (!date || date.dateId !== row.dateId) {
      date = { ...row, slots: [] };
      dates.push(date);
    }
    if (slot) date.slots.push(slot);
  }
  return {
    group,
    sheets: sheets.rows.map((sheet) => ({ ...sheet, dates: sheet.dates.map((date) => ({ ...date, startsAt: date.startsAt?.slice(0, 5) ?? null })) })),
    toTell: toTell.rows,
    coming: dates,
    unpaid
  };
}

/** One sign-up for the organizer's focused pages (move, swap) and the "Told them" note. */
export type OrganizerSignupView = {
  id: string;
  personId: string;
  name: string;
  contact: string;
  status: 'confirmed' | 'waiting';
  slotId: string;
  slotLabel: string;
  onDate: string;
  startsAt: string | null;
  endsAt: string | null;
  sheetSlug: string;
  sheetTitle: string;
};

export async function organizerSignup(db: Db, signupId: string): Promise<OrganizerSignupView | null> {
  const { rows } = await db.query<OrganizerSignupView>(
    `select g.id, p.id as "personId", p.name, p.contact, g.status, s.id as "slotId", s.label as "slotLabel", d.on_date as "onDate",
            d.starts_at as "startsAt", d.ends_at as "endsAt", h.slug as "sheetSlug", h.title as "sheetTitle"
       from signups g join people p on p.id = g.person_id join slots s on s.id = g.slot_id join dates d on d.id = s.date_id
            join sheets h on h.id = s.sheet_id
      where g.id = $1`,
    [signupId]
  );
  return rows[0] ?? null;
}

/** One date for the organizer's focused pages (edit, add a place, cancel, delete). */
export type OrganizerDateView = {
  id: string;
  onDate: string;
  startsAt: string | null;
  endsAt: string | null;
  label: string;
  place: string;
  cancelled: boolean;
  sheetSlug: string;
  sheetTitle: string;
  sheetTimezone: string;
  sameDay: number;
};

export async function organizerDate(db: Db, dateId: string): Promise<OrganizerDateView | null> {
  const { rows } = await db.query<OrganizerDateView>(
    `select d.id, d.on_date as "onDate", d.starts_at as "startsAt", d.ends_at as "endsAt", d.label, d.place,
            d.cancelled_at is not null as cancelled, h.slug as "sheetSlug", h.title as "sheetTitle", h.timezone as "sheetTimezone",
            (select count(*)::int from dates o where o.sheet_id = d.sheet_id and o.on_date = d.on_date) as "sameDay"
       from dates d join sheets h on h.id = d.sheet_id where d.id = $1`,
    [dateId]
  );
  return rows[0] ?? null;
}

/** One slot for the organizer's focused pages (edit, add someone, delete), with the people already on it. */
export type OrganizerSlotView = OrganizerDateView & {
  slotId: string;
  slotLabel: string;
  slotDescription: string;
  capacity: number;
  confirmed: number;
  waiting: number;
  noteLabel: string;
  noteRequired: boolean;
  personIds: string[];
};

export async function organizerSlot(db: Db, slotId: string): Promise<OrganizerSlotView | null> {
  const { rows } = await db.query<OrganizerSlotView>(
    `select d.id, d.on_date as "onDate", d.starts_at as "startsAt", d.ends_at as "endsAt", d.label, d.place,
            d.cancelled_at is not null as cancelled, h.slug as "sheetSlug", h.title as "sheetTitle", h.timezone as "sheetTimezone",
            (select count(*)::int from dates o where o.sheet_id = d.sheet_id and o.on_date = d.on_date) as "sameDay",
            s.id as "slotId", s.label as "slotLabel", s.description as "slotDescription", s.capacity, s.confirmed_count as confirmed,
            (select count(*)::int from signups w where w.slot_id = s.id and w.status = 'waiting') as waiting,
            h.note_label as "noteLabel", h.note_required as "noteRequired",
            coalesce((select array_agg(g.person_id::text) from signups g where g.slot_id = s.id), '{}') as "personIds"
       from slots s join dates d on d.id = s.date_id join sheets h on h.id = s.sheet_id where s.id = $1`,
    [slotId]
  );
  return rows[0] ?? null;
}

/** The roster: everyone, with how many sign-ups each has, their link and paid state, and same-name markers. */
export type RosterPerson = {
  id: string;
  name: string;
  contact: string;
  hasLink: boolean;
  linkMadeAt: Date | null;
  paid: boolean;
  paidAmountCents: number | null;
  paidNote: string;
  signups: number;
  sameName: boolean;
};

export async function rosterView(db: Db): Promise<RosterPerson[]> {
  const { rows } = await db.query<RosterPerson>(
    `select p.id, p.name, p.contact, p.token_hash is not null as "hasLink", p.link_made_at as "linkMadeAt", p.paid,
            p.paid_amount_cents as "paidAmountCents", p.paid_note as "paidNote",
            (select count(*)::int from signups g where g.person_id = p.id) as signups,
            count(*) over (partition by lower(btrim(p.name))) > 1 as "sameName"
       from people p
      order by lower(p.name), p.id`
  );
  return rows;
}

/** One person for the organizer: their fields, paid state and every sign-up. */
export type PersonView = RosterPerson & {
  signupList: {
    id: string;
    status: 'confirmed' | 'waiting';
    position: number | null;
    note: string;
    slotLabel: string;
    onDate: string;
    startsAt: string | null;
    endsAt: string | null;
    cancelled: boolean;
    sheetSlug: string;
    sheetTitle: string;
    sheetTimezone: string;
  }[];
};

export async function personView(db: Db, personId: string): Promise<PersonView | null> {
  const person = await db.query<RosterPerson>(
    `select p.id, p.name, p.contact, p.token_hash is not null as "hasLink", p.link_made_at as "linkMadeAt", p.paid,
            p.paid_amount_cents as "paidAmountCents", p.paid_note as "paidNote",
            (select count(*)::int from signups g where g.person_id = p.id) as signups,
            (select count(*) from people o where lower(btrim(o.name)) = lower(btrim(p.name))) > 1 as "sameName"
       from people p where p.id = $1`,
    [personId]
  );
  if (!person.rows[0]) return null;
  const signups = await db.query<PersonView['signupList'][number]>(
    `select g.id, g.status, g.note,
            case when g.status = 'waiting' then 1 + (select count(*)::int from signups w
              where w.slot_id = g.slot_id and w.status = 'waiting' and (w.queued_at, w.id) < (g.queued_at, g.id)) end as position,
            s.label as "slotLabel", d.on_date as "onDate", d.starts_at as "startsAt", d.ends_at as "endsAt",
            d.cancelled_at is not null as cancelled, h.slug as "sheetSlug", h.title as "sheetTitle", h.timezone as "sheetTimezone"
       from signups g join slots s on s.id = g.slot_id join dates d on d.id = s.date_id join sheets h on h.id = s.sheet_id
      where g.person_id = $1
      order by d.on_date, d.starts_at nulls first, s.position, s.id`,
    [personId]
  );
  return { ...person.rows[0], signupList: signups.rows };
}

/** Everyone, for the "Add someone" picker: id, name and contact (to tell people with one name apart). */
export async function rosterChoices(db: Db): Promise<{ id: string; name: string; contact: string }[]> {
  const { rows } = await db.query<{ id: string; name: string; contact: string }>(
    'select id, name, contact from people order by lower(name), id limit 2000'
  );
  return rows;
}

// --- Calendar files (the person's own; ics.ts writes them) ---------------------------------------------------------

/** One of the person's own sign-ups as its calendar event shows it, with its status (only confirmed ones get a file). */
export type CalendarEntry = SignupEvent & { status: 'confirmed' | 'waiting'; sheetSlug: string };

// `revisedAt` is the latest change of anything the event shows; `sequence` counts the seconds from the sign-up's
// creation to it (ics.ts). A sign-up restored from an export keeps the time it was made (from the year 2000 on, never
// later than its import), which never changes afterwards: the count is never negative, fits an int until 2068, and
// grows only as `revisedAt` does. Only that person's sign-ups, on sheets that are not drafts.
const CALENDAR = `select g.id as "signupId", g.status, g.note, s.label as "slotLabel", s.description as "slotDescription",
       d.on_date as "onDate", d.starts_at as "startsAt", d.ends_at as "endsAt", d.label as "dateLabel",
       case when d.place <> '' then d.place else h.place end as place, d.cancelled_at is not null as cancelled,
       h.slug as "sheetSlug", h.title as "sheetTitle", h.timezone as "sheetTimezone", p.name as "personName",
       a.group_name as "groupName", a.organizer_name as "organizerName", a.organizer_contact as "organizerContact",
       r.at as "revisedAt", floor(extract(epoch from r.at - g.created_at))::int as sequence
  from signups g join slots s on s.id = g.slot_id join dates d on d.id = s.date_id join sheets h on h.id = s.sheet_id
       join people p on p.id = g.person_id cross join app_state a
       cross join lateral (select greatest(g.created_at, g.revised_at, g.queued_at, g.promoted_at, g.changed_at, s.revised_at,
                                           d.revised_at, h.revised_at, p.revised_at, p.link_made_at, a.revised_at) as at) r
 where g.person_id = $1 and a.id = 1 and h.status <> 'draft'`;

/** One of the person's own sign-ups for its calendar file, any status (G6: another person's id finds nothing). */
export async function myCalendarEntry(db: Db, personId: string, signupId: string): Promise<CalendarEntry | null> {
  const { rows } = await db.query<CalendarEntry>(`${CALENDAR} and g.id = $2`, [personId, signupId]);
  return rows[0] ?? null;
}

/** The person's confirmed sign-ups on dates from today on (each in its sheet's time zone), cancelled dates included. */
export async function myUpcomingCalendar(db: Db, personId: string, now: Date = new Date()): Promise<CalendarEntry[]> {
  const { rows } = await db.query<CalendarEntry>(
    `${CALENDAR} and g.status = 'confirmed' order by d.on_date, d.starts_at nulls first, s.position, s.id, g.id`,
    [personId]
  );
  return rows.filter((row) => row.onDate >= civilToday(row.sheetTimezone, now));
}

/**
 * For the organizer's weekly reminder: the last date still ahead (not cancelled) on any open sheet, the time zone of the
 * first open sheet that has one, and the reminder revision every write that can move that last day takes (structure.ts
 * reviseReminder), or null when no open sheet has a date ahead.
 */
export async function reminderSeason(db: Db, now: Date = new Date()): Promise<{ timezone: string; lastDate: string; revision: number } | null> {
  const { rows } = await db.query<{ timezone: string; lastDate: string }>(
    `select h.timezone, max(d.on_date) as "lastDate"
       from sheets h join dates d on d.sheet_id = h.id
      where h.status = 'open' and d.cancelled_at is null
      group by h.id, h.timezone, h.position
      order by h.position, h.id`
  );
  let season: { timezone: string; lastDate: string } | null = null;
  for (const row of rows) {
    if (row.lastDate < civilToday(row.timezone, now)) continue;
    if (!season) season = { timezone: row.timezone, lastDate: row.lastDate };
    else if (row.lastDate > season.lastDate) season.lastDate = row.lastDate;
  }
  if (!season) return null;
  const revision = await db.query<{ revision: string }>(
    'select case when is_called then last_value else 0 end as revision from public.reminder_revision'
  );
  return { ...season, revision: Number(revision.rows[0]!.revision) };
}
