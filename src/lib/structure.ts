// The organizer's changes to sheets, dates and slots (see TOFU.md, Concurrency), W6 capacity, W7 deletes, and the
// group's settings. Every change to a sheet, its dates or its slots locks the sheet FOR UPDATE first (locks.ts), so it
// waits for the sign-up changes in flight on that sheet and holds new ones off until it commits: a claim never decides
// on a date's day, start or cancellation that is about to change, and a delete sees every sign-up it deletes.
import type pg from 'pg';
import { checkCaps } from './caps';
import { type Db, inTransaction, isDbError } from './db';
import { recordActivity } from './identity';
import { lockSheets, lockSlots, promoteWaiting } from './locks';
import { stillOpen, type WriteContext } from './signups';
import { civilToday } from './time';
import { sha256 } from './tokens';

export type Missing = { kind: 'missing' };

export type SheetFields = {
  title: string;
  description: string;
  timezone: string;
  place: string;
  names: 'full' | 'taken';
  noteLabel: string;
  noteRequired: boolean;
  listed: boolean;
};

export type DateFields = { onDate: string; startsAt: string | null; endsAt: string | null; label: string; place: string };

export type SlotFields = { label: string; description: string; capacity: number };

/** The sheet a path's slug, date id or slot id belongs to, read without a lock (it never changes). */
async function sheetIdOf(db: Db, target: { slug: string } | { dateId: string } | { slotId: string }): Promise<string | null> {
  const [text, value] =
    'slug' in target
      ? ['select id from sheets where slug = $1', target.slug]
      : 'dateId' in target
        ? ['select sheet_id as id from dates where id = $1', target.dateId]
        : ['select sheet_id as id from slots where id = $1', target.slotId];
  const { rows } = await db.query<{ id: string }>(text, [value]);
  return rows[0]?.id ?? null;
}

/** Locks the sheet FOR UPDATE; null when it is gone. */
async function lockSheetFor(tx: Db, target: Parameters<typeof sheetIdOf>[1]) {
  const sheetId = await sheetIdOf(tx, target);
  if (!sheetId) return null;
  const [sheet] = await lockSheets(tx, [sheetId], 'update');
  return sheet ?? null;
}

/**
 * For a write that can move the last day of the organizer's weekly reminder (views.ts reminderSeason): the next
 * reminder revision, which the file's SEQUENCE reads (ics.ts reminderCalendar). A sequence takes no row lock and never
 * goes back, a rolled-back write's value included, so the file's SEQUENCE only grows, a shorter season included. Taken
 * last, just before the write commits.
 */
export async function reviseReminder(tx: Db): Promise<void> {
  await tx.query("select nextval('public.reminder_revision')");
}

// --- Sheets -------------------------------------------------------------------------------------------------------

export async function createSheet(
  pool: pg.Pool,
  input: SheetFields & { slug: string; status: 'draft' | 'open' | 'closed' },
  ctx: WriteContext
): Promise<{ kind: 'refused'; reason: 'slug' } | { kind: 'created'; slug: string }> {
  try {
    return await inTransaction(pool, async (tx) => {
      const taken = await tx.query('select 1 from sheets where slug = $1', [input.slug]);
      if (taken.rows.length > 0) return { kind: 'refused' as const, reason: 'slug' as const };
      await checkCaps(tx, { sheets: 1 });
      const { rows } = await tx.query<{ id: string }>(
        `insert into sheets (slug, title, description, timezone, place, names, status, note_label, note_required, listed, position)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, (select coalesce(max(position) + 1, 0) from sheets))
         returning id`,
        [input.slug, input.title, input.description, input.timezone, input.place, input.names, input.status, input.noteLabel, input.noteRequired, input.listed]
      );
      await recordActivity(tx, { actor: ctx.actor, kind: 'sheet_add', browser: ctx.browser, sheetId: rows[0]!.id });
      return { kind: 'created' as const, slug: input.slug };
    });
  } catch (error) {
    if (isDbError(error, '23505', 'sheets_slug_key')) return { kind: 'refused', reason: 'slug' };
    throw error;
  }
}

/**
 * A sheet's words and settings. Its time zone cannot change once anyone is signed up on it. Its slug never changes. A
 * new title, place or time zone is what people's calendar files show from the sheet (revised_at).
 */
export async function editSheet(
  pool: pg.Pool,
  input: SheetFields & { slug: string },
  ctx: WriteContext
): Promise<Missing | { kind: 'refused'; reason: 'timezone' } | { kind: 'saved' }> {
  return inTransaction(pool, async (tx) => {
    const sheet = await lockSheetFor(tx, { slug: input.slug });
    if (!sheet) return { kind: 'missing' as const };
    if (sheet.timezone !== input.timezone) {
      const held = await tx.query('select 1 from signups g join slots s on s.id = g.slot_id where s.sheet_id = $1 limit 1', [sheet.id]);
      if (held.rows.length > 0) return { kind: 'refused' as const, reason: 'timezone' as const };
    }
    await tx.query(
      `update sheets set title = $2, description = $3, timezone = $4, place = $5, names = $6, note_label = $7,
              note_required = $8, listed = $9, updated_at = now(),
              revised_at = case when (title, timezone, place) is distinct from ($2::text, $4::text, $5::text) then now() else revised_at end
        where id = $1`,
      [sheet.id, input.title, input.description, input.timezone, input.place, input.names, input.noteLabel, input.noteRequired, input.listed]
    );
    await recordActivity(tx, { actor: ctx.actor, kind: 'sheet_edit', browser: ctx.browser, sheetId: sheet.id });
    if (sheet.timezone !== input.timezone) await reviseReminder(tx);
    return { kind: 'saved' as const };
  });
}

export async function setSheetStatus(
  pool: pg.Pool,
  input: { slug: string; status: 'draft' | 'open' | 'closed' },
  ctx: WriteContext
): Promise<Missing | { kind: 'saved' }> {
  return inTransaction(pool, async (tx) => {
    const sheet = await lockSheetFor(tx, { slug: input.slug });
    if (!sheet) return { kind: 'missing' as const };
    await tx.query('update sheets set status = $2, updated_at = now() where id = $1', [sheet.id, input.status]);
    await recordActivity(tx, { actor: ctx.actor, kind: 'sheet_status', browser: ctx.browser, sheetId: sheet.id });
    await reviseReminder(tx);
    return { kind: 'saved' as const };
  });
}

// --- Dates --------------------------------------------------------------------------------------------------------

/** A date or a slot that would make a second one with the same name (dates_one_per_time, slots_one_label_per_date). */
export type Taken = { kind: 'refused'; reason: 'dateTaken' | 'labelTaken' };

/** The refusal for a unique violation of one date per day and time, or one label per date; else null. */
function takenRefusal(error: unknown): Taken | null {
  if (isDbError(error, '23505', 'dates_one_per_time')) return { kind: 'refused', reason: 'dateTaken' };
  if (isDbError(error, '23505', 'slots_one_label_per_date')) return { kind: 'refused', reason: 'labelTaken' };
  return null;
}

/** Runs a transaction whose insert or update may meet the one-per-day-and-time or one-label-per-date rule. */
async function refusingTaken<T>(work: () => Promise<T>): Promise<T | Taken> {
  try {
    return await work();
  } catch (error) {
    const taken = takenRefusal(error);
    if (taken) return taken;
    throw error;
  }
}

/**
 * "Add a date": one date, and with `withSlots` the same slots as the sheet's latest date. A day and start time the sheet
 * already has is refused (a repeated press of the button adds nothing).
 */
export async function addDate(
  pool: pg.Pool,
  input: { slug: string; date: DateFields; withSlots: boolean },
  ctx: WriteContext
): Promise<Missing | Taken | { kind: 'added'; slug: string; dateId: string; slots: number }> {
  return refusingTaken(() => inTransaction(pool, async (tx) => {
    const sheet = await lockSheetFor(tx, { slug: input.slug });
    if (!sheet) return { kind: 'missing' as const };
    const template = input.withSlots
      ? (
          await tx.query<{ label: string; description: string; capacity: number; position: number }>(
            `select label, description, capacity, position from slots
              where date_id = (select id from dates where sheet_id = $1 order by on_date desc, starts_at desc nulls last, id desc limit 1)
              order by position, id`,
            [sheet.id]
          )
        ).rows
      : [];
    await checkCaps(tx, { slots: template.length });
    const d = input.date;
    const made = await tx.query<{ id: string }>(
      'insert into dates (sheet_id, on_date, starts_at, ends_at, label, place) values ($1, $2, $3, $4, $5, $6) returning id',
      [sheet.id, d.onDate, d.startsAt, d.endsAt, d.label, d.place]
    );
    const dateId = made.rows[0]!.id;
    for (const slot of template) {
      await tx.query('insert into slots (sheet_id, date_id, label, description, capacity, position) values ($1, $2, $3, $4, $5, $6)', [
        sheet.id,
        dateId,
        slot.label,
        slot.description,
        slot.capacity,
        slot.position
      ]);
    }
    await recordActivity(tx, { actor: ctx.actor, kind: 'date_add', browser: ctx.browser, sheetId: sheet.id });
    await reviseReminder(tx);
    return { kind: 'added' as const, slug: sheet.slug, dateId, slots: template.length };
  }));
}

/**
 * "Add a date every week": one date on each of `days` at the same times and place, and with `withSlots` the places of
 * the sheet's latest date as it was before these. A day the sheet already has at that start time is skipped, so a
 * second press of the button adds nothing: it waits for the first on the sheet's lock, then finds every day taken. Two
 * statements whatever the number of days, so the sheet is held only briefly.
 */
export async function addWeeklyDates(
  pool: pg.Pool,
  input: { slug: string; days: readonly string[]; startsAt: string | null; endsAt: string | null; place: string; withSlots: boolean },
  ctx: WriteContext
): Promise<Missing | { kind: 'added'; slug: string; added: number; skipped: number }> {
  return inTransaction(pool, async (tx) => {
    const sheet = await lockSheetFor(tx, { slug: input.slug });
    if (!sheet) return { kind: 'missing' as const };
    const existing = await tx.query<{ onDate: string }>(
      `select on_date as "onDate" from dates
        where sheet_id = $1 and on_date = any($2::date[]) and coalesce(starts_at, time '24:00') = coalesce($3::time, time '24:00')`,
      [sheet.id, input.days, input.startsAt]
    );
    const taken = new Set(existing.rows.map((row) => row.onDate));
    const days = input.days.filter((day) => !taken.has(day));
    if (days.length === 0) return { kind: 'added' as const, slug: sheet.slug, added: 0, skipped: input.days.length };

    const template = input.withSlots
      ? (
          await tx.query<{ dateId: string | null; slots: number }>(
            `select t.id as "dateId", (select count(*)::int from slots s where s.date_id = t.id) as slots
               from (select id from dates where sheet_id = $1 order by on_date desc, starts_at desc nulls last, id desc limit 1) t`,
            [sheet.id]
          )
        ).rows[0] ?? null
      : null;
    await checkCaps(tx, { slots: (template?.slots ?? 0) * days.length });
    const made = await tx.query<{ id: string }>(
      `insert into dates (sheet_id, on_date, starts_at, ends_at, label, place)
       select $1, day, $3::time, $4::time, '', $5 from unnest($2::date[]) as day
       returning id`,
      [sheet.id, days, input.startsAt, input.endsAt, input.place]
    );
    if (template?.dateId && template.slots > 0) {
      await tx.query(
        `insert into slots (sheet_id, date_id, label, description, capacity, position)
         select $1, made.id, t.label, t.description, t.capacity, t.position
           from unnest($2::bigint[]) as made(id) cross join slots t
          where t.date_id = $3
          order by made.id, t.position, t.id`,
        [sheet.id, made.rows.map((row) => row.id), template.dateId]
      );
    }
    await recordActivity(tx, { actor: ctx.actor, kind: 'date_add', browser: ctx.browser, sheetId: sheet.id });
    await reviseReminder(tx);
    return { kind: 'added' as const, slug: sheet.slug, added: days.length, skipped: input.days.length - days.length };
  });
}

/**
 * A date's day, times, label and place. A change of day, times or place marks every sign-up on it changed and not told,
 * so the organizer's Needs attention lists them to tell. A date that is open again moves waiting people up. Another
 * date of the sheet at the same day and start time is refused.
 */
export async function editDate(
  pool: pg.Pool,
  input: { dateId: string; date: DateFields },
  ctx: WriteContext
): Promise<Missing | Taken | { kind: 'saved'; slug: string; changed: number }> {
  return refusingTaken(() => inTransaction(pool, async (tx) => {
    const sheet = await lockSheetFor(tx, { dateId: input.dateId });
    if (!sheet) return { kind: 'missing' as const };
    const current = await tx.query<{ onDate: string; startsAt: string | null; endsAt: string | null; place: string }>(
      'select on_date as "onDate", starts_at as "startsAt", ends_at as "endsAt", place from dates where id = $1',
      [input.dateId]
    );
    const before = current.rows[0];
    if (!before) return { kind: 'missing' as const };
    const slotIds = (await tx.query<{ id: string }>('select id from slots where date_id = $1', [input.dateId])).rows.map((row) => row.id);
    const slots = await lockSlots(tx, slotIds);
    const d = input.date;
    await tx.query(
      `update dates set on_date = $2, starts_at = $3, ends_at = $4, label = $5, place = $6,
              revised_at = case when (on_date, starts_at, ends_at, label, place) is distinct from ($2::date, $3::time, $4::time, $5::text, $6::text)
                           then now() else revised_at end
        where id = $1`,
      [input.dateId, d.onDate, d.startsAt, d.endsAt, d.label, d.place]
    );
    const time = (value: string | null) => value?.slice(0, 5) ?? null;
    const moved =
      before.onDate !== d.onDate || time(before.startsAt) !== time(d.startsAt) || time(before.endsAt) !== time(d.endsAt) || before.place !== d.place;
    let changed = 0;
    if (moved) {
      const marked = await tx.query('update signups set changed_at = now(), told_at = null where slot_id = any($1::bigint[])', [slotIds]);
      changed = marked.rowCount ?? 0;
    }
    for (const slot of slots) {
      if (stillOpen({ ...slot, onDate: d.onDate, startsAt: d.startsAt }, sheet.timezone, ctx.now)) await promoteWaiting(tx, slot.id);
    }
    await recordActivity(tx, { actor: ctx.actor, kind: 'date_edit', browser: ctx.browser, sheetId: sheet.id });
    if (before.onDate !== d.onDate) await reviseReminder(tx);
    return { kind: 'saved' as const, slug: sheet.slug, changed };
  }));
}

/**
 * "Cancel this date" and its undo. A cancelled date keeps its sign-ups for the organizer to move, and takes no claims,
 * moves or promotions; undoing it moves waiting people up into free places if the date is still ahead.
 */
export async function setDateCancelled(
  pool: pg.Pool,
  input: { dateId: string; cancelled: boolean },
  ctx: WriteContext
): Promise<Missing | { kind: 'saved'; slug: string; promoted: number }> {
  return inTransaction(pool, async (tx) => {
    const sheet = await lockSheetFor(tx, { dateId: input.dateId });
    if (!sheet) return { kind: 'missing' as const };
    const { rowCount } = await tx.query(
      `update dates set cancelled_at = case when $2 then coalesce(cancelled_at, now()) end,
              revised_at = case when (cancelled_at is not null) <> $2 then now() else revised_at end
        where id = $1`,
      [input.dateId, input.cancelled]
    );
    if (rowCount !== 1) return { kind: 'missing' as const };
    let promoted = 0;
    if (!input.cancelled) {
      const slotIds = (await tx.query<{ id: string }>('select id from slots where date_id = $1', [input.dateId])).rows.map((row) => row.id);
      for (const slot of await lockSlots(tx, slotIds)) {
        if (stillOpen(slot, sheet.timezone, ctx.now)) promoted += (await promoteWaiting(tx, slot.id)).length;
      }
    }
    const kind = input.cancelled ? 'date_cancel' : 'date_uncancel';
    await recordActivity(tx, { actor: ctx.actor, kind, browser: ctx.browser, sheetId: sheet.id });
    await reviseReminder(tx);
    return { kind: 'saved' as const, slug: sheet.slug, promoted };
  });
}

// --- Slots --------------------------------------------------------------------------------------------------------

/** A slot on one date, after its others. A label the date already has is refused. */
export async function addSlot(
  pool: pg.Pool,
  input: { dateId: string; slot: SlotFields },
  ctx: WriteContext
): Promise<Missing | Taken | { kind: 'added'; slug: string; slotId: string }> {
  return refusingTaken(() => inTransaction(pool, async (tx) => {
    const sheet = await lockSheetFor(tx, { dateId: input.dateId });
    if (!sheet) return { kind: 'missing' as const };
    await checkCaps(tx, { slots: 1 });
    const { rows } = await tx.query<{ id: string }>(
      `insert into slots (sheet_id, date_id, label, description, capacity, position)
       values ($1, $2, $3, $4, $5, (select coalesce(max(position) + 1, 0) from slots where date_id = $2))
       returning id`,
      [sheet.id, input.dateId, input.slot.label, input.slot.description, input.slot.capacity]
    );
    await recordActivity(tx, { actor: ctx.actor, kind: 'slot_add', browser: ctx.browser, sheetId: sheet.id });
    return { kind: 'added' as const, slug: sheet.slug, slotId: rows[0]!.id };
  }));
}

/** "Add a slot to every date": every date from today on (in the sheet's time zone) that has no slot with this label. */
export async function addSlotEveryDate(
  pool: pg.Pool,
  input: { slug: string; slot: SlotFields },
  ctx: WriteContext
): Promise<Missing | { kind: 'added'; slug: string; slots: number }> {
  return inTransaction(pool, async (tx) => {
    const sheet = await lockSheetFor(tx, { slug: input.slug });
    if (!sheet) return { kind: 'missing' as const };
    const { rows: dates } = await tx.query<{ id: string }>(
      `select d.id from dates d
        where d.sheet_id = $1 and d.on_date >= $2::date
          and not exists (select 1 from slots s where s.date_id = d.id and lower(s.label) = lower($3))
        order by d.id`,
      [sheet.id, civilToday(sheet.timezone, ctx.now), input.slot.label]
    );
    await checkCaps(tx, { slots: dates.length });
    for (const date of dates) {
      await tx.query(
        `insert into slots (sheet_id, date_id, label, description, capacity, position)
         values ($1, $2, $3, $4, $5, (select coalesce(max(position) + 1, 0) from slots where date_id = $2))`,
        [sheet.id, date.id, input.slot.label, input.slot.description, input.slot.capacity]
      );
    }
    await recordActivity(tx, { actor: ctx.actor, kind: 'slot_add', browser: ctx.browser, sheetId: sheet.id });
    return { kind: 'added' as const, slug: sheet.slug, slots: dates.length };
  });
}

/**
 * W6. A slot's label, description and capacity. A capacity below the people confirmed there is refused (the CHECK
 * refuses it too); a larger one moves waiting people up, earliest first, if the date is still open. A label another slot
 * of the date has is refused.
 */
export async function editSlot(
  pool: pg.Pool,
  input: { slotId: string; slot: SlotFields },
  ctx: WriteContext
): Promise<
  | Missing
  | Taken
  | { kind: 'refused'; reason: 'capacity'; slug: string; confirmed: number }
  | { kind: 'saved'; slug: string; promoted: number }
> {
  return refusingTaken(() => inTransaction(pool, async (tx) => {
    const sheet = await lockSheetFor(tx, { slotId: input.slotId });
    if (!sheet) return { kind: 'missing' as const };
    const [slot] = await lockSlots(tx, [input.slotId]);
    if (!slot) return { kind: 'missing' as const };
    if (input.slot.capacity < slot.confirmedCount) {
      return { kind: 'refused' as const, reason: 'capacity' as const, slug: sheet.slug, confirmed: slot.confirmedCount };
    }
    await tx.query(
      `update slots set label = $2, description = $3, capacity = $4,
              revised_at = case when (label, description) is distinct from ($2::text, $3::text) then now() else revised_at end
        where id = $1`,
      [slot.id, input.slot.label, input.slot.description, input.slot.capacity]
    );
    const promoted = input.slot.capacity > slot.capacity && stillOpen(slot, sheet.timezone, ctx.now) ? await promoteWaiting(tx, slot.id) : [];
    await recordActivity(tx, { actor: ctx.actor, kind: 'slot_edit', browser: ctx.browser, sheetId: sheet.id });
    return { kind: 'saved' as const, slug: sheet.slug, promoted: promoted.length };
  }));
}

// --- W7: delete a sheet, a date or a slot -------------------------------------------------------------------------

export type DeleteTarget = { kind: 'sheet'; slug: string } | { kind: 'date'; id: string } | { kind: 'slot'; id: string };

export type PersonToTell = {
  signupId: string;
  personId: string;
  name: string;
  contact: string;
  status: 'confirmed' | 'waiting';
  slotLabel: string;
  onDate: string;
};

/** What a delete's confirmation shows: everyone signed up in it, and `seen`, the hash of their sign-ups' ids. */
export type DeletionPreview = { slug: string; people: PersonToTell[]; seen: string };

const SCOPE = {
  sheet: 's.sheet_id = (select id from sheets where slug = $1)',
  date: 's.date_id = $1',
  slot: 's.id = $1'
} as const;

/** The confirmation's list (organizer only: it carries contacts). Null when the target is gone. */
export async function deletionPreview(db: Db, target: DeleteTarget): Promise<DeletionPreview | null> {
  const slug = await db.query<{ slug: string }>(
    target.kind === 'sheet'
      ? 'select slug from sheets where slug = $1'
      : `select h.slug from sheets h join ${target.kind === 'date' ? 'dates' : 'slots'} t on t.sheet_id = h.id where t.id = $1`,
    [target.kind === 'sheet' ? target.slug : target.id]
  );
  if (!slug.rows[0]) return null;
  const { rows } = await db.query<PersonToTell>(
    `select g.id as "signupId", p.id as "personId", p.name, p.contact, g.status, s.label as "slotLabel", d.on_date as "onDate"
       from signups g join slots s on s.id = g.slot_id join dates d on d.id = s.date_id join people p on p.id = g.person_id
      where ${SCOPE[target.kind]}
      order by d.on_date, s.position, s.id, g.status, g.queued_at, g.id`,
    [target.kind === 'sheet' ? target.slug : target.id]
  );
  return { slug: slug.rows[0].slug, people: rows, seen: seenDigest(rows.map((row) => row.signupId)) };
}

/** hex(sha256) of the sign-up ids, sorted as numbers and joined with commas. */
export function seenDigest(signupIds: readonly string[]): string {
  const sorted = [...signupIds].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
  return sha256(sorted.join(',')).toString('hex');
}

export type DeleteResult =
  | Missing
  /** Someone signed up or left since the confirmation was shown: nothing was deleted; here is the new list. */
  | { kind: 'changed'; preview: DeletionPreview }
  | { kind: 'deleted'; slug: string };

/**
 * W7. With the sheet locked FOR UPDATE and the slots in scope locked in id order, the confirmation's `seen` is computed
 * again. Any difference (a new sign-up, one cancelled or moved, a new slot with people) deletes nothing and answers the
 * new list. Sign-ups go with their slots (the foreign keys cascade); nobody is promoted.
 */
export async function deleteTarget(pool: pg.Pool, input: { target: DeleteTarget; seen: string }, ctx: WriteContext): Promise<DeleteResult> {
  return inTransaction(pool, async (tx): Promise<DeleteResult> => {
    const { target } = input;
    const sheet = await lockSheetFor(tx, target.kind === 'sheet' ? { slug: target.slug } : target.kind === 'date' ? { dateId: target.id } : { slotId: target.id });
    if (!sheet) return { kind: 'missing' };
    const scope = await tx.query<{ id: string }>(`select s.id from slots s where ${SCOPE[target.kind]}`, [
      target.kind === 'sheet' ? target.slug : target.id
    ]);
    await lockSlots(tx, scope.rows.map((row) => row.id));
    const preview = await deletionPreview(tx, target);
    if (!preview) return { kind: 'missing' };
    if (preview.seen !== input.seen) return { kind: 'changed', preview };

    if (target.kind === 'sheet') await tx.query('delete from sheets where id = $1', [sheet.id]);
    else if (target.kind === 'date') await tx.query('delete from dates where id = $1', [target.id]);
    else await tx.query('delete from slots where id = $1', [target.id]);
    // A deleted sheet's activity rows keep their count but lose their sheet (on delete set null).
    const sheetId = target.kind === 'sheet' ? null : sheet.id;
    await recordActivity(tx, { actor: ctx.actor, kind: `${target.kind}_delete`, browser: ctx.browser, sheetId });
    if (target.kind !== 'slot') await reviseReminder(tx);
    return { kind: 'deleted', slug: sheet.slug };
  });
}

// --- The group's settings -----------------------------------------------------------------------------------------

export type GroupSettings = {
  groupName: string;
  organizerName: string;
  organizerContact: string;
  duesLabel: string;
  duesAmountCents: number | null;
};

/** The group's name and organizer appear in people's calendar files (revised_at); dues never do. */
export async function saveSettings(pool: pg.Pool, input: GroupSettings, ctx: WriteContext): Promise<{ kind: 'saved' }> {
  return inTransaction(pool, async (tx) => {
    await tx.query(
      `update app_state set group_name = $1, organizer_name = $2, organizer_contact = $3, dues_label = $4, dues_amount_cents = $5,
              revised_at = case when (group_name, organizer_name, organizer_contact) is distinct from ($1::text, $2::text, $3::text)
                           then now() else revised_at end
        where id = 1`,
      [input.groupName, input.organizerName, input.organizerContact, input.duesLabel, input.duesLabel ? input.duesAmountCents : null]
    );
    await recordActivity(tx, { actor: ctx.actor, kind: 'settings', browser: ctx.browser, sheetId: null });
    return { kind: 'saved' as const };
  });
}
