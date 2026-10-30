// A sheet's spreadsheet for the organizer (see TOFU.md, Import and export): one row per sign-up, RFC 4180 (every field
// quoted, quotes doubled, CRLF line ends), UTF-8 with a byte order mark so spreadsheet apps read it as UTF-8. A cell
// that a spreadsheet would run as a formula (one starting with = + - @, a tab or a carriage return) starts with ' instead.
// It holds contacts and paid state, and never a link or a hash.
import { words } from '../words';
import type { Db } from './db';
import { formatTime, weekdayIndex } from './time';
import { formatCents } from './validation';

const FORMULA = /^[=+\-@\t\r]/;

/** One cell, safe from formulas and quoted. */
export function csvCell(value: string): string {
  const text = FORMULA.test(value) ? `'${value}` : value;
  return `"${text.replace(/"/g, '""')}"`;
}

/** Rows of cells as CSV text, with the byte order mark first and CRLF after every row. */
export function csvText(rows: readonly (readonly string[])[]): string {
  return `\uFEFF${rows.map((row) => `${row.map(csvCell).join(',')}\r\n`).join('')}`;
}

/** 'YYYY-MM-DD HH:MM' at an instant in a time zone, as a spreadsheet reads a date and time. */
function localStamp(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).formatToParts(instant);
  const part = (type: string) => parts.find((each) => each.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
}

/** The sheet's spreadsheet (organizer only: it carries contacts and paid state), or null when there is no such sheet. */
export async function sheetCsv(db: Db, slug: string): Promise<string | null> {
  const head = await db.query<{ id: string; timezone: string; dues: boolean }>(
    "select h.id, h.timezone, a.dues_label <> '' as dues from sheets h cross join app_state a where h.slug = $1 and a.id = 1",
    [slug]
  );
  const sheet = head.rows[0];
  if (!sheet) return null;
  const { rows } = await db.query<{
    onDate: string;
    startsAt: string | null;
    endsAt: string | null;
    dateLabel: string;
    place: string;
    slot: string;
    status: 'confirmed' | 'waiting';
    position: number | null;
    name: string;
    contact: string;
    note: string;
    paid: boolean;
    paidAmountCents: number | null;
    paidNote: string;
    addedBy: 'member' | 'organizer' | 'import';
    signedUpAt: Date;
    cancelled: boolean;
  }>(
    `select d.on_date as "onDate", d.starts_at as "startsAt", d.ends_at as "endsAt", d.label as "dateLabel",
            case when d.place <> '' then d.place else h.place end as place, s.label as slot, g.status,
            case when g.status = 'waiting' then 1 + (select count(*)::int from signups w
              where w.slot_id = g.slot_id and w.status = 'waiting' and (w.queued_at, w.id) < (g.queued_at, g.id)) end as position,
            p.name, p.contact, g.note, p.paid, p.paid_amount_cents as "paidAmountCents", p.paid_note as "paidNote",
            g.added_by as "addedBy", g.created_at as "signedUpAt", d.cancelled_at is not null as cancelled
       from signups g join slots s on s.id = g.slot_id join dates d on d.id = s.date_id join sheets h on h.id = s.sheet_id
            join people p on p.id = g.person_id
      where h.id = $1
      order by d.on_date, d.starts_at nulls first, d.id, s.position, s.id, g.status = 'waiting', g.queued_at, g.id`,
    [sheet.id]
  );
  const w = words.csv;
  const paid = (row: (typeof rows)[number]) => {
    if (!sheet.dues) return '';
    if (!row.paid) return w.unpaid;
    return row.paidAmountCents === null ? w.paid : w.paidAmount(formatCents(row.paidAmountCents));
  };
  return csvText([
    w.header,
    ...rows.map((row) => [
      row.onDate,
      words.calendar.weekdaysShort[weekdayIndex(row.onDate)]!,
      row.startsAt ? formatTime(row.startsAt) : '',
      row.endsAt ? formatTime(row.endsAt) : '',
      row.dateLabel,
      row.place,
      row.slot,
      row.status === 'confirmed' ? w.confirmed : w.waiting(row.position ?? 0),
      row.name,
      row.contact,
      row.note,
      paid(row),
      sheet.dues ? row.paidNote : '',
      w.addedBy[row.addedBy],
      localStamp(row.signedUpAt, sheet.timezone),
      row.cancelled ? w.cancelled : ''
    ])
  ]);
}
