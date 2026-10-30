// @ts-check
// Applies supabase/migrations at the start of the build (see TOFU.md, Database). A port of tofu-gallery/cactoide's
// scripts/tofu-migrate.mjs (c14bc53) from postgres.js to node-postgres, with the same behaviour.
//
// Each file the database's migration ledger does not record yet (the Supabase CLI's own
// supabase_migrations.schema_migrations, created the way Tofu creates it) is applied in file-name order, whole, in one
// transaction with its ledger row, so neither this script, Tofu nor the Supabase CLI ever runs a file twice. Two builds
// of one copy can run at the same time (a deploy started while the one before it still builds), so every transaction
// here first takes one advisory transaction lock: one build at a time creates the ledger or applies a file, and the
// other waits, then reads the ledger again and finds the file recorded. Without DATABASE_URL it applies nothing. Its
// queries are unnamed and it sets nothing for the session, as Tofu's transaction pooler requires.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { connectionSettings, DatabaseConfigError } from './tofu-database.mjs';

// A transaction-level lock: the pooler keeps a transaction on one server connection from its BEGIN to its end, and
// PostgreSQL lets go of the lock when the transaction ends, however the build ends.
const LOCK_KEY = 'scripts/tofu-migrate.mjs';
// The wait for the lock is bounded. statement_timeout is set above that bound for the wait, so a limit set for the
// database or the role (Supabase's two-minute default) cannot end it first with a less clear error; once the lock is
// held, both go back to their defaults for the rest of the transaction.
const LOCK_WAIT = '120s';
const LOCK_STATEMENT_LIMIT = '150s';
// The client's own deadline for one reply. It is longer than the lock wait and any statement here, so it never cuts a
// migration short; the app's 15-second deadline (src/lib/db.ts) does not apply to this script.
const REPLY_DEADLINE_MS = 10 * 60 * 1000;

if (!process.env.DATABASE_URL?.trim()) {
	console.log('[tofu-migrate] DATABASE_URL is not set; nothing to apply.');
	process.exit(0);
}

const directory = join(process.cwd(), 'supabase', 'migrations');

/** @type {pg.Client | undefined} */
let client;
/** @type {unknown} */
let failure;
/**
 * The file being applied, named if it fails.
 * @type {string | undefined}
 */
let applying;

/** @param {pg.Client} db */
async function takeLock(db) {
	await db.query(`set local lock_timeout = '${LOCK_WAIT}'; set local statement_timeout = '${LOCK_STATEMENT_LIMIT}'`);
	try {
		await db.query('select pg_advisory_xact_lock(hashtext($1))', [LOCK_KEY]);
	} catch (error) {
		if (error instanceof pg.DatabaseError && error.code === '55P03') {
			throw new Error(
				`the migration lock was still held by another session after ${LOCK_WAIT} (most likely another build of this app, applying migrations), so this build stops. Deploy again once that build has finished.`
			);
		}
		throw error;
	}
	await db.query('set local lock_timeout to default; set local statement_timeout to default');
}

/**
 * Runs `work` in one transaction that first takes the migration lock.
 * @template T
 * @param {pg.Client} db
 * @param {() => Promise<T>} work
 * @returns {Promise<T>}
 */
async function locked(db, work) {
	await db.query('begin');
	try {
		await takeLock(db);
		const result = await work();
		await db.query('commit');
		return result;
	} catch (error) {
		await db.query('rollback').catch(() => {});
		throw error;
	}
}

try {
	const files = readdirSync(directory)
		.filter((name) => /^[0-9]+_[^/]*\.sql$/.test(name))
		.sort();

	// Made inside this try, so that an error from reading the settings is printed as a message alone as well.
	const db = new pg.Client({
		...connectionSettings(process.env),
		connectionTimeoutMillis: 30_000,
		query_timeout: REPLY_DEADLINE_MS
	});
	client = db;
	// A connection lost while idle is reported here instead of crashing the process with the error object.
	db.on('error', (error) => {
		failure ??= error;
	});
	await db.connect();

	const recorded = await locked(db, async () => {
		await db.query('create schema if not exists supabase_migrations');
		await db.query('create table if not exists supabase_migrations.schema_migrations (version text not null primary key)');
		await db.query(
			'alter table supabase_migrations.schema_migrations add column if not exists statements text[], add column if not exists name text, add column if not exists created_by text'
		);
		const { rows } = await db.query('select version from supabase_migrations.schema_migrations');
		return new Set(rows.map((row) => row.version));
	});
	let applied = 0;

	for (const file of files) {
		const [, version, name] = /** @type {RegExpExecArray} */ (/^([0-9]+)_(.*)\.sql$/.exec(file));
		if (recorded.has(version)) continue;

		const text = readFileSync(join(directory, file), 'utf8');
		applying = file;
		const appliedHere = await locked(db, async () => {
			// Read again under the lock: a build that held it first may have applied the file while this one waited.
			const { rows } = await db.query('select version from supabase_migrations.schema_migrations where version = $1', [
				version
			]);
			if (rows.length > 0) return false;
			// The file whole, as one simple-protocol query (it holds several statements), then its ledger row.
			await db.query(text);
			await db.query('insert into supabase_migrations.schema_migrations (version, name) values ($1, $2)', [version, name]);
			return true;
		});
		applying = undefined;

		if (appliedHere) {
			applied += 1;
			console.log(`[tofu-migrate] applied ${file}`);
		} else {
			console.log(`[tofu-migrate] ${file} was applied by another build while this one waited`);
		}
	}

	console.log(`[tofu-migrate] ${applied} applied, ${files.length - applied} already recorded, ${files.length} files.`);
} catch (error) {
	failure = error;
}

if (failure) {
	// One line (see describe), then exit as soon as it is written. PostgreSQL rolls back a transaction whose connection
	// goes away, and the lock goes with it.
	process.stderr.write(`[tofu-migrate] ${describe(failure)}\n`, () => process.exit(1));
} else {
	// Close the connection, waiting at most 5 s for the server to close its end, then exit once the output is written.
	await Promise.race([client?.end(), new Promise((resolve) => setTimeout(resolve, 5_000).unref())]);
	process.stdout.write('', () => process.exit(0));
}

/**
 * A failure in one line, never an error object (a connection error's can carry the URL, and with it the password). A
 * database error is named by the file, its SQLSTATE and the objects it names. PostgreSQL's own message is added only for
 * syntax and catalog errors (classes 42 and 0A), which quote the migration's text: any other can quote a row's values,
 * as `invalid input syntax for type integer: "<a member's name>"` does.
 * @param {unknown} error
 */
function describe(error) {
	if (error instanceof DatabaseConfigError) return error.message;
	const where = applying ? `${applying} ` : '';
	if (error instanceof pg.DatabaseError) {
		const code = error.code ?? 'unknown';
		const named = [
			['constraint', error.constraint],
			['table', error.table],
			['column', error.column],
			['at character', error.position]
		]
			.filter(([, value]) => value)
			.map(([label, value]) => `, ${label} ${value}`)
			.join('');
		const message = /^(42|0A)/.test(code) ? `: ${error.message}` : '';
		return `${where}failed: SQLSTATE ${code}${named}${message}`;
	}
	return `${where}failed: ${error instanceof Error ? error.message : 'unknown error'}`;
}
