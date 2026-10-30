// The import (see TOFU.md, Import and export): W10, its transaction, and the import as the organizer runs it.
//
// import-format.ts reads and checks the whole file first and builds an ImportPlan; a file it refuses never reaches the
// database. What depends on the rows already here (a sheet with the same slug, sign-ups people made on it, the people
// the file names by id, the row caps) is checked again inside the transaction, under its locks, before its first write.
// Every refusal is thrown, so the transaction rolls back and nothing it did stays (inTransaction commits whatever its
// work returns). A check (dry run) reads the same things without locks and writes nothing at all.
//
// Its locks follow locks.ts: app_state FOR UPDATE first (so two imports run one at a time; nothing else that locks a
// sheet, slot or sign-up ever waits for app_state), then the sheets it replaces FOR UPDATE in id order, then the people
// the file names by id FOR KEY SHARE (none can be removed before it commits; a claim may still update their contact),
// then the row caps' exclusive lock. It signs people up only on the sheets it makes. The slots and sign-ups of a sheet
// it replaces go with that sheet's delete, after the people locks: no sign-up change can be on a sheet it holds FOR
// UPDATE, so nobody else holds them. Once it holds the caps' lock no other write can make a sheet, so a sheet with one
// of its slugs made meanwhile is seen then, and the import starts again from BEGIN to decide on it.
import type pg from 'pg';
import { words } from '../words';
import { type CappedTable, checkCaps, ROW_CAPS, RowCapError } from './caps';
import { type Db, inTransaction, Restart } from './db';
import { recordActivity } from './identity';
import { readImportFile, type ImportRefusalText, type ReadImport } from './import-format';
import { lockSheets } from './locks';
import type { WriteContext } from './signups';
import { type DateFields, type GroupSettings, reviseReminder, type SheetFields, type SlotFields } from './structure';
import { dateWords, formatDate } from './time';
import { sha256 } from './tokens';
import { formatCents } from './validation';

/** Which of the group's settings the file sets: a field it leaves out stays as it is. */
export type ImportGroup = Partial<GroupSettings>;

export type ImportPlan = {
  /** Replace sheets whose slug is already here (only while nobody signed up on them through the page). */
  replace: boolean;
  /**
   * The file is an export (it has `exportedAt`): every person in it is made as a new person, and the ids it gives them
   * (the copy it came from) are never matched with anyone here. Its sign-ups carry their history (`signups` below).
   */
  exported?: boolean;
  /** The group's settings the file sets, or null to leave them all as they are (the delivery check's sheets carry none). */
  group: ImportGroup | null;
  people: {
    key: string;
    /** A person already here, kept as they are; their name must still match. Null: a new person, with no link. */
    existingId: string | null;
    name: string;
    contact: string;
    paid: boolean;
    paidAmountCents: number | null;
    paidNote: string;
  }[];
  sheets: (SheetFields & {
    slug: string;
    status: 'draft' | 'open' | 'closed';
    dates: (DateFields & { cancelled?: boolean; slots: SlotFields[] })[];
    /**
     * In file order; a place is a date's and a slot's index in this plan. Waiting ones queue in this order. An export's
     * sign-ups carry their history (import-format.ts history): who added each one, when it was made, when it moved up,
     * when its person was told (ISO moments). Left out, a sign-up is made by this import, never moved up and not told.
     */
    signups: {
      date: number;
      slot: number;
      person: string;
      note: string;
      status: 'confirmed' | 'waiting';
      addedBy?: 'member' | 'organizer' | 'import';
      signedUpAt?: string | null;
      promotedAt?: string | null;
      toldAt?: string | null;
    }[];
  })[];
};

export type ImportRefusal =
  /** The import page's form was applied already (its request id). */
  | { kind: 'refused'; reason: 'repeated' }
  | { kind: 'refused'; reason: 'exists'; slug: string }
  | { kind: 'refused'; reason: 'member-signups'; slug: string }
  | { kind: 'refused'; reason: 'person'; key: string }
  | { kind: 'refused'; reason: 'cap'; table: CappedTable };

export type ImportCounts = { people: number; sheets: number; dates: number; slots: number; signups: number };

/**
 * What the import found here: the sheets it replaces (by slug, in file order), the sign-ups on them that go with them
 * (added by the organizer or by an import), and the people it keeps (by key).
 */
export type ImportFound = { replaced: string[]; removing: number; kept: string[] };

export type ImportResult = ImportRefusal | ({ kind: 'imported'; counts: ImportCounts } & ImportFound);
export type ImportCheck = ImportRefusal | ({ kind: 'checked'; counts: ImportCounts } & ImportFound);

/** A refusal found inside the transaction: thrown so that it rolls back. */
class Refused extends Error {
  constructor(readonly refusal: ImportRefusal) {
    super('the import is refused');
    this.name = 'Refused';
  }
}

export function importCounts(plan: ImportPlan): ImportCounts {
  return {
    people: plan.people.filter((person) => person.existingId === null).length,
    sheets: plan.sheets.length,
    dates: plan.sheets.reduce((n, sheet) => n + sheet.dates.length, 0),
    slots: plan.sheets.reduce((n, sheet) => n + sheet.dates.reduce((m, date) => m + date.slots.length, 0), 0),
    signups: plan.sheets.reduce((n, sheet) => n + sheet.signups.length, 0)
  };
}

type Here = { replaced: { id: string; slug: string }[]; removing: number; kept: string[] };

/**
 * What the plan meets here, refusing (by throwing) when a sheet with one of its slugs exists and the plan does not
 * replace, when a sheet it replaces has sign-ups people made themselves, or when a person it names by id is not here
 * under that name. With `lock`, inside the import's transaction: the sheets it replaces are locked FOR UPDATE (no
 * sign-up change on them is in flight or can start) and the people it names FOR KEY SHARE.
 */
async function findHere(db: Db, plan: ImportPlan, lock: boolean): Promise<Here> {
  const slugs = plan.sheets.map((sheet) => sheet.slug);
  const same = (await db.query<{ id: string; slug: string }>('select id, slug from sheets where slug = any($1::text[]) order by id', [slugs])).rows;
  const inFileOrder = (found: readonly string[]) => slugs.filter((slug) => found.includes(slug));
  if (same.length > 0 && !plan.replace) {
    throw new Refused({ kind: 'refused', reason: 'exists', slug: inFileOrder(same.map((row) => row.slug))[0]! });
  }
  let replaced = same;
  if (lock && same.length > 0) {
    const locked = new Set((await lockSheets(db, same.map((row) => row.id), 'update')).map((sheet) => sheet.id));
    replaced = same.filter((row) => locked.has(row.id));
  }
  const selfMade = await db.query<{ slug: string }>(
    `select distinct h.slug from signups g join slots s on s.id = g.slot_id join sheets h on h.id = s.sheet_id
      where h.id = any($1::bigint[]) and g.added_by = 'member'`,
    [replaced.map((row) => row.id)]
  );
  if (selfMade.rows.length > 0) {
    throw new Refused({ kind: 'refused', reason: 'member-signups', slug: inFileOrder(selfMade.rows.map((row) => row.slug))[0]! });
  }
  // The sign-ups a replace deletes, for the summary. A restored export's sign-ups keep who added them, so one a member
  // made in the copy it came from refuses a replace here, as it did there.
  const removing = await db.query<{ n: number }>(
    'select count(*)::int as n from signups g join slots s on s.id = g.slot_id where s.sheet_id = any($1::bigint[])',
    [replaced.map((row) => row.id)]
  );

  const named = plan.people.filter((person) => person.existingId !== null);
  const found = await db.query<{ id: string; name: string }>(
    `select id, name from people where id = any($1::bigint[]) order by id${lock ? ' for key share' : ''}`,
    [named.map((person) => person.existingId)]
  );
  for (const person of named) {
    if (!found.rows.some((row) => row.id === person.existingId && row.name === person.name)) {
      throw new Refused({ kind: 'refused', reason: 'person', key: person.key });
    }
  }
  return { replaced, removing: removing.rows[0]!.n, kept: named.map((person) => person.key) };
}

function found(plan: ImportPlan, here: Here): ImportFound {
  const slugs = here.replaced.map((row) => row.slug);
  return { replaced: plan.sheets.map((sheet) => sheet.slug).filter((slug) => slugs.includes(slug)), removing: here.removing, kept: here.kept };
}

function refusalOf(error: unknown): ImportRefusal | null {
  if (error instanceof Refused) return error.refusal;
  if (error instanceof RowCapError) return { kind: 'refused', reason: 'cap', table: error.table };
  return null;
}

/**
 * W10. Writes the plan, all or nothing: replaced sheets go (their dates, slots and imported sign-ups with them), then
 * the group's settings the file sets, the new people (no private links), the sheets with their dates and slots, and the
 * sign-ups, confirmed first and then the waiting ones in file order (a restored export's with their history), with one
 * activity row. With `requestHash` (the import page's form), a form already applied is refused before anything else.
 */
export async function applyImport(
  pool: pg.Pool,
  plan: ImportPlan,
  ctx: WriteContext,
  options: { requestHash?: Buffer | null } = {}
): Promise<ImportResult> {
  const requestHash = options.requestHash ?? null;
  try {
    return await inTransaction(
      pool,
      async (tx): Promise<ImportResult> => {
        const state = await tx.query<{ used: boolean | null }>(
          'select import_request_hash = $1::bytea as used from app_state where id = 1 for update',
          [requestHash]
        );
        if (state.rows[0]?.used) throw new Refused({ kind: 'refused', reason: 'repeated' });
        const here = await findHere(tx, plan, true);

        // Every refusal above came before this first write; the caps' check below throws, so it rolls back too.
        await tx.query('delete from sheets where id = any($1::bigint[])', [here.replaced.map((row) => row.id)]);
        const counts = importCounts(plan);
        await checkCaps(tx, { people: counts.people, sheets: counts.sheets, slots: counts.slots, signups: counts.signups });
        const appeared = await tx.query('select 1 from sheets where slug = any($1::text[]) limit 1', [plan.sheets.map((sheet) => sheet.slug)]);
        if (appeared.rows.length > 0) throw new Restart();

        if (plan.group) await saveGroup(tx, plan.group);
        const personIds = await insertPeople(tx, plan);
        for (const [index, sheet] of plan.sheets.entries()) await insertSheet(tx, sheet, index, personIds);
        if (requestHash) await tx.query('update app_state set import_request_hash = $1 where id = 1', [requestHash]);
        await recordActivity(tx, { actor: ctx.actor, kind: 'import', browser: ctx.browser, sheetId: null });
        // New (or replaced) sheets can move the last day of the organizer's weekly reminder.
        if (plan.sheets.length > 0) await reviseReminder(tx);
        return { kind: 'imported', counts, ...found(plan, here) };
      },
      { attempts: 3 }
    );
  } catch (error) {
    const refusal = refusalOf(error);
    if (refusal) return refusal;
    throw error;
  }
}

/**
 * A dry run: the same checks as applyImport, by plain reads without locks, and no write of any kind (no activity row,
 * no identity value used up). The answer can go stale before an apply, which checks everything again.
 */
export async function previewImport(db: Db, plan: ImportPlan): Promise<ImportCheck> {
  try {
    const here = await findHere(db, plan, false);
    const counts = importCounts(plan);
    const { rows } = await db.query<Record<CappedTable, number> & { goneSlots: number; goneSignups: number }>(
      `select (select count(*) from people)::int as people, (select count(*) from signups)::int as signups,
              (select count(*) from sheets)::int as sheets, (select count(*) from slots)::int as slots,
              (select count(*) from slots where sheet_id = any($1::bigint[]))::int as "goneSlots",
              (select count(*) from signups g join slots s on s.id = g.slot_id where s.sheet_id = any($1::bigint[]))::int as "goneSignups"`,
      [here.replaced.map((row) => row.id)]
    );
    const now = rows[0]!;
    const after: Record<CappedTable, number> = {
      people: now.people + counts.people,
      sheets: now.sheets - here.replaced.length + counts.sheets,
      slots: now.slots - now.goneSlots + counts.slots,
      signups: now.signups - now.goneSignups + counts.signups
    };
    for (const table of Object.keys(ROW_CAPS) as CappedTable[]) {
      if (after[table] > ROW_CAPS[table]) return { kind: 'refused', reason: 'cap', table };
    }
    return { kind: 'checked', counts, ...found(plan, here) };
  } catch (error) {
    const refusal = refusalOf(error);
    if (refusal) return refusal;
    throw error;
  }
}

/** The settings the file names; the calendar's revision moves only when a name a calendar file shows changes. */
async function saveGroup(tx: Db, group: ImportGroup): Promise<void> {
  const dues = group.duesLabel !== undefined;
  await tx.query(
    `update app_state set
        group_name = coalesce($1::text, group_name),
        organizer_name = coalesce($2::text, organizer_name),
        organizer_contact = coalesce($3::text, organizer_contact),
        dues_label = case when $4 then $5::text else dues_label end,
        dues_amount_cents = case when $4 then $6::int else dues_amount_cents end,
        revised_at = case when (group_name, organizer_name, organizer_contact)
                             is distinct from (coalesce($1::text, group_name), coalesce($2::text, organizer_name), coalesce($3::text, organizer_contact))
                     then now() else revised_at end
      where id = 1`,
    [
      group.groupName ?? null,
      group.organizerName ?? null,
      group.organizerContact ?? null,
      dues,
      group.duesLabel ?? '',
      dues && group.duesLabel ? (group.duesAmountCents ?? null) : null
    ]
  );
}

/**
 * `n` new ids for a table, ascending, from its identity sequence, so one statement can insert many rows and the import
 * still knows which id each one got (a batch of thousands of rows is then a handful of round trips, not thousands).
 */
async function newIds(tx: Db, table: 'people' | 'dates' | 'slots', n: number): Promise<string[]> {
  if (n === 0) return [];
  const { rows } = await tx.query<{ id: string }>(
    'select nextval(pg_get_serial_sequence($1, $2)) as id from generate_series(1, $3::int) order by id',
    [`public.${table}`, 'id', n]
  );
  return rows.map((row) => row.id);
}

/** The new people in file order (so the roster keeps it), with no link. Answers every key's person id. */
async function insertPeople(tx: Db, plan: ImportPlan): Promise<Map<string, string>> {
  const fresh = plan.people.filter((person) => person.existingId === null);
  const ids = await newIds(tx, 'people', fresh.length);
  if (fresh.length > 0) {
    await tx.query(
      `insert into people (id, name, contact, paid, paid_amount_cents, paid_note, paid_at, added_by) overriding system value
       select id, name, contact, paid, cents, note, case when paid then now() end, 'import'
         from unnest($1::bigint[], $2::text[], $3::text[], $4::boolean[], $5::int[], $6::text[]) as t(id, name, contact, paid, cents, note)`,
      [
        ids,
        fresh.map((person) => person.name),
        fresh.map((person) => person.contact),
        fresh.map((person) => person.paid),
        fresh.map((person) => person.paidAmountCents),
        fresh.map((person) => person.paidNote)
      ]
    );
  }
  const personIds = new Map<string, string>();
  for (const person of plan.people) if (person.existingId) personIds.set(person.key, person.existingId);
  fresh.forEach((person, index) => personIds.set(person.key, ids[index]!));
  return personIds;
}

async function insertSheet(tx: Db, sheet: ImportPlan['sheets'][number], index: number, personIds: Map<string, string>): Promise<void> {
  const made = await tx.query<{ id: string }>(
    `insert into sheets (slug, title, description, timezone, place, names, status, note_label, note_required, listed, position)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, (select coalesce(max(position) + 1, 0) from sheets) + $11)
     returning id`,
    [sheet.slug, sheet.title, sheet.description, sheet.timezone, sheet.place, sheet.names, sheet.status, sheet.noteLabel, sheet.noteRequired, sheet.listed, index]
  );
  const sheetId = made.rows[0]!.id;

  const dateIds = await newIds(tx, 'dates', sheet.dates.length);
  if (sheet.dates.length > 0) {
    await tx.query(
      `insert into dates (id, sheet_id, on_date, starts_at, ends_at, label, place, cancelled_at) overriding system value
       select id, $2, on_date, starts_at, ends_at, label, place, case when cancelled then now() end
         from unnest($1::bigint[], $3::date[], $4::time[], $5::time[], $6::text[], $7::text[], $8::boolean[])
              as t(id, on_date, starts_at, ends_at, label, place, cancelled)`,
      [
        dateIds,
        sheetId,
        sheet.dates.map((date) => date.onDate),
        sheet.dates.map((date) => date.startsAt),
        sheet.dates.map((date) => date.endsAt),
        sheet.dates.map((date) => date.label),
        sheet.dates.map((date) => date.place),
        sheet.dates.map((date) => date.cancelled ?? false)
      ]
    );
  }

  const places = sheet.dates.flatMap((date, d) => date.slots.map((slot, position) => ({ ...slot, dateId: dateIds[d]!, position })));
  const slotIds = await newIds(tx, 'slots', places.length);
  if (places.length > 0) {
    await tx.query(
      `insert into slots (id, sheet_id, date_id, label, description, capacity, position) overriding system value
       select id, $2, date_id, label, description, capacity, position
         from unnest($1::bigint[], $3::bigint[], $4::text[], $5::text[], $6::int[], $7::int[]) as t(id, date_id, label, description, capacity, position)`,
      [
        slotIds,
        sheetId,
        places.map((slot) => slot.dateId),
        places.map((slot) => slot.label),
        places.map((slot) => slot.description),
        places.map((slot) => slot.capacity),
        places.map((slot) => slot.position)
      ]
    );
  }
  const slotId = (date: number, slot: number) => {
    const offset = sheet.dates.slice(0, date).reduce((n, earlier) => n + earlier.slots.length, 0);
    return slotIds[offset + slot]!;
  };

  // Confirmed first, then the waiting ones in file order. Queue times one microsecond apart in that order, with ids in
  // the same order, keep each waitlist exactly as the file lists it. A restored export's sign-ups keep who added them,
  // when they were made, moved up and were told, none later than now (another copy's clock may run a few minutes
  // ahead): a calendar file's SEQUENCE counts from the first and grows with the move up (views.ts). Without a time
  // made, now; without a move up or told, none (`least` skips a null, hence `case` for those two).
  const ordered = [...sheet.signups.filter((s) => s.status === 'confirmed'), ...sheet.signups.filter((s) => s.status === 'waiting')];
  if (ordered.length > 0) {
    await tx.query(
      `insert into signups (slot_id, person_id, status, note, added_by, promoted_at, told_at, created_at, queued_at)
       select slot_id, person_id, status, note, added_by, case when promoted_at > now() then now() else promoted_at end,
              case when told_at > now() then now() else told_at end, least(signed_up_at, now()),
              now() + make_interval(secs => n / 1000000.0)
         from unnest($1::bigint[], $2::bigint[], $3::text[], $4::text[], $5::text[], $6::timestamptz[], $7::timestamptz[], $8::timestamptz[])
              with ordinality as t(slot_id, person_id, status, note, added_by, promoted_at, told_at, signed_up_at, n)
        order by n`,
      [
        ordered.map((signup) => slotId(signup.date, signup.slot)),
        ordered.map((signup) => personIds.get(signup.person)),
        ordered.map((signup) => signup.status),
        ordered.map((signup) => signup.note),
        ordered.map((signup) => signup.addedBy ?? 'import'),
        ordered.map((signup) => signup.promotedAt ?? null),
        ordered.map((signup) => signup.toldAt ?? null),
        ordered.map((signup) => signup.signedUpAt ?? null)
      ]
    );
  }
}

// --- The import as the organizer runs it (the route) ---------------------------------------------------------------

export type ImportOutcome =
  /** `sheets`: once imported, the sheets it made, for the import page's links to them (never in the JSON answer). */
  | { ok: true; dryRun: boolean; summary: string; counts: ImportCounts; sheets?: { slug: string; title: string }[] }
  /**
   * A refusal: one sentence ending "Nothing was imported.", and the field it is about when there is one. `repeated`: the
   * import page's form was applied already (its sentence says so instead).
   */
  | { ok: false; error: string; path: string | null; repeated?: true };

/**
 * Reads the file, then checks it (a dry run) or imports it. `dryRun` null follows the file's own `dryRun` (false when
 * it has none); the import page's two buttons pass true or false. `requestId`: the import page's form, applied once.
 */
export async function runImport(
  pool: pg.Pool,
  text: string,
  options: { dryRun: boolean | null; ctx: WriteContext; requestId?: string | null; now?: Date }
): Promise<ImportOutcome> {
  const now = options.now ?? new Date();
  const read = readImportFile(text, now);
  if (!read.ok) return refusedWith(read.refusal);
  const dryRun = options.dryRun ?? read.value.dryRun ?? false;
  const { plan } = read.value;
  const requestHash = options.requestId ? sha256(options.requestId) : null;
  // What the group's settings are before the file changes them, so the summary names a change as one (a plain read:
  // only words depend on it).
  const before = plan.group ? await groupBefore(pool) : null;
  const result = dryRun ? await previewImport(pool, plan) : await applyImport(pool, plan, { ...options.ctx, now }, { requestHash });
  if (result.kind === 'refused' && result.reason === 'repeated') return { ok: false, error: words.import.repeated, path: null, repeated: true };
  if (result.kind === 'refused') return refusedWith(refusalText(result, read.value));
  const summary = summarize(read.value, result, dryRun, before);
  if (dryRun) return { ok: true, dryRun, summary, counts: result.counts };
  return { ok: true, dryRun, summary, counts: result.counts, sheets: plan.sheets.map((sheet) => ({ slug: sheet.slug, title: sheet.title })) };
}

/** The group's settings as they are now. */
async function groupBefore(db: Db): Promise<GroupSettings> {
  const { rows } = await db.query<GroupSettings>(
    `select group_name as "groupName", organizer_name as "organizerName", organizer_contact as "organizerContact",
            dues_label as "duesLabel", dues_amount_cents as "duesAmountCents"
       from app_state where id = 1`
  );
  return rows[0]!;
}

function refusedWith(refusal: ImportRefusalText): ImportOutcome {
  return { ok: false, error: `${refusal.sentence} ${words.import.nothingImported}`, path: refusal.path };
}

function refusalText(refusal: Exclude<ImportRefusal, { reason: 'repeated' }>, read: ReadImport): ImportRefusalText {
  const w = words.import;
  switch (refusal.reason) {
    case 'exists':
      return { sentence: w.exists(refusal.slug), path: read.sheetPaths.get(refusal.slug) ?? null };
    case 'member-signups':
      return { sentence: w.memberSignups(refusal.slug), path: read.sheetPaths.get(refusal.slug) ?? null };
    case 'person': {
      const path = read.personPaths.get(refusal.key) ?? 'people';
      const person = read.plan.people.find((each) => each.key === refusal.key);
      return { sentence: w.field(`${path}.id`, w.problem.notHere(person?.name ?? refusal.key)), path: `${path}.id` };
    }
    case 'cap':
      return { sentence: w.cap(ROW_CAPS[refusal.table].toLocaleString('en-US'), w.capWhat[refusal.table]), path: null };
  }
}

const LISTED = 5;

/**
 * One line: `Would make: 1 sheet (Snack sign-up, draft) · 7 dates: Sat, Nov 14 … Sat, Dec 26 · 7 places · …`.
 * `before`: the group's settings before the file, so a setting it changes from something to something else reads as a
 * change ("changes the group name from … to …"), never as a plain fact a reader could take for the new sheet's own.
 */
export function summarize(read: ReadImport, result: { counts: ImportCounts } & ImportFound, dryRun: boolean, before: GroupSettings | null = null): string {
  const s = words.import.summary;
  const { plan } = read;
  const parts: string[] = [];
  if (plan.sheets.length > 0) {
    parts.push(s.sheets(plan.sheets.length, plan.sheets.map((sheet) => s.sheet(sheet.title, sheet.status)).join('; ')));
    const days = plan.sheets.flatMap((sheet) => sheet.dates.map((date) => date.onDate)).sort();
    const range = days.length === 0 ? '' : days.length === 1 ? formatDate(days[0]!) : `${formatDate(days[0]!)} … ${formatDate(days.at(-1)!)}`;
    const cancelled = plan.sheets.reduce((n, sheet) => n + sheet.dates.filter((date) => date.cancelled).length, 0);
    parts.push(`${s.dates(days.length, range)}${cancelled > 0 ? ` (${s.cancelledDates(cancelled)})` : ''}`);
    const places = plan.sheets.reduce((n, sheet) => n + sheet.dates.reduce((m, date) => m + date.slots.reduce((k, slot) => k + slot.capacity, 0), 0), 0);
    parts.push(s.places(places));
  }
  if (result.counts.people > 0) parts.push(s.people(result.counts.people));
  if (result.kept.length > 0) {
    const names = result.kept.map((key) => plan.people.find((person) => person.key === key)!.name);
    parts.push(s.keeps(names.length, names.join('; ')));
  }
  if (result.counts.signups > 0) {
    const names = new Map(plan.people.map((person) => [person.key, person.name]));
    const listed = plan.sheets.flatMap((sheet) =>
      sheet.signups.map((signup) => {
        const date = sheet.dates[signup.date]!;
        const slot = date.slots[signup.slot]!;
        const notes = [date.slots.length > 1 ? slot.label : '', signup.status === 'waiting' ? s.waiting : ''].filter(Boolean);
        return `${names.get(signup.person)} ${dateWords(sheet.dates, date)}${notes.length > 0 ? ` (${notes.join(', ')})` : ''}`;
      })
    );
    const shown = listed.slice(0, LISTED);
    if (listed.length > LISTED) shown.push(s.andMore(listed.length - LISTED));
    parts.push(s.signups(listed.length, shown.join('; ')));
  }
  const group = plan.group;
  if (group?.groupName !== undefined) {
    const was = before?.groupName ?? '';
    parts.push(was && was !== group.groupName ? s.changesGroupName(was, group.groupName) : s.groupName(group.groupName));
  }
  if (group?.organizerName !== undefined) {
    const was = before?.organizerName ?? '';
    parts.push(was && was !== group.organizerName ? s.changesOrganizer(was, group.organizerName) : s.organizer(group.organizerName));
  }
  if (group?.organizerContact !== undefined) {
    const was = before?.organizerContact ?? '';
    if (was && !group.organizerContact) parts.push(s.removesOrganizerContact);
    else if (was && was !== group.organizerContact) parts.push(s.changesOrganizerContact);
  }
  if (group?.duesLabel !== undefined) {
    const dues = (label: string, cents: number | null | undefined) => (label ? s.duesWords(label, cents === null || cents === undefined ? '' : formatCents(cents)) : '');
    const was = before ? dues(before.duesLabel, before.duesAmountCents) : '';
    const now = dues(group.duesLabel, group.duesAmountCents);
    if (was && !now) parts.push(s.turnsDuesOff(was));
    else if (was && now !== was) parts.push(s.changesDues(was, now));
    else parts.push(now ? s.dues(now) : s.noDues);
  }
  if (result.replaced.length > 0) parts.push(s.replaces(result.replaced.join(', '), result.replaced.length, result.removing));
  if (read.exportedAt) parts.push(s.fromExport(formatDate(read.exportedAt.toISOString().slice(0, 10))));
  if (result.counts.people > 0) parts.push(s.noLinks);
  return `${dryRun ? s.wouldMake : s.imported} ${parts.length > 0 ? parts.join(s.separator) : s.nothing}`;
}
