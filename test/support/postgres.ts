// Disposable PostgreSQL clusters, and PgBouncer in transaction mode, for the tests.
//
// Each cluster lives in its own directory /tmp/ss-pg-<test process pid>-<random> and listens on 127.0.0.1 only, on a
// port from 54300–54309, or SIGNUP_SHEET_PG_PORTS (no Unix socket). The process that made a cluster is the only one that
// ever stops it or deletes its directory: the test that starts it does, and so do an exit hook and SIGINT, SIGTERM and
// SIGHUP handlers if the test process ends early. Nothing here looks at, signals or deletes a directory this process did
// not make, another run's included, whether or not that run's process still runs (a machine is shared). Only a postgres
// or pgbouncer process whose command line names this process's own directory is ever signalled.
//
// Like a Supabase database made before 2026-10-30, every database here has the roles anon and authenticated, which may
// use schema public and get every table, sequence and function the app's role (app_owner, the owner of what it
// creates, not a superuser) creates there. The app connects as app_owner.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { delimiter, join, resolve } from 'node:path';
import pg from 'pg';
import { connectionSettings } from '../../scripts/tofu-database.mjs';

export const REPO = resolve(import.meta.dirname, '../..');

const ROOT = '/tmp';
// SIGNUP_SHEET_PG_PORTS ('54310-54319') gives a run its own range, so two runs on one machine never share ports.
const PORTS = (() => {
  const [first, last] = (process.env.SIGNUP_SHEET_PG_PORTS ?? '54300-54309').split('-').map(Number);
  if (!first || !last || last < first || last - first > 50) throw new Error('SIGNUP_SHEET_PG_PORTS must look like 54310-54319');
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
})();
const portsTaken = new Set<number>();
const liveDirectories = new Set<string>();

export type Tls = { certFile: string; keyFile: string; caPem: string };

export type Cluster = {
  dir: string;
  port: number;
  /** An app_owner URL for a database on this cluster (with sslmode=require on a TLS cluster). */
  url(database: string): string;
  /** Runs SQL as the superuser, by default in database postgres. */
  admin<R extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, values?: unknown[], database?: string): Promise<R[]>;
  /** A connected superuser client in `database`; the caller ends it. */
  superClient(database: string): Promise<pg.Client>;
  /** A new database from the old-defaults template, migrated or not; answers its app_owner URL. */
  createDatabase(options: { migrated: boolean }): Promise<string>;
  stop(): Promise<void>;
};

function onPath(name: string): string {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(dir, name);
    if (dir && existsSync(candidate)) return candidate;
  }
  throw new Error(`${name} is not on PATH: these tests need the PostgreSQL 14 server binaries and PgBouncer`);
}

function pgBinary(name: 'initdb' | 'pg_ctl'): string {
  const dir = process.env.SIGNUP_SHEET_PG_BIN;
  return dir ? join(dir, name) : onPath(name);
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  if (result.status !== 0) {
    throw new Error(`${command} ${args[0] ?? ''} failed: ${(result.stderr || result.stdout || '').slice(-2000)}`);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Signals `pid` only when its command line names `marker` (this test's own directory). */
function signalIfOurs(pid: number, marker: string, signal: NodeJS.Signals): void {
  if (!Number.isInteger(pid) || pid <= 1) return;
  const ps = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  if (ps.status !== 0 || !ps.stdout.includes(marker)) return;
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
  const deadline = Date.now() + 10_000;
  while (alive(pid) && Date.now() < deadline) spawnSync('sleep', ['0.1']);
}

/** Stops whatever runs from `dir` (its postmaster, its PgBouncers) and deletes it. Synchronous, for the exit hook. */
function removeDirectory(dir: string): void {
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (/^pgbouncer-[0-9]+\.pid$/.test(name)) {
        signalIfOurs(Number(readFileSync(join(dir, name), 'utf8')), dir, 'SIGTERM');
      }
    }
    const pidFile = join(dir, 'data', 'postmaster.pid');
    if (existsSync(pidFile)) {
      // SIGQUIT: PostgreSQL's immediate shutdown.
      signalIfOurs(Number(readFileSync(pidFile, 'utf8').split('\n')[0]), join(dir, 'data'), 'SIGQUIT');
    }
    rmSync(dir, { recursive: true, force: true });
  }
  liveDirectories.delete(dir);
}

function removeOwnDirectories(): void {
  for (const dir of [...liveDirectories]) removeDirectory(dir);
}

process.on('exit', removeOwnDirectories);
// A signal ends the process without the exit hook: remove this process's own clusters, then end as the signal would.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.once(signal, () => {
    removeOwnDirectories();
    process.kill(process.pid, signal);
  });
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.once('error', () => resolvePort(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolvePort(true)));
  });
}

async function takePort(): Promise<number> {
  for (const port of PORTS) {
    if (!portsTaken.has(port) && (await portFree(port))) {
      portsTaken.add(port);
      return port;
    }
  }
  throw new Error(`no free port in ${PORTS[0]}-${PORTS.at(-1)}`);
}

function waitForPort(port: number, child?: ChildProcess): Promise<void> {
  const deadline = Date.now() + 15_000;
  return new Promise((resolveWait, rejectWait) => {
    const attempt = () => {
      if (child && child.exitCode !== null) return rejectWait(new Error(`the process for port ${port} exited`));
      const socket = connect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        resolveWait();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) rejectWait(new Error(`nothing listens on port ${port}`));
        else setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

const OLD_DEFAULTS = [
  'alter schema public owner to app_owner',
  'grant usage on schema public to anon, authenticated',
  'alter default privileges for role app_owner in schema public grant all on tables to anon, authenticated',
  'alter default privileges for role app_owner in schema public grant all on sequences to anon, authenticated',
  'alter default privileges for role app_owner in schema public grant execute on functions to anon, authenticated'
];

/** A scratch directory of this process's own (for a test CA, say), removed like its clusters' directories. */
export function scratchDirectory(): { dir: string; remove(): void } {
  const dir = join(ROOT, `ss-pg-${process.pid}-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { mode: 0o700 });
  liveDirectories.add(dir);
  return { dir, remove: () => removeDirectory(dir) };
}

export async function startCluster(options: { tls?: Tls } = {}): Promise<Cluster> {
  const dir = join(ROOT, `ss-pg-${process.pid}-${randomBytes(4).toString('hex')}`);
  const data = join(dir, 'data');
  mkdirSync(dir, { mode: 0o700 });
  liveDirectories.add(dir);

  run(pgBinary('initdb'), ['-D', data, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--no-locale', '--no-sync']);
  const port = await takePort();
  const settings = [
    `port = ${port}`,
    "listen_addresses = '127.0.0.1'",
    "unix_socket_directories = ''",
    'fsync = off',
    'synchronous_commit = off',
    'full_page_writes = off',
    'max_connections = 60',
    'shared_buffers = 32MB'
  ];
  if (options.tls) {
    settings.push('ssl = on', `ssl_cert_file = '${options.tls.certFile}'`, `ssl_key_file = '${options.tls.keyFile}'`);
    // Every connection must use TLS: a plain one is refused.
    writeFileSync(join(data, 'pg_hba.conf'), 'hostssl all all 127.0.0.1/32 trust\nhost all all 127.0.0.1/32 reject\n');
  } else {
    writeFileSync(join(data, 'pg_hba.conf'), 'host all all 127.0.0.1/32 trust\n');
  }
  appendFileSync(join(data, 'postgresql.conf'), `\n${settings.join('\n')}\n`);
  run(pgBinary('pg_ctl'), ['-D', data, '-l', join(dir, 'postgres.log'), '-w', '-t', '60', 'start']);

  const query = options.tls ? '?sslmode=require' : '';
  const urlFor = (user: string, database: string) => `postgresql://${user}@127.0.0.1:${port}/${database}${query}`;
  const clientSettings = (url: string) =>
    connectionSettings({ DATABASE_URL: url, SUPABASE_CA_CERT: options.tls?.caPem ?? '' });

  async function superClient(database: string): Promise<pg.Client> {
    const client = new pg.Client(clientSettings(urlFor('postgres', database)));
    await client.connect();
    return client;
  }

  async function admin<R extends pg.QueryResultRow>(sql: string, values: unknown[] = [], database = 'postgres') {
    const client = await superClient(database);
    try {
      return (await client.query<R>(sql, values)).rows;
    } finally {
      await client.end();
    }
  }

  await admin('create role app_owner login');
  await admin('create role anon nologin');
  await admin('create role authenticated nologin');
  await admin('create database base owner app_owner');
  for (const statement of OLD_DEFAULTS) await admin(statement, [], 'base');

  let migratedTemplate: Promise<void> | undefined;
  const ensureMigratedTemplate = () => {
    migratedTemplate ??= (async () => {
      await admin('create database migrated template base owner app_owner');
      const result = await runMigrate({ DATABASE_URL: urlFor('app_owner', 'migrated'), SUPABASE_CA_CERT: options.tls?.caPem ?? '' });
      if (result.code !== 0) throw new Error(`migrating the template failed: ${result.stderr}`);
    })();
    return migratedTemplate;
  };

  let created = 0;
  return {
    dir,
    port,
    url: (database) => urlFor('app_owner', database),
    admin,
    superClient,
    async createDatabase({ migrated }) {
      if (migrated) await ensureMigratedTemplate();
      created += 1;
      const name = `db_${created}`;
      await admin(`create database ${name} template ${migrated ? 'migrated' : 'base'} owner app_owner`);
      return urlFor('app_owner', name);
    },
    async stop() {
      spawnSync(pgBinary('pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore', timeout: 60_000 });
      removeDirectory(dir);
      portsTaken.delete(port);
    }
  };
}

export type Bouncer = { port: number; url(database: string): string; stop(): Promise<void> };

/** PgBouncer in transaction mode with no prepared-statement support, in front of `cluster`, as Tofu's pooler is. */
export async function startPgBouncer(cluster: Cluster): Promise<Bouncer> {
  const port = await takePort();
  const ini = join(cluster.dir, `pgbouncer-${port}.ini`);
  writeFileSync(join(cluster.dir, 'userlist.txt'), '"app_owner" ""\n"postgres" ""\n');
  writeFileSync(
    ini,
    [
      '[databases]',
      `* = host=127.0.0.1 port=${cluster.port}`,
      '[pgbouncer]',
      'listen_addr = 127.0.0.1',
      `listen_port = ${port}`,
      'unix_socket_dir =',
      'auth_type = trust',
      `auth_file = ${join(cluster.dir, 'userlist.txt')}`,
      'pool_mode = transaction',
      'max_prepared_statements = 0',
      'default_pool_size = 20',
      'max_client_conn = 200',
      `logfile = ${join(cluster.dir, `pgbouncer-${port}.log`)}`,
      'log_connections = 0',
      'log_disconnections = 0',
      ''
    ].join('\n')
  );
  const binary = process.env.SIGNUP_SHEET_PGBOUNCER || onPath('pgbouncer');
  const child = spawn(binary, [ini], { stdio: 'ignore' });
  writeFileSync(join(cluster.dir, `pgbouncer-${port}.pid`), String(child.pid));
  await waitForPort(port, child);
  return {
    port,
    url: (database) => `postgresql://app_owner@127.0.0.1:${port}/${database}`,
    async stop() {
      if (child.exitCode === null) {
        const exited = new Promise((resolveExit) => child.once('exit', resolveExit));
        child.kill('SIGTERM');
        await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
        if (child.exitCode === null) child.kill('SIGKILL');
      }
      rmSync(join(cluster.dir, `pgbouncer-${port}.pid`), { force: true });
      portsTaken.delete(port);
    }
  };
}

export type ScriptResult = { code: number | null; stdout: string; stderr: string; ms: number };

/** Holds the migrate script's lock in an open transaction, so builds started now are known to wait for it. */
export async function holdMigrationLock(cluster: Cluster, database: string): Promise<pg.Client> {
  const holder = await cluster.superClient(database);
  await holder.query('begin');
  await holder.query("select pg_advisory_xact_lock(hashtext('scripts/tofu-migrate.mjs'))");
  return holder;
}

/** How many advisory-lock requests are waiting on the cluster. */
export async function lockWaiters(client: pg.Client): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    "select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted"
  );
  return rows[0]?.n ?? 0;
}

/**
 * What each of several runs of the migrate script did with the first migration file: applied it, found it applied by
 * another build after waiting for the lock, or found it recorded already when it first read the ledger.
 */
export function summarizeMigrations(results: ScriptResult[]) {
  const file = '20261030000000_signup_sheet.sql';
  const outcomes = results.map((result) => {
    const lines = result.stdout.split('\n');
    if (lines.includes(`[tofu-migrate] applied ${file}`)) return 'applied';
    if (lines.includes(`[tofu-migrate] ${file} was applied by another build while this one waited`)) return 'waited';
    if (lines.includes('[tofu-migrate] 0 applied, 1 already recorded, 1 files.')) return 'already recorded';
    return 'unknown';
  });
  return {
    exits: results.map((result) => result.code),
    applied: outcomes.filter((outcome) => outcome === 'applied').length,
    waited: outcomes.filter((outcome) => outcome === 'waited').length,
    alreadyRecorded: outcomes.filter((outcome) => outcome === 'already recorded').length
  };
}

/**
 * Runs scripts/tofu-migrate.mjs with only PATH and the given settings in its environment, from the repository (or from
 * `cwd`, whose supabase/migrations it then applies).
 */
export function runMigrate(env: Record<string, string>, cwd = REPO): Promise<ScriptResult> {
  return new Promise((resolveRun) => {
    const started = Date.now();
    const child = spawn(process.execPath, [join(REPO, 'scripts/tofu-migrate.mjs')], {
      cwd,
      // Next.js's types make NODE_ENV required in ProcessEnv; the script's environment deliberately has only these.
      env: { PATH: process.env.PATH ?? '', ...env } as unknown as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => resolveRun({ code, stdout, stderr, ms: Date.now() - started }));
  });
}
