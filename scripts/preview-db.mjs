// @ts-check
// A throwaway local database for this app's preview servers (see TOFU.md, Local servers). Nothing here starts the app:
// you start `next start` yourself with scripts/preview-server.mjs, which reads the settings this saves. Like the tests'
// clusters, the database has Supabase's old default grants, and the schema is made by the app's own migrate script.
//
//   node scripts/preview-db.mjs setup [--dir /tmp/ss-preview] [--port 54390]   a new cluster, migrated, and env.json
//   node scripts/preview-db.mjs reset [--dir …]      the database made again from nothing (setup open again)
//   node scripts/preview-db.mjs password --on|--off [--dir …]  a local ORGANIZER_PASSWORD in env.json and qa-pw
//   node scripts/preview-db.mjs status [--dir …]
//   node scripts/preview-db.mjs stop [--remove] [--dir …]
//
// Everything lives in the one directory, marked as this script's own; a directory without the mark is never touched,
// and only the postgres process whose command line names this directory is ever stopped. The database listens on
// 127.0.0.1 only, with no password (trust): it holds only made-up local data. env.json and qa-pw are mode 600 and are
// never printed.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MARK = '.signup-sheet-preview';
const DATABASE = 'signup_sheet';
const PORTS = [54390, 54391, 54392, 54393, 54394, 54395, 54396, 54397, 54398, 54399];
const OLD_DEFAULTS = [
	'alter schema public owner to app_owner',
	'grant usage on schema public to anon, authenticated',
	'alter default privileges for role app_owner in schema public grant all on tables to anon, authenticated',
	'alter default privileges for role app_owner in schema public grant all on sequences to anon, authenticated',
	'alter default privileges for role app_owner in schema public grant execute on functions to anon, authenticated'
];

/**
 * @param {string} text
 * @returns {never}
 */
function fail(text) {
	console.error(`[preview-db] ${text}`);
	process.exit(1);
}

/** @param {string} text */
function say(text) {
	console.log(`[preview-db] ${text}`);
}

/** @param {string[]} argv */
function options(argv) {
	/** @type {{ command: string, dir: string, port: number | null, on: boolean, off: boolean, remove: boolean }} */
	const parsed = { command: argv[0] ?? '', dir: '/tmp/ss-preview', port: null, on: false, off: false, remove: false };
	for (let index = 1; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--dir') parsed.dir = resolve(argv[++index] ?? '');
		else if (arg === '--port') parsed.port = Number(argv[++index]);
		else if (arg === '--on') parsed.on = true;
		else if (arg === '--off') parsed.off = true;
		else if (arg === '--remove') parsed.remove = true;
		else fail(`unknown option ${arg}`);
	}
	if (parsed.port !== null && !PORTS.includes(parsed.port)) fail(`--port must be one of ${PORTS[0]}–${PORTS.at(-1)}`);
	return parsed;
}

/** @param {'initdb' | 'pg_ctl'} name */
function pgBinary(name) {
	const dirs = [process.env.SIGNUP_SHEET_PG_BIN, '/opt/homebrew/opt/postgresql@14/bin', ...(process.env.PATH ?? '').split(delimiter)];
	for (const dir of dirs) if (dir && existsSync(join(dir, name))) return join(dir, name);
	return fail(`${name} not found: install PostgreSQL 14 or set SIGNUP_SHEET_PG_BIN`);
}

/**
 * @param {string} command
 * @param {string[]} args
 */
function run(command, args) {
	const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
	if (result.status !== 0) fail(`${command.split('/').at(-1)} ${args[0] ?? ''} failed: ${(result.stderr || result.stdout || '').slice(-1500)}`);
}

/** @param {number} port */
function portFree(port) {
	return new Promise((resolvePort) => {
		const server = createServer();
		server.once('error', () => resolvePort(false));
		server.listen(port, '127.0.0.1', () => server.close(() => resolvePort(true)));
	});
}

/** @param {string} dir */
function owned(dir) {
	return existsSync(join(dir, MARK));
}

/** @param {string} dir */
function readMeta(dir) {
	if (!owned(dir)) fail(`${dir} is not a preview database made by this script; nothing was touched`);
	return /** @type {{ port: number }} */ (JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')));
}

/** The postmaster's pid, when one runs from this directory's data (its command line names the directory). */
function postmaster(/** @type {string} */ dir) {
	const pidFile = join(dir, 'data', 'postmaster.pid');
	if (!existsSync(pidFile)) return null;
	const pid = Number(readFileSync(pidFile, 'utf8').split('\n')[0]);
	const ps = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
	return ps.status === 0 && ps.stdout.includes(join(dir, 'data')) ? pid : null;
}

/**
 * @param {number} port
 * @param {string} user
 * @param {string} database
 */
function url(port, user, database) {
	return `postgresql://${user}@127.0.0.1:${port}/${database}?sslmode=disable`;
}

/**
 * @param {number} port
 * @param {string[]} statements
 * @param {string} database
 */
async function admin(port, statements, database = 'postgres') {
	const client = new pg.Client({ connectionString: `postgresql://postgres@127.0.0.1:${port}/${database}` });
	await client.connect();
	try {
		for (const statement of statements) await client.query(statement);
	} finally {
		await client.end();
	}
}

/** A file only this user can read: env.json, qa-pw. */
function writePrivate(/** @type {string} */ file, /** @type {string} */ text) {
	writeFileSync(file, text, { mode: 0o600 });
	spawnSync('chmod', ['600', file]);
}

/** @param {string} dir */
function readEnv(dir) {
	return /** @type {{ DATABASE_URL: string, ORGANIZER_PASSWORD: string }} */ (JSON.parse(readFileSync(join(dir, 'env.json'), 'utf8')));
}

/** @param {number} port */
function migrate(port) {
	const result = spawnSync(process.execPath, [join(REPO, 'scripts/tofu-migrate.mjs')], {
		cwd: REPO,
		// Only these two: Next.js's types would ask for NODE_ENV, which the migrate script does not read.
		env: /** @type {NodeJS.ProcessEnv} */ (/** @type {unknown} */ ({ PATH: process.env.PATH ?? '', DATABASE_URL: url(port, 'app_owner', DATABASE) })),
		encoding: 'utf8',
		timeout: 120_000
	});
	for (const line of `${result.stdout}${result.stderr}`.split('\n')) if (line.startsWith('[tofu-migrate]')) say(line);
	if (result.status !== 0) fail('the migration failed');
}

/** The database made again from the template with the old grants, and migrated: a copy nobody has set up. */
async function freshDatabase(/** @type {number} */ port) {
	await admin(port, [`drop database if exists ${DATABASE} with (force)`, `create database ${DATABASE} template base owner app_owner`]);
	migrate(port);
}

async function setup(/** @type {ReturnType<typeof options>} */ opts) {
	const { dir } = opts;
	if (existsSync(dir)) fail(`${dir} exists already: use reset, or stop --remove it first`);
	mkdirSync(dir, { mode: 0o700, recursive: true });
	writeFileSync(join(dir, MARK), 'Made by scripts/preview-db.mjs; holds only made-up local data.\n');
	run(pgBinary('initdb'), ['-D', join(dir, 'data'), '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--no-locale', '--no-sync']);
	let port = opts.port;
	if (port === null) {
		for (const candidate of PORTS) {
			if (await portFree(candidate)) {
				port = candidate;
				break;
			}
		}
	} else if (!(await portFree(port))) {
		fail(`port ${port} is taken`);
	}
	if (port === null) fail(`no free port in ${PORTS[0]}–${PORTS.at(-1)}`);
	const conf = [`port = ${port}`, "listen_addresses = '127.0.0.1'", "unix_socket_directories = ''", 'fsync = off', 'synchronous_commit = off', 'max_connections = 60'];
	appendFileSync(join(dir, 'data', 'postgresql.conf'), `\n${conf.join('\n')}\n`);
	writeFileSync(join(dir, 'data', 'pg_hba.conf'), 'host all all 127.0.0.1/32 trust\n');
	writeFileSync(join(dir, 'meta.json'), `${JSON.stringify({ port, created: new Date().toISOString() })}\n`);
	run(pgBinary('pg_ctl'), ['-D', join(dir, 'data'), '-l', join(dir, 'postgres.log'), '-w', '-t', '60', 'start']);
	await admin(Number(port), ['create role app_owner login', 'create role anon nologin', 'create role authenticated nologin', 'create database base owner app_owner']);
	await admin(Number(port), OLD_DEFAULTS, 'base');
	await freshDatabase(Number(port));
	writePrivate(join(dir, 'env.json'), `${JSON.stringify({ DATABASE_URL: url(Number(port), 'app_owner', DATABASE), ORGANIZER_PASSWORD: '' }, null, 2)}\n`);
	say(`ready in ${dir} on 127.0.0.1:${port}; the servers' settings are in ${join(dir, 'env.json')} (mode 600, not printed)`);
}

async function reset(/** @type {ReturnType<typeof options>} */ opts) {
	const { port } = readMeta(opts.dir);
	if (!postmaster(opts.dir)) fail('the cluster is not running: setup again, or start it with its own pg_ctl');
	await freshDatabase(port);
	const env = readEnv(opts.dir);
	writePrivate(join(opts.dir, 'env.json'), `${JSON.stringify({ ...env, ORGANIZER_PASSWORD: '' }, null, 2)}\n`);
	rmSync(join(opts.dir, 'qa-pw'), { force: true });
	say(`the database is new again (setup open, no password). Running servers reconnect on their next request, which may answer 503 once${env.ORGANIZER_PASSWORD ? '; they still have the old password: restart them' : ''}.`);
}

function password(/** @type {ReturnType<typeof options>} */ opts) {
	readMeta(opts.dir);
	if (opts.on === opts.off) fail('say --on or --off');
	const env = readEnv(opts.dir);
	const value = opts.on ? `local-${randomBytes(18).toString('base64url')}` : '';
	writePrivate(join(opts.dir, 'env.json'), `${JSON.stringify({ ...env, ORGANIZER_PASSWORD: value }, null, 2)}\n`);
	if (value) writePrivate(join(opts.dir, 'qa-pw'), `${value}\n`);
	else rmSync(join(opts.dir, 'qa-pw'), { force: true });
	say(`ORGANIZER_PASSWORD is ${value ? `set (for --mode password: --qa-pw-file ${join(opts.dir, 'qa-pw')})` : 'removed'}. Restart the servers: that is the redeploy.`);
}

function status(/** @type {ReturnType<typeof options>} */ opts) {
	const { port } = readMeta(opts.dir);
	const pid = postmaster(opts.dir);
	const env = readEnv(opts.dir);
	const mode = (statSync(join(opts.dir, 'env.json')).mode & 0o777).toString(8);
	say(`${pid ? `running (pid ${pid})` : 'stopped'} on 127.0.0.1:${port}; env.json mode ${mode}; password ${env.ORGANIZER_PASSWORD ? 'on' : 'off'}`);
}

function stop(/** @type {ReturnType<typeof options>} */ opts) {
	readMeta(opts.dir);
	if (postmaster(opts.dir)) run(pgBinary('pg_ctl'), ['-D', join(opts.dir, 'data'), '-m', 'fast', '-w', '-t', '60', 'stop']);
	if (opts.remove) {
		rmSync(opts.dir, { recursive: true, force: true });
		say(`stopped and removed ${opts.dir}`);
	} else {
		say(`stopped; ${opts.dir} is kept (stop --remove deletes it)`);
	}
}

const opts = options(process.argv.slice(2));
switch (opts.command) {
	case 'setup':
		await setup(opts);
		break;
	case 'reset':
		await reset(opts);
		break;
	case 'password':
		password(opts);
		break;
	case 'status':
		status(opts);
		break;
	case 'stop':
		stop(opts);
		break;
	default:
		fail('say setup, reset, password --on|--off, status or stop [--remove]');
}
