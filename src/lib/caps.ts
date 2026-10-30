// The per-copy row caps (see TOFU.md, Concurrency): 2,000 people, 10,000 sign-ups, 50 sheets and 5,000 slots.
//
// A write that adds rows checks the caps inside its own transaction, after its sheet and slot locks (locks.ts) and
// before its inserts. Deletes never check: they only make room. One advisory transaction lock coordinates the checks:
//
// - A claim, which adds at most one person and one sign-up, takes it SHARED, so claims never wait for one another
//   here. It then reads how many transactions hold the lock (itself included) and only after that counts the rows, in
//   a newer snapshot. Every claim still in flight holds the lock, so `rows counted + holders` bounds what the tables
//   can reach once they all commit, and the claim goes ahead only if that is within the cap. Near a cap this can
//   refuse a claim that would have fit, at most one per claim then in flight.
// - Any other write that adds rows (an import, a new sheet, date or slot) takes it EXCLUSIVE: it waits for the claims in
//   flight, holds new ones off until it commits, and counts exactly.
//
// The order of the three statements in checkCapsForClaim is what makes the bound hold; each needs its own snapshot,
// which READ COMMITTED gives every statement.
import type { Db } from './db';

export const ROW_CAPS = { people: 2_000, signups: 10_000, sheets: 50, slots: 5_000 } as const;
export type CappedTable = keyof typeof ROW_CAPS;

// The lock's two int4 keys. pg_locks shows them as classid and objid with objsubid 2; the migrate script's lock uses
// the one-key form (objsubid 1), so the two never meet.
const LOCK_CLASS = 1_937_008_239;
const LOCK_ID = 1;

export class RowCapError extends Error {
  constructor(readonly table: CappedTable) {
    super(`the ${table} row cap is reached`);
    this.name = 'RowCapError';
  }
}

/** For a write that adds at most one person and at most one sign-up (a claim, or the organizer adding someone). */
export async function checkCapsForClaim(tx: Db): Promise<void> {
  await tx.query('select pg_advisory_xact_lock_shared($1, $2)', [LOCK_CLASS, LOCK_ID]);
  const holders = await tx.query<{ n: number }>(
    `select count(*)::int as n from pg_catalog.pg_locks
      where locktype = 'advisory' and granted and classid = $1 and objid = $2 and objsubid = 2
        and database = (select oid from pg_catalog.pg_database where datname = current_database())`,
    [LOCK_CLASS, LOCK_ID]
  );
  const counts = await tx.query<{ people: number; signups: number }>(
    'select (select count(*) from people)::int as people, (select count(*) from signups)::int as signups'
  );
  const inFlight = holders.rows[0]?.n ?? 1;
  const row = counts.rows[0];
  if (!row) throw new Error('row counts missing');
  for (const table of ['people', 'signups'] as const) {
    if (row[table] + inFlight > ROW_CAPS[table]) throw new RowCapError(table);
  }
}

/** For any other write that adds rows: an import, a new sheet, date or slot. Counts exactly. */
export async function checkCaps(tx: Db, adding: Partial<Record<CappedTable, number>>): Promise<void> {
  await tx.query('select pg_advisory_xact_lock($1, $2)', [LOCK_CLASS, LOCK_ID]);
  const counts = await tx.query<Record<CappedTable, number>>(
    `select (select count(*) from people)::int as people, (select count(*) from signups)::int as signups,
            (select count(*) from sheets)::int as sheets, (select count(*) from slots)::int as slots`
  );
  const row = counts.rows[0];
  if (!row) throw new Error('row counts missing');
  for (const table of Object.keys(ROW_CAPS) as CappedTable[]) {
    if (row[table] + (adding[table] ?? 0) > ROW_CAPS[table]) throw new RowCapError(table);
  }
}
