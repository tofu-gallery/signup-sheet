// The per-copy row caps under concurrency. Claims are lined up with a barrier after their cap check, so every claim's
// check runs while all the others are still in flight: the worst case, every time.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type pg from 'pg';
import { checkCaps, checkCapsForClaim, ROW_CAPS, RowCapError } from '../../src/lib/caps';
import { type Db, inTransaction } from '../../src/lib/db';
import { barrier, poolFor, waitFor } from '../support/fixtures';
import { type Cluster, startCluster } from '../support/postgres';

let cluster: Cluster;
const pools: pg.Pool[] = [];

before(async () => {
  cluster = await startCluster();
});

after(async () => {
  await Promise.all(pools.map((pool) => pool.end()));
  await cluster?.stop();
});

/** Four app processes (pools of 3) on a fresh copy holding `people` people. */
async function copyWithPeople(people: number): Promise<pg.Pool[]> {
  const url = await cluster.createDatabase({ migrated: true });
  const processes = Array.from({ length: 4 }, () => poolFor(url));
  pools.push(...processes);
  await processes[0]!.query(
    "insert into people (name, added_by) select 'Person ' || g, 'import' from generate_series(1, $1::int) g",
    [people]
  );
  return processes;
}

async function peopleCount(db: Db): Promise<number> {
  return (await db.query<{ n: number }>('select count(*)::int as n from people')).rows[0]!.n;
}

const addPerson = (tx: Db, name: string) => tx.query("insert into people (name, added_by) values ($1, 'member')", [name]);

test('one at a time, the cap is exact: the 2,000th person fits and the next is refused', async () => {
  const [pool] = await copyWithPeople(ROW_CAPS.people - 1);
  await inTransaction(pool!, async (tx) => {
    await checkCapsForClaim(tx);
    await addPerson(tx, 'Mike');
  });
  await assert.rejects(
    inTransaction(pool!, async (tx) => {
      await checkCapsForClaim(tx);
      await addPerson(tx, 'Frank');
    }),
    (error: unknown) => error instanceof RowCapError && error.table === 'people'
  );
  assert.equal(await peopleCount(pool!), ROW_CAPS.people);
});

test('twelve claims in flight at once, three places left: the cap holds, and claims never waited for one another', async () => {
  const processes = await copyWithPeople(ROW_CAPS.people - 3);
  const arrive = barrier(12);
  const outcomes = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      inTransaction(processes[i % 4]!, async (tx) => {
        try {
          await checkCapsForClaim(tx);
        } catch (error) {
          await arrive();
          throw error;
        }
        // Every claim is here at once, each holding the shared lock: none had to wait for another.
        await arrive();
        await addPerson(tx, `Claimer ${i}`);
      }).then(
        () => 'added',
        (error: unknown) => (error instanceof RowCapError ? 'refused' : `error: ${String(error)}`)
      )
    )
  );
  const added = outcomes.filter((outcome) => outcome === 'added').length;
  assert.deepEqual(outcomes.filter((outcome) => outcome !== 'added' && outcome !== 'refused'), []);
  const total = await peopleCount(processes[0]!);
  assert.equal(total, ROW_CAPS.people - 3 + added);
  assert.ok(total <= ROW_CAPS.people, `${total} people`);
  console.log(`# 12 concurrent claims with 3 places left: ${added} added, ${12 - added} refused`);

  // Afterwards a claim goes ahead exactly when a place is left.
  const next = await inTransaction(processes[1]!, async (tx) => {
    await checkCapsForClaim(tx);
    await addPerson(tx, 'Later');
  }).then(() => true, () => false);
  assert.equal(next, total < ROW_CAPS.people);
});

test('negative control: counting without the lock lets the same race go over the cap', async () => {
  const processes = await copyWithPeople(ROW_CAPS.people - 3);
  const arrive = barrier(12);
  await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      inTransaction(processes[i % 4]!, async (tx) => {
        if ((await peopleCount(tx)) + 1 > ROW_CAPS.people) throw new RowCapError('people');
        await arrive();
        await addPerson(tx, `Claimer ${i}`);
      })
    )
  );
  assert.ok((await peopleCount(processes[0]!)) > ROW_CAPS.people, 'the race test can see an overfilled table');
});

test('an exclusive check waits for the claims in flight and holds new claims off until it commits', async () => {
  const processes = await copyWithPeople(10);
  const events: string[] = [];
  let releaseClaim!: () => void;
  const claimMayCommit = new Promise<void>((resolve) => (releaseClaim = resolve));
  let claimChecked!: () => void;
  const claimHasLock = new Promise<void>((resolve) => (claimChecked = resolve));

  const claim = inTransaction(processes[0]!, async (tx) => {
    await checkCapsForClaim(tx);
    claimChecked();
    await claimMayCommit;
    await addPerson(tx, 'In flight');
    events.push('claim committed');
  });
  await claimHasLock;

  let releaseImport!: () => void;
  const importMayCommit = new Promise<void>((resolve) => (releaseImport = resolve));
  const importDone = inTransaction(processes[1]!, async (tx) => {
    await checkCaps(tx, { people: 3 });
    events.push('import checked');
    await importMayCommit;
    await tx.query("insert into people (name, added_by) select 'Imported ' || g, 'import' from generate_series(1, 3) g");
  });

  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(events.length, 0, 'the import waits for the claim in flight');
  releaseClaim();
  await claim;
  await waitFor(async () => events.includes('import checked'), 'the import check');

  let laterClaimDone = false;
  const laterClaim = inTransaction(processes[2]!, async (tx) => {
    await checkCapsForClaim(tx);
    await addPerson(tx, 'Later');
  }).then(() => (laterClaimDone = true));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(laterClaimDone, false, 'a new claim waits for the import');
  releaseImport();
  await importDone;
  await laterClaim;
  assert.deepEqual(events, ['claim committed', 'import checked']);
  assert.equal(await peopleCount(processes[0]!), 15);
});

test('exclusive checks count exactly against each cap', async () => {
  const [pool] = await copyWithPeople(0);
  await pool!.query(
    "insert into sheets (slug, title) select 'sheet-' || g, 'Sheet ' || g from generate_series(1, $1::int) g",
    [ROW_CAPS.sheets - 2]
  );
  await assert.rejects(
    inTransaction(pool!, (tx) => checkCaps(tx, { sheets: 3 })),
    (error: unknown) => error instanceof RowCapError && error.table === 'sheets'
  );
  await inTransaction(pool!, (tx) => checkCaps(tx, { sheets: 2, people: 2_000 }));
  await assert.rejects(
    inTransaction(pool!, (tx) => checkCaps(tx, { people: 2_001 })),
    (error: unknown) => error instanceof RowCapError && error.table === 'people'
  );
});

test('claims and an import racing near the cap never go over it', async () => {
  const processes = await copyWithPeople(ROW_CAPS.people - 6);
  const runs = Array.from({ length: 8 }, (_, i) =>
    inTransaction(processes[i % 4]!, async (tx) => {
      await checkCapsForClaim(tx);
      await addPerson(tx, `Claimer ${i}`);
    }).catch((error: unknown) => {
      if (!(error instanceof RowCapError)) throw error;
    })
  );
  runs.push(
    inTransaction(processes[3]!, async (tx) => {
      await checkCaps(tx, { people: 3 });
      await tx.query("insert into people (name, added_by) select 'Imported ' || g, 'import' from generate_series(1, 3) g");
    }).catch((error: unknown) => {
      if (!(error instanceof RowCapError)) throw error;
    })
  );
  await Promise.all(runs);
  assert.ok((await peopleCount(processes[0]!)) <= ROW_CAPS.people);
});
