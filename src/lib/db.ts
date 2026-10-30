// The app's connection pool (one per process) and its transactions (see TOFU.md, Database).
//
// Tofu's database is reached through a transaction pooler, so: queries are never named (the pooler keeps no prepared
// statements), nothing is set for the session (only SET LOCAL inside a transaction), no session advisory locks, no
// LISTEN, no temporary tables, and transactions stay READ COMMITTED (caps.ts relies on each statement's fresh
// snapshot). Nothing here reads the database when it is imported: `next build` runs with DATABASE_URL set and must not
// freeze anything into a page.
import pg from 'pg';
import { connectionSettings, DatabaseConfigError } from '../../scripts/tofu-database.mjs';
import { logFailure } from './log';

// Dates stay the civil 'YYYY-MM-DD' strings they are in the sheet's time zone; node-postgres would otherwise make a Date
// at the process's own local midnight.
pg.types.setTypeParser(pg.types.builtins.DATE, (value: string) => value);

export const POOL_SETTINGS = {
  max: 3,
  idleTimeoutMillis: 5_000,
  connectionTimeoutMillis: 10_000,
  // The client's own deadline for a reply: the server's statement_timeout cannot help when the pooler loses one.
  query_timeout: 15_000,
  allowExitOnIdle: true
} as const;

/** Anything that runs a query: the pool, or a transaction's client. */
export interface Db {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}

export function createPool(env: Record<string, string | undefined> = process.env): pg.Pool {
  const pool = new pg.Pool({ ...connectionSettings(env), ...POOL_SETTINGS });
  // An idle connection that breaks is dropped by the pool; without a listener its error would end the process.
  pool.on('error', (error) => logFailure('idle database connection', error));
  return pool;
}

const shared = globalThis as typeof globalThis & { signupSheetPool?: pg.Pool };

/** The process's pool, made on first use and kept on globalThis, so a reloaded module reuses it. */
export function appPool(): pg.Pool {
  shared.signupSheetPool ??= createPool();
  return shared.signupSheetPool;
}

// Every transaction's first statement. A lock wait or a statement longer than these ends it with SQLSTATE 55P03 or
// 57014, which the app answers with its busy page.
const BEGIN = "begin; set local lock_timeout = '5s'; set local statement_timeout = '10s'";

/** Thrown by a transaction's work to roll back and run the work again from BEGIN (see `inTransaction`). */
export class Restart extends Error {
  constructor() {
    super('restart the transaction');
    this.name = 'Restart';
  }
}

/** A transaction that kept having to restart: answered like a lock timeout. */
export class StillBusy extends Error {
  constructor() {
    super('the transaction kept restarting');
    this.name = 'StillBusy';
  }
}

export type TransactionOptions = {
  /** How many times the work may run in all (default 1). */
  attempts?: number;
  /** Errors besides `Restart` that run the work again from BEGIN while attempts are left. */
  retryWhen?: (error: unknown) => boolean;
};

/**
 * Runs `work` in one transaction on one pooled client, and commits. On any error it rolls back, destroys the client
 * (one in an unknown state never goes back to the pool) and either runs the work again or throws.
 */
export async function inTransaction<T>(
  pool: pg.Pool,
  work: (tx: Db) => Promise<T>,
  options: TransactionOptions = {}
): Promise<T> {
  const attempts = options.attempts ?? 1;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await runOnce(pool, work);
    } catch (error) {
      const again = error instanceof Restart || (options.retryWhen?.(error) ?? false);
      if (again && attempt < attempts) continue;
      if (error instanceof Restart) throw new StillBusy();
      throw error;
    }
  }
}

async function runOnce<T>(pool: pg.Pool, work: (tx: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let result: T;
  try {
    await client.query(BEGIN);
    result = await work(client);
    await client.query('commit');
  } catch (error) {
    // A short deadline: after a lost reply the rollback would wait behind it. Ending the connection rolls back anyway.
    await client.query({ text: 'rollback', query_timeout: 1_000 } as pg.QueryConfig).catch(() => {});
    client.release(true);
    throw error;
  }
  client.release();
  return result;
}

// A read of many tables at one instant (the export): REPEATABLE READ, so every statement sees the same snapshot, and
// READ ONLY, so it can never write. It takes no row locks and holds up no write.
const SNAPSHOT = "begin isolation level repeatable read read only; set local statement_timeout = '10s'";

/** Runs `read` in a read-only transaction whose statements all see the database as it was when the first one ran. */
export async function readSnapshot<T>(pool: pg.Pool, read: (tx: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let result: T;
  try {
    await client.query(SNAPSHOT);
    result = await read(client);
    await client.query('commit');
  } catch (error) {
    await client.query({ text: 'rollback', query_timeout: 1_000 } as pg.QueryConfig).catch(() => {});
    client.release(true);
    throw error;
  }
  client.release();
  return result;
}

export type DbFailure = 'busy' | 'unavailable' | 'error';

const BUSY = new Set(['55P03', '57014', '40001', '40P01']);
const CONNECTION_MESSAGES =
  /^(Query read timeout|Connection terminated|timeout exceeded when trying to connect|The server does not support SSL connections|Client has encountered a connection error)/;

/**
 * What a failure means for the answer: `busy` (a lock or statement timeout, a serialization failure or a deadlock),
 * `unavailable` (no connection, a lost reply, a bad database setting) or `error` (anything else). Busy and unavailable
 * both answer 503; error answers a plain 500.
 */
export function dbFailure(error: unknown): DbFailure {
  if (error instanceof StillBusy) return 'busy';
  if (error instanceof DatabaseConfigError) return 'unavailable';
  if (error instanceof pg.DatabaseError) {
    const code = error.code ?? '';
    if (BUSY.has(code)) return 'busy';
    // Connection exceptions, too many connections, a server shutting down or starting, failed sign-in, no database.
    if (/^(08|28|57P)/.test(code) || code === '53300' || code === '3D000') return 'unavailable';
    return 'error';
  }
  if (error instanceof Error) {
    if (CONNECTION_MESSAGES.test(error.message)) return 'unavailable';
    const { code, syscall } = error as { code?: unknown; syscall?: unknown };
    // A socket error (ECONNREFUSED, ETIMEDOUT, EAI_AGAIN …) names its system call; a TLS verification failure its code.
    if (typeof syscall === 'string') return 'unavailable';
    if (typeof code === 'string' && /^(ERR_TLS_\w+|ERR_SSL_\w+|\w*CERT\w*|UNABLE_TO_\w+)$/.test(code)) return 'unavailable';
  }
  return 'error';
}

/** True for a database error with this SQLSTATE (and, when given, this constraint). */
export function isDbError(error: unknown, code: string, constraint?: string): boolean {
  return (
    error instanceof pg.DatabaseError &&
    error.code === code &&
    (constraint === undefined || error.constraint === constraint)
  );
}
