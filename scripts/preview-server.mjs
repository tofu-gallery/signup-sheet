// @ts-check
// Starts one local preview server of the built app, `next start` on 127.0.0.1, with the database settings that
// scripts/preview-db.mjs saved (see TOFU.md, Local servers). Start it yourself, one per port; no test, check or other
// script runs it. The settings are read from the private env.json and never printed; the server gets only those, plus
// PORT and NODE_ENV=production.
//
//   node scripts/preview-server.mjs --env /tmp/ss-preview/env.json --port 3101
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @param {string} text
 * @returns {never}
 */
function fail(text) {
	console.error(`[preview-server] ${text}`);
	process.exit(1);
}

const args = process.argv.slice(2);
/** @param {string} name */
const value = (name) => {
	const index = args.indexOf(name);
	return index >= 0 ? (args[index + 1] ?? '') : '';
};
const envFile = resolve(value('--env') || '/tmp/ss-preview/env.json');
const port = Number(value('--port'));
if (!Number.isInteger(port) || port < 1024 || port > 65535) fail('--port must be a port from 1024 to 65535');
if (!existsSync(envFile)) fail('no env.json there: run node scripts/preview-db.mjs setup first');
const info = statSync(envFile);
if ((info.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
	fail('env.json must be this user\'s own, mode 600');
}
/** @type {{ DATABASE_URL?: unknown, ORGANIZER_PASSWORD?: unknown }} */
const saved = JSON.parse(readFileSync(envFile, 'utf8'));
const databaseUrl = typeof saved.DATABASE_URL === 'string' ? saved.DATABASE_URL : '';
// Only the local preview database: this launcher is never pointed at a real one.
if (!/^postgresql:\/\/[a-z_]+@127\.0\.0\.1:[0-9]{4,5}\/[a-z_]+(\?sslmode=disable)?$/.test(databaseUrl)) {
	fail('env.json does not name a local preview database');
}
if (!existsSync(join(REPO, '.next', 'BUILD_ID'))) fail('there is no build: run npm run build first');

/** @type {Record<string, string>} */
const env = {};
for (const [key, entry] of Object.entries(process.env)) {
	if (entry !== undefined && !['DATABASE_URL', 'ORGANIZER_PASSWORD', 'SUPABASE_CA_CERT', 'MAKE_ONE_URL'].includes(key)) env[key] = entry;
}
env.DATABASE_URL = databaseUrl;
if (typeof saved.ORGANIZER_PASSWORD === 'string' && saved.ORGANIZER_PASSWORD) env.ORGANIZER_PASSWORD = saved.ORGANIZER_PASSWORD;
env.NODE_ENV = 'production';
env.PORT = String(port);

const child = spawn(process.execPath, [join(REPO, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-p', String(port), '-H', '127.0.0.1'], {
	cwd: REPO,
	env: /** @type {NodeJS.ProcessEnv} */ (/** @type {unknown} */ (env)),
	stdio: 'inherit'
});
for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM', 'SIGHUP'])) {
	process.on(signal, () => child.kill(signal));
}
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
