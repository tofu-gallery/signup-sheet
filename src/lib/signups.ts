// The sign-up writes (see TOFU.md, Concurrency): W1 claim, W2 cancel or remove, W3 move, W4 swap, W5 note, and Told
// them. Each runs in one transaction (db.ts) and takes its locks in the order locks.ts sets out. Each answers with what
// happened, and its route turns that into a response. A refusal is answered before anything is written.
//
// Text arrives already checked (validation.ts); a write only checks what depends on the rows it locked.
import type pg from 'pg';
import { checkCapsForClaim } from './caps';
import { type Db, inTransaction, isDbError, Restart } from './db';
import { type Actor, type MemberAuth, memberStillValid, recordActivity } from './identity';
import {
  type LockedSheet,
  type LockedSignup,
  type LockedSlot,
  lockSheetsOfSlots,
  lockSignups,
  lockSlots,
  promoteWaiting,
  waitlistPosition
} from './locks';
import type { Settings } from './settings';
import { addDays, civilToday, isOpenForClaims } from './time';
import { firstLinkToken, requestHash, sameBytes, tokenHash } from './tokens';

/** Who a write counts as in the activity record, and from which browser. `now` is for tests of what has passed. */
export type WriteContext = { actor: Actor; browser: string; now?: Date };

/** Whether a slot's date still takes claims, moves and promotions: not cancelled, and before it starts. */
export function stillOpen(slot: LockedSlot, timeZone: string, now: Date = new Date()): boolean {
  return !slot.cancelled && isOpenForClaims(slot.onDate, slot.startsAt, timeZone, now);
}

/**
 * Whether a member may still change a sign-up of theirs here (cancel it, change its note; moveSignup checks the same
 * with a reason for each): the sheet is open and the date is neither cancelled nor started, as their page says
 * (pages/member.ts changeable). The organizer always may.
 */
function memberMayChange(sheet: LockedSheet, slot: LockedSlot, now?: Date): boolean {
  return sheet.status === 'open' && stillOpen(slot, sheet.timezone, now);
}

// --- W1: claim ---------------------------------------------------------------------------------------------------

export type ClaimWho =
  /** A member typing a name: always a new person, with a private link. Names are never matched to merge people. */
  | { kind: 'new'; name: string; contact: string }
  /** The person this browser remembers (as=me). A non-empty contact replaces theirs. */
  | { kind: 'me'; auth: MemberAuth; contact: string }
  /** The organizer adding someone already on the roster. */
  | { kind: 'person'; personId: string }
  /** The organizer adding someone new: a person with no private link yet. */
  | { kind: 'organizer-new'; name: string; contact: string };

export type ClaimInput = {
  /** The sheet the path names (the public form), or null for the organizer's route by slot id. */
  slug: string | null;
  slotId: string;
  /** The form's request id (a v4 UUID the server wrote into it). Only its hash is stored. */
  requestId: string;
  who: ClaimWho;
  note: string;
  /** Whose rules apply: the public form's (the sheet must be open) or the organizer's (any status). */
  rules: 'member' | 'organizer';
};

export type ClaimRefusal = 'gone' | 'closed' | 'cancelled' | 'past' | 'note' | 'who' | 'person';

export type ClaimResult =
  | {
      kind: 'signed-up';
      /** True when this answers a form sent before, or a person already in this place. */
      replay: boolean;
      signupId: string;
      /** Whom it signed up: the route tells the person this phone remembers apart from someone it made a link for. */
      personId: string;
      status: 'confirmed' | 'waiting';
      position: number | null;
      slug: string;
      /** A new member person's private link (made now, or the same one again for a repeated form). */
      token: string | null;
    }
  | { kind: 'refused'; reason: ClaimRefusal; slug: string | null }
  /** The form's request id is already on another place, or came with other words: 409. */
  | { kind: 'reused' }
  /** A repeated form whose person has a newer link by now: signed up, but no link to show. */
  | { kind: 'link-replaced'; slug: string };

/**
 * W1. Locks the sheet FOR SHARE and the slot, answers a repeated form the way it answered the first time, checks that
 * the place still takes claims, moves people already waiting into free places first, then signs the person up as
 * confirmed or waiting. A deadlock or the capacity backstop runs it once more from BEGIN with the same request id, and
 * only once. The same request id arriving for another place at the same instant is answered as used (409) at once:
 * the claim that commits first keeps it, and a second run could only find it taken.
 */
export async function claim(pool: pg.Pool, settings: Settings, input: ClaimInput, ctx: WriteContext): Promise<ClaimResult> {
  const hash = requestHash(input.requestId);
  try {
    return await inTransaction(pool, (tx) => claimOnce(tx, settings, input, hash, ctx), {
      attempts: 2,
      retryWhen: (error) => isDbError(error, '40P01') || isDbError(error, '23514', 'slots_within_capacity')
    });
  } catch (error) {
    if (isDbError(error, '23505', 'signups_request_hash_key')) return { kind: 'reused' };
    throw error;
  }
}

async function claimOnce(tx: Db, settings: Settings, input: ClaimInput, hash: Buffer, ctx: WriteContext): Promise<ClaimResult> {
  const [sheet] = await lockSheetsOfSlots(tx, [input.slotId], 'share');
  const [slot] = await lockSlots(tx, [input.slotId]);
  if (!sheet || !slot || (input.slug !== null && sheet.slug !== input.slug)) {
    return { kind: 'refused', reason: 'gone', slug: input.slug ?? sheet?.slug ?? null };
  }
  const refused = (reason: ClaimRefusal): ClaimResult => ({ kind: 'refused', reason, slug: sheet.slug });

  const repeated = await answerRepeatedForm(tx, settings, input, hash, sheet);
  if (repeated) return repeated;

  if (input.rules === 'member' && sheet.status !== 'open') return refused('closed');
  if (slot.cancelled) return refused('cancelled');
  if (!stillOpen(slot, sheet.timezone, ctx.now)) return refused('past');
  if (sheet.noteRequired && !input.note) return refused('note');

  const who = input.who;
  let existingPerson: string | null = null;
  if (who.kind === 'me') {
    if (!(await memberStillValid(tx, who.auth))) return refused('who');
    existingPerson = who.auth.personId;
  } else if (who.kind === 'person') {
    const found = await tx.query('select 1 from people where id = $1 for key share', [who.personId]);
    if (found.rows.length === 0) return refused('person');
    existingPerson = who.personId;
  }
  if (existingPerson) {
    const { rows } = await tx.query<{ id: string }>('select id from signups where slot_id = $1 and person_id = $2', [slot.id, existingPerson]);
    if (rows[0]) return signedUp(tx, rows[0].id, sheet.slug, null, true);
  }

  // People already waiting go first; the newcomer takes a place only if one is left after them.
  const promoted = await promoteWaiting(tx, slot.id);
  const status = slot.confirmedCount + promoted.length < slot.capacity ? 'confirmed' : 'waiting';
  await checkCapsForClaim(tx);

  let token: string | null = null;
  let personId: string;
  if (who.kind === 'new' || who.kind === 'organizer-new') {
    const made = await tx.query<{ id: string }>('insert into people (name, contact, added_by) values ($1, $2, $3) returning id', [
      who.name,
      who.contact,
      input.rules
    ]);
    personId = made.rows[0]!.id;
    if (who.kind === 'new') {
      token = firstLinkToken(settings, input.requestId, personId);
      await tx.query('update people set token_hash = $1, link_made_at = now() where id = $2', [tokenHash(token), personId]);
    }
  } else {
    personId = existingPerson!;
  }
  const inserted = await tx.query<{ id: string }>(
    'insert into signups (slot_id, person_id, status, note, added_by, request_hash) values ($1, $2, $3, $4, $5, $6) returning id',
    [slot.id, personId, status, input.note, input.rules, hash]
  );
  if (who.kind === 'me' && who.contact) {
    await tx.query('update people set contact = $1 where id = $2', [who.contact, personId]);
  }
  const kind = input.rules === 'organizer' ? 'add' : status === 'confirmed' ? 'claim' : 'wait';
  await recordActivity(tx, { actor: ctx.actor, kind, browser: ctx.browser, sheetId: sheet.id });
  return signedUp(tx, inserted.rows[0]!.id, sheet.slug, token, false);
}

/**
 * The same form again (by its request id's hash). Only the same place, the same words and the same person get the first
 * answer again; a member's new person gets the same link, re-derived, while it is still theirs. Anything else is 409,
 * so a form left open on a shared phone never hands over the previous person's link. The person's row is held FOR KEY
 * SHARE, so a new link made at the same moment is either seen here or made after this answer.
 */
async function answerRepeatedForm(
  tx: Db,
  settings: Settings,
  input: ClaimInput,
  hash: Buffer,
  sheet: LockedSheet
): Promise<ClaimResult | null> {
  const { rows } = await tx.query<{
    id: string;
    slotId: string;
    personId: string;
    note: string;
    name: string;
    contact: string;
    tokenHash: Buffer | null;
    addedBy: string;
  }>(
    `select g.id, g.slot_id as "slotId", g.person_id as "personId", g.note, p.name, p.contact, p.token_hash as "tokenHash",
            p.added_by as "addedBy"
       from signups g join people p on p.id = g.person_id
      where g.request_hash = $1
        for key share of p`,
    [hash]
  );
  const earlier = rows[0];
  if (!earlier) return null;
  if (earlier.slotId !== input.slotId || earlier.note !== input.note) return { kind: 'reused' };

  const who = input.who;
  switch (who.kind) {
    case 'new': {
      if (earlier.addedBy !== 'member' || earlier.name !== who.name || earlier.contact !== who.contact) return { kind: 'reused' };
      const token = firstLinkToken(settings, input.requestId, earlier.personId);
      if (!earlier.tokenHash || !sameBytes(earlier.tokenHash, tokenHash(token))) return { kind: 'link-replaced', slug: sheet.slug };
      return signedUp(tx, earlier.id, sheet.slug, token, true);
    }
    case 'me': {
      if (earlier.personId !== who.auth.personId || (who.contact && who.contact !== earlier.contact)) return { kind: 'reused' };
      if (!(await memberStillValid(tx, who.auth))) return { kind: 'refused', reason: 'who', slug: sheet.slug };
      return signedUp(tx, earlier.id, sheet.slug, null, true);
    }
    case 'person':
      return earlier.personId === who.personId ? signedUp(tx, earlier.id, sheet.slug, null, true) : { kind: 'reused' };
    case 'organizer-new':
      return earlier.addedBy === 'organizer' && earlier.name === who.name && earlier.contact === who.contact
        ? signedUp(tx, earlier.id, sheet.slug, null, true)
        : { kind: 'reused' };
  }
}

async function signedUp(tx: Db, signupId: string, slug: string, token: string | null, replay: boolean): Promise<ClaimResult> {
  const { rows } = await tx.query<{ status: 'confirmed' | 'waiting'; personId: string }>(
    'select status, person_id as "personId" from signups where id = $1',
    [signupId]
  );
  const { status, personId } = rows[0]!;
  const position = status === 'waiting' ? await waitlistPosition(tx, signupId) : null;
  return { kind: 'signed-up', replay, signupId, personId, status, position, slug, token };
}

// --- One sign-up, locked in order --------------------------------------------------------------------------------

type OneLocked = { sheet: LockedSheet; slot: LockedSlot; signup: LockedSignup };

/**
 * Reads a sign-up's slot without a lock, locks its sheet FOR SHARE, the slot, then the sign-up again FOR UPDATE. With
 * `owner`, only that member's sign-up is found (G6: another person's id finds nothing), and only while their link still
 * works. Null when there is no such sign-up; Restart when it moved to another slot in between.
 */
async function lockOneSignup(tx: Db, signupId: string, owner: MemberAuth | null): Promise<OneLocked | null> {
  const first = await tx.query<{ slotId: string }>(
    'select slot_id as "slotId" from signups where id = $1 and ($2::bigint is null or person_id = $2::bigint)',
    [signupId, owner?.personId ?? null]
  );
  const slotId = first.rows[0]?.slotId;
  if (!slotId) return null;
  const [sheet] = await lockSheetsOfSlots(tx, [slotId], 'share');
  const [slot] = await lockSlots(tx, [slotId]);
  const [signup] = await lockSignups(tx, [signupId], owner ? { personId: owner.personId } : null);
  if (!signup) return null;
  if (!sheet || !slot || signup.slotId !== slotId) throw new Restart();
  if (owner && !(await memberStillValid(tx, owner))) return null;
  return { sheet, slot, signup };
}

// --- W2: cancel (a member) or remove (the organizer) -------------------------------------------------------------

export type CancelResult =
  | { kind: 'missing' }
  /** A member's own sign-up on a closed sheet, or on a date cancelled or started: nothing changed. */
  | { kind: 'locked' }
  | {
      kind: 'cancelled';
      slug: string;
      slotId: string;
      promoted: number;
      /** A confirmed place within the next 7 days that nobody moved up into: ask the group to take it. */
      askGroup: boolean;
    };

/**
 * W2. Deletes the sign-up and, if it was confirmed on a date still open, moves the slot's first waiting person up into
 * the place it left. `owner` is the member cancelling their own (null: the organizer removing someone), which they may
 * do only while the sheet is open and the date neither cancelled nor started; the organizer may at any time.
 */
export async function cancelSignup(
  pool: pg.Pool,
  input: { signupId: string; owner: MemberAuth | null },
  ctx: WriteContext
): Promise<CancelResult> {
  return inTransaction(
    pool,
    async (tx): Promise<CancelResult> => {
      const locked = await lockOneSignup(tx, input.signupId, input.owner);
      if (!locked) return { kind: 'missing' };
      const { sheet, slot, signup } = locked;
      if (input.owner && !memberMayChange(sheet, slot, ctx.now)) return { kind: 'locked' };
      await tx.query('delete from signups where id = $1', [signup.id]);
      const open = stillOpen(slot, sheet.timezone, ctx.now);
      const promoted = signup.status === 'confirmed' && open ? await promoteWaiting(tx, slot.id) : [];
      await recordActivity(tx, { actor: ctx.actor, kind: input.owner ? 'cancel' : 'remove', browser: ctx.browser, sheetId: sheet.id });
      const soon = slot.onDate <= addDays(civilToday(sheet.timezone, ctx.now), 6);
      return {
        kind: 'cancelled',
        slug: sheet.slug,
        slotId: slot.id,
        promoted: promoted.length,
        askGroup: signup.status === 'confirmed' && open && promoted.length === 0 && soon
      };
    },
    { attempts: 3 }
  );
}

// --- W3: move -----------------------------------------------------------------------------------------------------

export type MoveRefusal = 'same' | 'gone' | 'closed' | 'past' | 'cancelled' | 'taken';
export type MoveResult =
  | { kind: 'missing' }
  | { kind: 'refused'; reason: MoveRefusal }
  | { kind: 'moved'; slug: string; promoted: number };

/**
 * W3. Moves a sign-up to another slot of the same sheet that has a free place, as confirmed. A member moves only their
 * own, while the sheet is open and their date is neither cancelled nor started; nobody moves into a cancelled or
 * started date (the organizer may move people out of one). People waiting for the target keep their turn: the move
 * happens only if a place is left after them. The slot it left moves its first waiting person up. The organizer's move
 * marks the sign-up changed, to tell them.
 */
export async function moveSignup(
  pool: pg.Pool,
  input: { signupId: string; toSlotId: string; owner: MemberAuth | null },
  ctx: WriteContext
): Promise<MoveResult> {
  return inTransaction(
    pool,
    async (tx): Promise<MoveResult> => {
      const first = await tx.query<{ slotId: string }>(
        'select slot_id as "slotId" from signups where id = $1 and ($2::bigint is null or person_id = $2::bigint)',
        [input.signupId, input.owner?.personId ?? null]
      );
      const fromId = first.rows[0]?.slotId;
      if (!fromId) return { kind: 'missing' };
      if (fromId === input.toSlotId) return { kind: 'refused', reason: 'same' };

      const sheets = await lockSheetsOfSlots(tx, [fromId, input.toSlotId], 'share');
      const slots = await lockSlots(tx, [fromId, input.toSlotId]);
      const [signup] = await lockSignups(tx, [input.signupId], input.owner ? { personId: input.owner.personId } : null);
      if (!signup) return { kind: 'missing' };
      const from = slots.find((slot) => slot.id === fromId);
      if (!from || signup.slotId !== fromId) throw new Restart();
      if (input.owner && !(await memberStillValid(tx, input.owner))) return { kind: 'missing' };

      const to = slots.find((slot) => slot.id === input.toSlotId);
      const sheet = sheets.find((row) => row.id === from.sheetId);
      if (!to || !sheet || to.sheetId !== from.sheetId) return { kind: 'refused', reason: 'gone' };
      if (input.owner && sheet.status !== 'open') return { kind: 'refused', reason: 'closed' };
      if (input.owner && !isOpenForClaims(from.onDate, from.startsAt, sheet.timezone, ctx.now)) return { kind: 'refused', reason: 'past' };
      if (input.owner && from.cancelled) return { kind: 'refused', reason: 'cancelled' };
      if (to.cancelled) return { kind: 'refused', reason: 'cancelled' };
      if (!stillOpen(to, sheet.timezone, ctx.now)) return { kind: 'refused', reason: 'past' };

      const target = await tx.query<{ holds: boolean; waiting: number }>(
        `select exists (select 1 from signups where slot_id = $1 and person_id = $2) as holds,
                (select count(*)::int from signups where slot_id = $1 and status = 'waiting') as waiting`,
        [to.id, signup.personId]
      );
      const { holds, waiting } = target.rows[0]!;
      const free = to.capacity - to.confirmedCount;
      if (holds || free - Math.min(free, waiting) <= 0) return { kind: 'refused', reason: 'taken' };
      await promoteWaiting(tx, to.id);

      await tx.query(
        `update signups set slot_id = $2, status = 'confirmed', queued_at = clock_timestamp(), promoted_at = null, told_at = null,
                changed_at = case when $3 then now() end, revised_at = now()
          where id = $1`,
        [signup.id, to.id, input.owner === null]
      );
      const promoted = signup.status === 'confirmed' && stillOpen(from, sheet.timezone, ctx.now) ? await promoteWaiting(tx, from.id) : [];
      await recordActivity(tx, { actor: ctx.actor, kind: 'move', browser: ctx.browser, sheetId: sheet.id });
      return { kind: 'moved', slug: sheet.slug, promoted: promoted.length };
    },
    { attempts: 3 }
  );
}

// --- W4: swap (the organizer) -------------------------------------------------------------------------------------

export type SwapResult =
  | { kind: 'missing' }
  /** Something changed since the organizer looked (a sign-up moved, went or is waiting), or one person already holds the other's slot. */
  | { kind: 'refused'; reason: 'changed' | 'conflict' | 'past' | 'cancelled' }
  | { kind: 'swapped'; slug: string; signupIds: [string, string] };

/**
 * W4. Two confirmed sign-ups on different slots of one sheet trade places. Both slots are locked in id order, then both
 * sign-ups, and everything is checked again. The capacity CHECK is checked row by row, so the order matters: A waits,
 * B moves to A's slot, A moves to B's slot as confirmed. Nobody is promoted, both counts end where they started, and
 * both waitlists keep their order. Both are marked changed, to tell them.
 */
export async function swapSignups(pool: pg.Pool, input: { a: string; b: string }, ctx: WriteContext): Promise<SwapResult> {
  return inTransaction(
    pool,
    async (tx): Promise<SwapResult> => {
      if (input.a === input.b) return { kind: 'refused', reason: 'changed' };
      const first = await tx.query<{ id: string; slotId: string }>(
        'select id, slot_id as "slotId" from signups where id = any($1::bigint[])',
        [[input.a, input.b]]
      );
      const slotOf = new Map(first.rows.map((row) => [row.id, row.slotId]));
      const slotA = slotOf.get(input.a);
      const slotB = slotOf.get(input.b);
      if (!slotA || !slotB) return { kind: 'missing' };

      const sheets = await lockSheetsOfSlots(tx, [slotA, slotB], 'share');
      const slots = await lockSlots(tx, [slotA, slotB]);
      const signups = await lockSignups(tx, [input.a, input.b]);
      const a = signups.find((row) => row.id === input.a);
      const b = signups.find((row) => row.id === input.b);
      if (!a || !b) return { kind: 'missing' };
      if (a.slotId !== slotA || b.slotId !== slotB || a.slotId === b.slotId) return { kind: 'refused', reason: 'changed' };
      if (a.status !== 'confirmed' || b.status !== 'confirmed') return { kind: 'refused', reason: 'changed' };
      const placeA = slots.find((slot) => slot.id === slotA);
      const placeB = slots.find((slot) => slot.id === slotB);
      const sheet = sheets[0];
      if (!placeA || !placeB || !sheet || sheets.length !== 1) return { kind: 'refused', reason: 'changed' };
      if (placeA.cancelled || placeB.cancelled) return { kind: 'refused', reason: 'cancelled' };
      if (!stillOpen(placeA, sheet.timezone, ctx.now) || !stillOpen(placeB, sheet.timezone, ctx.now)) return { kind: 'refused', reason: 'past' };

      const crossed = await tx.query(
        'select 1 from signups where (slot_id = $1 and person_id = $2) or (slot_id = $3 and person_id = $4)',
        [slotA, b.personId, slotB, a.personId]
      );
      if (crossed.rows.length > 0) return { kind: 'refused', reason: 'conflict' };

      await tx.query("update signups set status = 'waiting' where id = $1", [a.id]);
      await tx.query('update signups set slot_id = $2, changed_at = now(), told_at = null, revised_at = now() where id = $1', [b.id, slotA]);
      await tx.query(
        "update signups set slot_id = $2, status = 'confirmed', changed_at = now(), told_at = null, revised_at = now() where id = $1",
        [a.id, slotB]
      );
      await recordActivity(tx, { actor: ctx.actor, kind: 'swap', browser: ctx.browser, sheetId: sheet.id });
      return { kind: 'swapped', slug: sheet.slug, signupIds: [a.id, b.id] };
    },
    { attempts: 3 }
  );
}

// --- W5: a sign-up's note; Told them ------------------------------------------------------------------------------

export type NoteResult = { kind: 'missing' } | { kind: 'locked' } | { kind: 'refused'; reason: 'note' } | { kind: 'saved'; slug: string };

/**
 * W5. A sign-up's public note, by its member (`owner`, only while the sheet is open and the date neither cancelled nor
 * started) or the organizer (null). A sheet that asks for one keeps it. The note is in the person's calendar file, so a
 * new one revises it (never marked changed by the organizer: that is for moves and new dates the organizer makes).
 */
export async function changeNote(
  pool: pg.Pool,
  input: { signupId: string; owner: MemberAuth | null; note: string },
  ctx: WriteContext
): Promise<NoteResult> {
  return inTransaction(
    pool,
    async (tx): Promise<NoteResult> => {
      const locked = await lockOneSignup(tx, input.signupId, input.owner);
      if (!locked) return { kind: 'missing' };
      if (input.owner && !memberMayChange(locked.sheet, locked.slot, ctx.now)) return { kind: 'locked' };
      if (locked.sheet.noteRequired && !input.note) return { kind: 'refused', reason: 'note' };
      await tx.query(
        'update signups set note = $2, revised_at = case when note is distinct from $2::text then now() else revised_at end where id = $1',
        [locked.signup.id, input.note]
      );
      await recordActivity(tx, { actor: ctx.actor, kind: 'note', browser: ctx.browser, sheetId: locked.sheet.id });
      return { kind: 'saved', slug: locked.sheet.slug };
    },
    { attempts: 3 }
  );
}

/** The organizer's "Told them" on a moved-up or changed sign-up, and its Undo. */
export async function markTold(
  pool: pg.Pool,
  input: { signupId: string; told: boolean },
  ctx: WriteContext
): Promise<{ kind: 'missing' } | { kind: 'saved'; slug: string }> {
  return inTransaction(
    pool,
    async (tx) => {
      const locked = await lockOneSignup(tx, input.signupId, null);
      if (!locked) return { kind: 'missing' as const };
      await tx.query('update signups set told_at = case when $2 then now() end where id = $1', [locked.signup.id, input.told]);
      await recordActivity(tx, { actor: ctx.actor, kind: input.told ? 'told' : 'untold', browser: ctx.browser, sheetId: locked.sheet.id });
      return { kind: 'saved' as const, slug: locked.sheet.slug };
    },
    { attempts: 3 }
  );
}
