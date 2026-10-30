// The export (see TOFU.md, Import and export): the whole copy as one signup-sheet/1 file, read at one instant
// (readSnapshot), which an import restores into a fresh copy. It never carries a link token or any hash; it says only
// whether each person has a private link. Its person ids and sheet ids are there for people to read: because the file
// carries `exportedAt`, the import never takes a person id in it for someone already in the copy it is imported into.
// Each sign-up's time and history (who added it, when it moved up, whether its person was told) are restored by the
// import (import-format.ts history).
//
// It keeps everything an import can restore: the group's settings, the roster in its order with contacts and paid state,
// each sheet's settings, dates (cancelled ones too) and slots in order, and every sign-up with its note, confirmed ones
// first and each waitlist in its order.
import type pg from 'pg';
import { type Db, readSnapshot } from './db';
import { FORMAT } from './import-format';
import { parseTime, weekdayIndex } from './time';
import { words } from '../words';

export type ExportFile = {
  format: typeof FORMAT;
  exportedAt: string;
  group: { name: string; organizer: { name: string; contact: string }; dues: { label: string; amountCents: number | null } | null };
  people: {
    key: string;
    id: number | string;
    name: string;
    contact: string;
    paid: boolean;
    paidAmountCents: number | null;
    paidNote: string;
    hasLink: boolean;
  }[];
  sheets: {
    id: number | string;
    slug: string;
    title: string;
    description: string;
    timezone: string;
    place: string;
    names: 'full' | 'taken';
    status: 'draft' | 'open' | 'closed';
    noteLabel: string;
    noteRequired: boolean;
    listed: boolean;
    dates: {
      date: string;
      weekday: string;
      start: string | null;
      end: string | null;
      label: string;
      place: string;
      cancelled: boolean;
      slots: { label: string; capacity: number; description: string }[];
    }[];
    signups: {
      date: string;
      start: string | null;
      slot: string;
      person: string;
      note: string;
      status: 'confirmed' | 'waiting';
      addedBy: 'member' | 'organizer' | 'import';
      signedUpAt: string;
      promotedAt: string | null;
      told: boolean;
    }[];
  }[];
};

/** A row id as the file writes it: a number while it is one exactly, else its digits. */
function fileId(id: string): number | string {
  const number = Number(id);
  return Number.isSafeInteger(number) ? number : id;
}

const personKey = (id: string) => `p${id}`;
const hhmm = (time: string | null) => (time === null ? null : parseTime(time));

export async function exportCopy(pool: pg.Pool, now: Date = new Date()): Promise<ExportFile> {
  return readSnapshot(pool, (tx) => readCopy(tx, now));
}

async function readCopy(tx: Db, now: Date): Promise<ExportFile> {
  const group = (
    await tx.query<{ name: string; organizerName: string; organizerContact: string; duesLabel: string; duesAmountCents: number | null }>(
      `select group_name as name, organizer_name as "organizerName", organizer_contact as "organizerContact",
              dues_label as "duesLabel", dues_amount_cents as "duesAmountCents"
         from app_state where id = 1`
    )
  ).rows[0]!;
  const people = await tx.query<{ id: string; name: string; contact: string; paid: boolean; paidAmountCents: number | null; paidNote: string; hasLink: boolean }>(
    `select id, name, contact, paid, paid_amount_cents as "paidAmountCents", paid_note as "paidNote", token_hash is not null as "hasLink"
       from people order by id`
  );
  const sheets = await tx.query<Omit<ExportFile['sheets'][number], 'id' | 'dates' | 'signups'> & { id: string }>(
    `select id, slug, title, description, timezone, place, names, status, note_label as "noteLabel", note_required as "noteRequired", listed
       from sheets order by position, id`
  );
  const dates = await tx.query<{ id: string; sheetId: string; onDate: string; startsAt: string | null; endsAt: string | null; label: string; place: string; cancelled: boolean }>(
    `select id, sheet_id as "sheetId", on_date as "onDate", starts_at as "startsAt", ends_at as "endsAt", label, place,
            cancelled_at is not null as cancelled
       from dates order by sheet_id, on_date, starts_at nulls first, id`
  );
  const slots = await tx.query<{ id: string; dateId: string; label: string; capacity: number; description: string }>(
    'select id, date_id as "dateId", label, capacity, description from slots order by date_id, position, id'
  );
  const signups = await tx.query<{
    sheetId: string;
    dateId: string;
    slotId: string;
    personId: string;
    note: string;
    status: 'confirmed' | 'waiting';
    addedBy: 'member' | 'organizer' | 'import';
    createdAt: Date;
    promotedAt: Date | null;
    told: boolean;
  }>(
    `select s.sheet_id as "sheetId", s.date_id as "dateId", g.slot_id as "slotId", g.person_id as "personId", g.note, g.status,
            g.added_by as "addedBy", g.created_at as "createdAt", g.promoted_at as "promotedAt", g.told_at is not null as told
       from signups g join slots s on s.id = g.slot_id
      order by g.slot_id, g.status = 'waiting', g.queued_at, g.id`
  );

  const datesById = new Map(dates.rows.map((date) => [date.id, date]));
  const slotsById = new Map(slots.rows.map((slot) => [slot.id, slot]));
  const file: ExportFile = {
    format: FORMAT,
    exportedAt: now.toISOString(),
    group: {
      name: group.name,
      organizer: { name: group.organizerName, contact: group.organizerContact },
      dues: group.duesLabel ? { label: group.duesLabel, amountCents: group.duesAmountCents } : null
    },
    people: people.rows.map((person) => ({
      key: personKey(person.id),
      id: fileId(person.id),
      name: person.name,
      contact: person.contact,
      paid: person.paid,
      paidAmountCents: person.paidAmountCents,
      paidNote: person.paidNote,
      hasLink: person.hasLink
    })),
    sheets: []
  };
  for (const sheet of sheets.rows) {
    const own = dates.rows.filter((date) => date.sheetId === sheet.id);
    const slotOrder = new Map<string, number>();
    const entry: ExportFile['sheets'][number] = {
      ...sheet,
      id: fileId(sheet.id),
      dates: own.map((date) => ({
        date: date.onDate,
        weekday: words.calendar.weekdaysShort[weekdayIndex(date.onDate)]!,
        start: hhmm(date.startsAt),
        end: hhmm(date.endsAt),
        label: date.label,
        place: date.place,
        cancelled: date.cancelled,
        slots: slots.rows
          .filter((slot) => slot.dateId === date.id)
          .map((slot) => {
            slotOrder.set(slot.id, slotOrder.size);
            return { label: slot.label, capacity: slot.capacity, description: slot.description };
          })
      })),
      signups: []
    };
    // Sign-ups by their place's order on the sheet, then confirmed before waiting, each in queue order.
    const mine = signups.rows.filter((signup) => signup.sheetId === sheet.id);
    mine.sort((a, b) => slotOrder.get(a.slotId)! - slotOrder.get(b.slotId)!);
    entry.signups = mine.map((signup) => {
      const date = datesById.get(signup.dateId)!;
      return {
        date: date.onDate,
        start: hhmm(date.startsAt),
        slot: slotsById.get(signup.slotId)!.label,
        person: personKey(signup.personId),
        note: signup.note,
        status: signup.status,
        addedBy: signup.addedBy,
        signedUpAt: signup.createdAt.toISOString(),
        promotedAt: signup.promotedAt?.toISOString() ?? null,
        told: signup.told
      };
    });
    file.sheets.push(entry);
  }
  return file;
}
