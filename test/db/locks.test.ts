// The lock order and the shared sign-up steps (locks.ts). Opposing lock orders are lined up with a barrier, so the
// negative control deadlocks every time instead of when the scheduler allows it.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type pg from 'pg';
import { type Db, inTransaction, isDbError } from '../../src/lib/db';
import { lockSheets, lockSheetsOfSlots, lockSignups, lockSlots, promoteWaiting, waitlistPosition } from '../../src/lib/locks';
import { barrier, countMismatches, dayFromToday, poolFor, seedPerson, seedSheet, seedSignup, seedSlot } from '../support/fixtures';
import { type Cluster, startCluster } from '../support/postgres';

let cluster: Cluster;
let first: pg.Pool;
let second: pg.Pool;

before(async () => {
  cluster = await startCluster();
  const url = await cluster.createDatabase({ migrated: true });
  first = poolFor(url);
  second = poolFor(url);
});

after(async () => {
  await first?.end();
  await second?.end();
  await cluster?.stop();
});

test('two writes naming the same slots in opposite orders never deadlock: lockSlots sorts them (20 rounds)', async () => {
  const sheet = await seedSheet(first, 'order');
  const a = (await seedSlot(first, sheet)).slotId;
  const b = (await seedSlot(first, sheet, { onDate: dayFromToday(17) })).slotId;
  for (let round = 0; round < 20; round += 1) {
    const ready = barrier(2);
    await Promise.all([
      inTransaction(first, async (tx) => {
        await ready();
        const locked = await lockSlots(tx, [b, a]);
        assert.deepEqual(locked.map((slot) => slot.id), [a, b]);
      }),
      inTransaction(second, async (tx) => {
        await ready();
        await lockSlots(tx, [a, b]);
      })
    ]);
  }
});

test('negative control: locking one slot at a time in the order given deadlocks (40P01)', async () => {
  const sheet = await seedSheet(first, 'deadlock');
  const a = (await seedSlot(first, sheet)).slotId;
  const b = (await seedSlot(first, sheet, { onDate: dayFromToday(17) })).slotId;
  const holdingOne = barrier(2);
  const lockOne = (tx: Db, id: string) => tx.query('select id from slots where id = $1 for update', [id]);
  const results = await Promise.allSettled([
    inTransaction(first, async (tx) => {
      await lockOne(tx, a);
      await holdingOne();
      await lockOne(tx, b);
    }),
    inTransaction(second, async (tx) => {
      await lockOne(tx, b);
      await holdingOne();
      await lockOne(tx, a);
    })
  ]);
  const deadlocks = results.filter((result) => result.status === 'rejected' && isDbError(result.reason, '40P01'));
  assert.equal(deadlocks.length, 1, 'the harness can see the deadlock that the order prevents');
});

test('claims on one sheet share its lock; a change to the sheet waits for them, and they wait for it', async () => {
  const sheet = await seedSheet(first, 'sharing');
  const a = (await seedSlot(first, sheet)).slotId;
  const b = (await seedSlot(first, sheet, { onDate: dayFromToday(17) })).slotId;
  const both = barrier(2);
  // Two claims at once, each holding the sheet FOR SHARE and its own slot: neither waits for the other.
  await Promise.all(
    [a, b].map((slot, i) =>
      inTransaction(i ? second : first, async (tx) => {
        assert.equal((await lockSheetsOfSlots(tx, [slot], 'share')).length, 1);
        await lockSlots(tx, [slot]);
        await both();
      })
    )
  );

  const events: string[] = [];
  let release!: () => void;
  const claimMayCommit = new Promise<void>((resolve) => (release = resolve));
  let started!: () => void;
  const claimHolds = new Promise<void>((resolve) => (started = resolve));
  const claim = inTransaction(first, async (tx) => {
    await lockSheetsOfSlots(tx, [a], 'share');
    await lockSlots(tx, [a]);
    started();
    await claimMayCommit;
    events.push('claim');
  });
  await claimHolds;
  const cancelDate = inTransaction(second, async (tx) => {
    await lockSheets(tx, [sheet], 'update');
    events.push('date cancelled');
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(events.length, 0, 'the structural change waits for the claim in flight');
  release();
  await Promise.all([claim, cancelDate]);
  assert.deepEqual(events, ['claim', 'date cancelled']);
});

test('promotion fills only the free places, earliest first, and numbers the rest of the waitlist from 1', async () => {
  const sheet = await seedSheet(first, 'promote');
  const { slotId } = await seedSlot(first, sheet, { capacity: 3 });
  const confirmed = await seedSignup(first, slotId, await seedPerson(first, 'Mike'), 'confirmed');
  const waiting: string[] = [];
  for (const name of ['W1', 'W2', 'W3', 'W4']) waiting.push(await seedSignup(first, slotId, await seedPerson(first, name), 'waiting'));
  // Raw ids and queue times would not give 1, 2, …: the number is counted.
  assert.deepEqual(await Promise.all(waiting.map((id) => waitlistPosition(first, id))), [1, 2, 3, 4]);
  assert.equal(await waitlistPosition(first, confirmed), null);

  const promoted = await inTransaction(first, async (tx) => {
    await lockSheetsOfSlots(tx, [slotId], 'share');
    await lockSlots(tx, [slotId]);
    return promoteWaiting(tx, slotId);
  });
  assert.deepEqual(promoted.map((row) => row.id), waiting.slice(0, 2));
  assert.deepEqual(await Promise.all(waiting.slice(2).map((id) => waitlistPosition(first, id))), [1, 2]);
  const { rows } = await first.query<{ id: string; promoted: boolean }>(
    'select id, promoted_at is not null as promoted from signups where slot_id = $1 order by id',
    [slotId]
  );
  assert.deepEqual(rows.filter((row) => row.promoted).map((row) => row.id), waiting.slice(0, 2));
  assert.deepEqual(await countMismatches(first), []);

  const none = await inTransaction(first, async (tx) => {
    await lockSlots(tx, [slotId]);
    return promoteWaiting(tx, slotId);
  });
  assert.deepEqual(none, [], 'a full slot promotes nobody');
});

test("a sign-up locked for its owner is found; another person's id finds nothing", async () => {
  const sheet = await seedSheet(first, 'owners');
  const { slotId } = await seedSlot(first, sheet, { capacity: 2 });
  const mike = await seedPerson(first, 'Mike');
  const frank = await seedPerson(first, 'Frank');
  const mikes = await seedSignup(first, slotId, mike, 'confirmed');
  await inTransaction(first, async (tx) => {
    assert.deepEqual((await lockSignups(tx, [mikes], { personId: mike })).map((row) => row.id), [mikes]);
    assert.deepEqual(await lockSignups(tx, [mikes], { personId: frank }), []);
    assert.equal((await lockSignups(tx, [mikes])).length, 1);
  });
});
