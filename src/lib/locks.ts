// The lock order every write follows, and the steps the sign-up writes share (see TOFU.md, Concurrency). With one order
// two writes can wait for each other but never deadlock:
//
//   1. app_state FOR UPDATE: imports only, so two imports run one at a time. No sign-up change locks it, and the
//      organizer state's own statements (access.ts) run before a write's transaction, never inside it.
//   2. sheets, ascending id: FOR SHARE by every sign-up change (claim, cancel, move, swap, removal), so many run at
//      once on one sheet; FOR UPDATE by every change to a sheet, its dates or its slots (status, time zone, editing,
//      cancelling, adding or deleting a date or slot, deleting the sheet, an import's replace). A sheet's dates and
//      slots therefore change only while no sign-up change on it is in flight, and a sign-up change reads its dates'
//      eligibility (day, start, cancelled) without locking them: it cannot go stale before the commit.
//   3. slots, ascending id, FOR UPDATE.
//   4. sign-ups, ascending id, FOR UPDATE.
//   5. people rows: FOR KEY SHARE when a write checks the link of the member making it (identity.ts) or the person it
//      signs up; FOR UPDATE when removing a person everywhere, once it holds every sign-up of theirs it found. Always
//      once the write holds every slot it touches. After it, the write may still lock sign-ups, but only waiting ones
//      of those slots (a promotion), which nobody else can hold without the slot's lock. The removal reads the person's
//      sign-ups again under that lock, and nobody can sign a locked person up (the new row's foreign key needs them FOR
//      KEY SHARE), so the person's delete leaves its foreign-key check no sign-up to wait for. A people lock therefore
//      never sits inside a wait that can turn into a cycle.
//   6. the row caps' advisory lock (caps.ts), only in a write that adds rows.
//   Then the inserts, the activity row, COMMIT.
//
// A write that touches people rows and nothing else (a profile edit, a new link, paid, a roster edit) locks its one row
// and takes no other lock after it. Inserting a sign-up takes FOR KEY SHARE on its person (the foreign key), always in
// step 5's place. An activity row with a sheet takes FOR KEY SHARE on that sheet, which its write already holds.
//
// A slot's sheet_id and date_id never change after it is made, and a sign-up only ever moves between slots of one
// sheet, so the sheet to lock is read from the slot unlocked. After locking, a write re-reads what it read before (a
// sign-up's slot, the set of sign-ups it found) and, if anything moved, throws Restart (db.ts) to run again from BEGIN.
import type { Db } from './db';

export type LockedSheet = {
  id: string;
  slug: string;
  status: 'draft' | 'open' | 'closed';
  timezone: string;
  names: 'full' | 'taken';
  noteRequired: boolean;
};

export type LockedSlot = {
  id: string;
  sheetId: string;
  dateId: string;
  capacity: number;
  confirmedCount: number;
  /** The date's day ('YYYY-MM-DD'), start ('HH:MM:SS' or null) and whether it is cancelled. */
  onDate: string;
  startsAt: string | null;
  cancelled: boolean;
};

export type LockedSignup = {
  id: string;
  slotId: string;
  personId: string;
  status: 'confirmed' | 'waiting';
};

const SHEET_COLUMNS = 'id, slug, status, timezone, names, note_required as "noteRequired"';

/** Step 2: these sheets, locked in ascending id order. */
export async function lockSheets(tx: Db, sheetIds: readonly string[], mode: 'share' | 'update'): Promise<LockedSheet[]> {
  const { rows } = await tx.query<LockedSheet>(
    `select ${SHEET_COLUMNS} from sheets where id = any($1::bigint[]) order by id for ${mode === 'share' ? 'share' : 'update'}`,
    [sheetIds]
  );
  return rows;
}

/** Step 2, for writes that start from slots: the sheets those slots belong to. */
export async function lockSheetsOfSlots(
  tx: Db,
  slotIds: readonly string[],
  mode: 'share' | 'update'
): Promise<LockedSheet[]> {
  const { rows } = await tx.query<LockedSheet>(
    `select ${SHEET_COLUMNS} from sheets
      where id in (select sheet_id from slots where id = any($1::bigint[]))
      order by id for ${mode === 'share' ? 'share' : 'update'}`,
    [slotIds]
  );
  return rows;
}

/** Step 3: these slots FOR UPDATE in ascending id order, with their date's eligibility. Missing slots are left out. */
export async function lockSlots(tx: Db, slotIds: readonly string[]): Promise<LockedSlot[]> {
  const { rows } = await tx.query<LockedSlot>(
    `select s.id, s.sheet_id as "sheetId", s.date_id as "dateId", s.capacity, s.confirmed_count as "confirmedCount",
            d.on_date as "onDate", d.starts_at as "startsAt", d.cancelled_at is not null as cancelled
       from slots s join dates d on d.id = s.date_id
      where s.id = any($1::bigint[])
      order by s.id for update of s`,
    [slotIds]
  );
  return rows;
}

/**
 * Step 4: these sign-ups FOR UPDATE in ascending id order. With `personId`, only that person's: every /me read or
 * write of a sign-up filters by its owner inside the transaction, so another person's id finds nothing.
 */
export async function lockSignups(
  tx: Db,
  signupIds: readonly string[],
  owner: { personId: string } | null = null
): Promise<LockedSignup[]> {
  const { rows } = await tx.query<LockedSignup>(
    `select id, slot_id as "slotId", person_id as "personId", status from signups
      where id = any($1::bigint[]) and ($2::bigint is null or person_id = $2::bigint)
      order by id for update`,
    [signupIds, owner?.personId ?? null]
  );
  return rows;
}

/**
 * While this transaction holds the slot's lock: moves the slot's earliest waiting sign-ups up into its free places, in
 * (queued_at, id) order, and returns them. Call it whenever places may have opened (a cancel, a removal, a move out, a
 * larger capacity) and before a newcomer takes a place, so people already waiting go first. Whether a date is still
 * eligible for promotion (not past its start) is the caller's decision.
 */
export async function promoteWaiting(tx: Db, slotId: string): Promise<{ id: string; personId: string }[]> {
  const { rows } = await tx.query<{ id: string; personId: string }>(
    `update signups set status = 'confirmed', promoted_at = now(), told_at = null
      where id in (
        select id from signups
         where slot_id = $1 and status = 'waiting'
         order by queued_at, id
         limit greatest(0, (select capacity - confirmed_count from slots where id = $1))
         for update)
      returning id, person_id as "personId"`,
    [slotId]
  );
  return rows;
}

/** A waiting sign-up's number: 1 + the waiting sign-ups ahead of it in its slot. Null when it is not waiting. */
export async function waitlistPosition(db: Db, signupId: string): Promise<number | null> {
  const { rows } = await db.query<{ position: number }>(
    `select 1 + (select count(*)::int from signups w
                  where w.slot_id = s.slot_id and w.status = 'waiting' and (w.queued_at, w.id) < (s.queued_at, s.id)) as position
       from signups s where s.id = $1 and s.status = 'waiting'`,
    [signupId]
  );
  return rows[0]?.position ?? null;
}
