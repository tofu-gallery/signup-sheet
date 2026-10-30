// Writes on people (see TOFU.md, Concurrency): a member's own name and contact (W5), new private links (W8), paid
// (W9), the organizer's roster, and removing a person everywhere (W11). A write that touches only a people row locks
// that row and nothing after it; removing a person everywhere locks their sign-ups' slots and sign-ups first, then the
// person, in the order locks.ts sets out, and deletes the person last.
import type pg from 'pg';
import { checkCaps } from './caps';
import { inTransaction, Restart } from './db';
import { type MemberAuth, recordActivity, replaceLink } from './identity';
import { lockSheetsOfSlots, lockSignups, lockSlots, promoteWaiting } from './locks';
import { stillOpen, type WriteContext } from './signups';

export type Missing = { kind: 'missing' };

/** W5. A member's own name and contact, while their link still works. The name is in their calendar files (revised_at). */
export async function changeProfile(
  pool: pg.Pool,
  input: { owner: MemberAuth; name: string; contact: string },
  ctx: WriteContext
): Promise<Missing | { kind: 'saved' }> {
  return inTransaction(pool, async (tx) => {
    const { rowCount } = await tx.query(
      `update people set name = $3, contact = $4, revised_at = case when name is distinct from $3::text then now() else revised_at end
        where id = $1 and token_hash = $2`,
      [input.owner.personId, input.owner.tokenHash, input.name, input.contact]
    );
    if (rowCount !== 1) return { kind: 'missing' as const };
    await recordActivity(tx, { actor: ctx.actor, kind: 'profile', browser: ctx.browser, sheetId: null });
    return { kind: 'saved' as const };
  });
}

/** The organizer's edit of a person's name and contact. */
export async function editPerson(
  pool: pg.Pool,
  input: { personId: string; name: string; contact: string },
  ctx: WriteContext
): Promise<Missing | { kind: 'saved' }> {
  return inTransaction(pool, async (tx) => {
    const { rowCount } = await tx.query(
      'update people set name = $2, contact = $3, revised_at = case when name is distinct from $2::text then now() else revised_at end where id = $1',
      [input.personId, input.name, input.contact]
    );
    if (rowCount !== 1) return { kind: 'missing' as const };
    await recordActivity(tx, { actor: ctx.actor, kind: 'person_edit', browser: ctx.browser, sheetId: null });
    return { kind: 'saved' as const };
  });
}

/**
 * W8. A new private link: for a member, their own, and only while the link they used still works (so a link already
 * replaced cannot replace the new one); for the organizer, any person's. Answers the new token, shown once.
 */
export async function makeNewLink(
  pool: pg.Pool,
  target: { owner: MemberAuth } | { personId: string },
  ctx: WriteContext
): Promise<Missing | { kind: 'made'; token: string; personId: string }> {
  return inTransaction(pool, async (tx) => {
    const personId = 'owner' in target ? target.owner.personId : target.personId;
    const token = await replaceLink(tx, personId, 'owner' in target ? target.owner.tokenHash : null);
    if (!token) return { kind: 'missing' as const };
    await recordActivity(tx, { actor: ctx.actor, kind: 'new_link', browser: ctx.browser, sheetId: null });
    return { kind: 'made' as const, token, personId };
  });
}

/** W9. Paid or not, with the amount and a note. Paying fills paid_at once; unpaying clears it and keeps the note. */
export async function setPaid(
  pool: pg.Pool,
  input: { personId: string; paid: boolean; amountCents: number | null; note: string },
  ctx: WriteContext
): Promise<Missing | { kind: 'saved' }> {
  return inTransaction(pool, async (tx) => {
    const { rowCount } = await tx.query(
      `update people set paid = $2, paid_amount_cents = $3, paid_note = $4,
              paid_at = case when $2 then coalesce(paid_at, now()) end
        where id = $1`,
      [input.personId, input.paid, input.amountCents, input.note]
    );
    if (rowCount !== 1) return { kind: 'missing' as const };
    await recordActivity(tx, { actor: ctx.actor, kind: 'paid', browser: ctx.browser, sheetId: null });
    return { kind: 'saved' as const };
  });
}

/** W9 from the unpaid list: paid or not, nothing else; the amount and the note stay as they are. */
export async function markPaid(pool: pg.Pool, input: { personId: string; paid: boolean }, ctx: WriteContext): Promise<Missing | { kind: 'saved'; name: string }> {
  return inTransaction(pool, async (tx) => {
    const { rows } = await tx.query<{ name: string }>(
      'update people set paid = $2, paid_at = case when $2 then coalesce(paid_at, now()) end where id = $1 returning name',
      [input.personId, input.paid]
    );
    if (!rows[0]) return { kind: 'missing' as const };
    await recordActivity(tx, { actor: ctx.actor, kind: 'paid', browser: ctx.browser, sheetId: null });
    return { kind: 'saved' as const, name: rows[0].name };
  });
}

/** The organizer adds a person to the roster (no private link until the organizer makes one). */
export async function addPerson(
  pool: pg.Pool,
  input: { name: string; contact: string },
  ctx: WriteContext
): Promise<{ kind: 'added'; personId: string }> {
  return inTransaction(pool, async (tx) => {
    await checkCaps(tx, { people: 1 });
    const { rows } = await tx.query<{ id: string }>("insert into people (name, contact, added_by) values ($1, $2, 'organizer') returning id", [
      input.name,
      input.contact
    ]);
    await recordActivity(tx, { actor: ctx.actor, kind: 'person_add', browser: ctx.browser, sheetId: null });
    return { kind: 'added' as const, personId: rows[0]!.id };
  });
}

/** The roster's plain delete: only a person with no sign-ups (the foreign key refuses the rest as well). */
export async function deletePerson(
  pool: pg.Pool,
  personId: string,
  ctx: WriteContext
): Promise<Missing | { kind: 'refused'; reason: 'has-signups' } | { kind: 'deleted' }> {
  return inTransaction(pool, async (tx) => {
    const found = await tx.query('select 1 from people where id = $1 for update', [personId]);
    if (found.rows.length === 0) return { kind: 'missing' as const };
    const held = await tx.query('select 1 from signups where person_id = $1 limit 1', [personId]);
    if (held.rows.length > 0) return { kind: 'refused' as const, reason: 'has-signups' as const };
    await tx.query('delete from people where id = $1', [personId]);
    await recordActivity(tx, { actor: ctx.actor, kind: 'person_delete', browser: ctx.browser, sheetId: null });
    return { kind: 'deleted' as const };
  });
}

export type RemovalResult = Missing | { kind: 'removed'; signups: number; promoted: number };

/**
 * W11. Removes a person and every sign-up they hold. Their sign-ups' slots are locked in id order, the sign-ups read
 * again and locked, then the person FOR UPDATE, and the sign-ups read once more: if one moved or a new one appeared
 * meanwhile, it starts again from BEGIN, so nothing is half removed. Each slot that lost a confirmed place on a date
 * still open moves its first waiting person up, and the person is deleted last.
 */
export async function removePersonEverywhere(pool: pg.Pool, personId: string, ctx: WriteContext): Promise<RemovalResult> {
  return inTransaction(
    pool,
    async (tx): Promise<RemovalResult> => {
      const before = await tx.query<{ id: string; slotId: string }>(
        'select id, slot_id as "slotId" from signups where person_id = $1 order by id',
        [personId]
      );
      const slotIds = [...new Set(before.rows.map((row) => row.slotId))];
      const sheets = await lockSheetsOfSlots(tx, slotIds, 'share');
      const slots = await lockSlots(tx, slotIds);
      const after = await tx.query<{ id: string; slotId: string }>(
        'select id, slot_id as "slotId" from signups where person_id = $1 order by id',
        [personId]
      );
      const same = (rows: { id: string; slotId: string }[]) => rows.map((row) => `${row.id}:${row.slotId}`).join(',');
      if (same(before.rows) !== same(after.rows)) throw new Restart();
      const signups = await lockSignups(tx, before.rows.map((row) => row.id));
      if (signups.length !== before.rows.length) throw new Restart();

      // Step 5 (locks.ts). Nobody can sign a locked person up (a new sign-up's foreign key needs them FOR KEY SHARE), so
      // this last read is final, and the person's delete below leaves its foreign-key check no sign-up to wait for.
      const found = await tx.query('select 1 from people where id = $1 for update', [personId]);
      if (found.rows.length === 0) return { kind: 'missing' };
      const final = await tx.query<{ id: string; slotId: string }>(
        'select id, slot_id as "slotId" from signups where person_id = $1 order by id',
        [personId]
      );
      if (same(final.rows) !== same(before.rows)) throw new Restart();
      await tx.query('delete from signups where id = any($1::bigint[])', [signups.map((signup) => signup.id)]);
      let promoted = 0;
      for (const slot of slots) {
        const sheet = sheets.find((row) => row.id === slot.sheetId);
        const lostConfirmed = signups.some((signup) => signup.slotId === slot.id && signup.status === 'confirmed');
        if (sheet && lostConfirmed && stillOpen(slot, sheet.timezone, ctx.now)) promoted += (await promoteWaiting(tx, slot.id)).length;
      }
      await tx.query('delete from people where id = $1', [personId]);
      await recordActivity(tx, { actor: ctx.actor, kind: 'remove_person', browser: ctx.browser, sheetId: null });
      return { kind: 'removed', signups: signups.length, promoted };
    },
    { attempts: 3 }
  );
}
