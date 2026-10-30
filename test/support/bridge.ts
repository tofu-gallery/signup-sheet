// The live check against route handlers, with no server (see docs/verification.md). qa/live-check.py, started with
// SIGNUP_SHEET_LIVE_CHECK_PIPE=3,4, writes each request as one JSON line on its file descriptor 3 and reads the answer
// from 4. Each one is answered here by calling the route handler for its path directly, as every db test does, and the
// headers next.config.ts adds are added by the same rules. No socket listens and nothing starts Next.js: this proves what
// the live check reads, sends and decides against the real handlers and a real database. HTTP itself, Next.js's own
// routing, headers, 404 page and logs stay for a run against a running server.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import config from '../../next.config';
import { ORIGIN } from './core';
import { REPO } from './postgres';
import { type RouteLoader, routePaths } from './probes';

type Header = [string, string];
type Wire = { id: number; method: string; path: string; headers: Header[]; body: string };
type Route = { path: string; segments: string[] };

const DYNAMIC = /^\[(\w+)\]$/;

function routeTable(): Route[] {
  return routePaths().map((path) => ({ path, segments: path === '' ? [] : path.split('/') }));
}

/** Whether `a` ranks before `b` for the same address: a fixed segment before a dynamic one, where they first differ. */
function ranksBefore(a: Route, b: Route): boolean {
  for (let index = 0; index < a.segments.length; index += 1) {
    const aDynamic = DYNAMIC.test(a.segments[index]!);
    const bDynamic = DYNAMIC.test(b.segments[index]!);
    if (aDynamic !== bDynamic) return !aDynamic;
  }
  return false;
}

/** The route for a path, as the app's routes are laid out (no catch-all segments), with its parameters. */
export function matchRoute(table: Route[], pathname: string): { route: Route; params: Record<string, string> } | null {
  const parts = pathname.split('/').filter(Boolean).map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
  let best: { route: Route; params: Record<string, string> } | null = null;
  for (const route of table) {
    if (route.segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    const fits = route.segments.every((segment, index) => {
      const dynamic = DYNAMIC.exec(segment);
      if (dynamic) params[dynamic[1]!] = parts[index]!;
      return dynamic !== null || segment === parts[index];
    });
    if (fits && (!best || ranksBefore(route, best.route))) best = { route, params };
  }
  return best;
}

type Rule = { pattern: RegExp; headers: { key: string; value: string }[] };

/** next.config.ts's header rules. Its sources have two shapes: '/x', and '/x/:path*' for /x and all below it. */
async function headerRules(): Promise<Rule[]> {
  const rules = (await config.headers?.()) ?? [];
  return rules.map((rule) => {
    const escaped = rule.source.replace(/\/:path\*$/, '').replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    const pattern = rule.source.endsWith('/:path*') ? new RegExp(`^${escaped}(?:/.*)?$`) : new RegExp(`^${escaped}$`);
    return { pattern, headers: rule.headers };
  });
}

const PUBLIC_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

function publicFile(pathname: string): Response | null {
  if (!/^\/[a-z0-9.-]+$/.test(pathname)) return null;
  const file = join(REPO, 'public', pathname.slice(1));
  const type = PUBLIC_TYPES[extname(file)];
  return type && existsSync(file) ? new Response(readFileSync(file), { headers: { 'Content-Type': type } }) : null;
}

async function answer(load: RouteLoader, table: Route[], rules: Rule[], wire: Wire): Promise<{ status: number; headers: Header[]; body: string }> {
  const host = wire.headers.find(([key]) => key === 'host')?.[1] ?? new URL(ORIGIN).host;
  const url = new URL(wire.path, `http://${host}`);
  const match = matchRoute(table, url.pathname);
  let response: Response;
  if (match) {
    const handler = (await load(match.route.path))[wire.method as 'GET' | 'POST'];
    if (!handler) {
      response = new Response(null, { status: 405 });
    } else {
      const body = wire.method === 'GET' ? undefined : Buffer.from(wire.body, 'base64');
      response = await handler(new Request(url, { method: wire.method, headers: wire.headers, body }), { params: Promise.resolve(match.params) });
    }
  } else {
    response = publicFile(url.pathname) ?? new Response('Not found', { status: 404 });
  }
  const headers = new Headers();
  response.headers.forEach((value, key) => {
    if (key !== 'set-cookie') headers.set(key, value);
  });
  for (const rule of rules) {
    if (!rule.pattern.test(url.pathname)) continue;
    for (const { key, value } of rule.headers) if (!headers.has(key)) headers.set(key, value);
  }
  const pairs: Header[] = [];
  headers.forEach((value, key) => pairs.push([key, value]));
  for (const cookie of response.headers.getSetCookie()) pairs.push(['set-cookie', cookie]);
  return { status: response.status, headers: pairs, body: Buffer.from(await response.arrayBuffer()).toString('base64') };
}

export type CheckResult = { code: number | null; out: string; err: string };

/** Runs qa/live-check.py with `args` (after the address) against `load`'s route handlers through the pipes. */
export function runLiveCheck(load: RouteLoader, args: string[], env: Record<string, string> = {}): Promise<CheckResult> {
  return runScript(load, 'qa/live-check.py', [ORIGIN, ...args], env);
}

/**
 * Runs qa/local-http-check.py the same way. Its addresses all reach this one process: several "servers" here share one
 * pool and one module cache, so this exercises the suites, never several processes (that needs real servers).
 */
export function runLocalChecks(load: RouteLoader, args: string[], env: Record<string, string> = {}): Promise<CheckResult> {
  return runScript(load, 'qa/local-http-check.py', args, env);
}

async function runScript(load: RouteLoader, script: string, args: string[], env: Record<string, string>): Promise<CheckResult> {
  const table = routeTable();
  const rules = await headerRules();
  return new Promise((resolve) => {
    const child = spawn(process.env.SIGNUP_SHEET_PYTHON || 'python3', ['-I', join(REPO, script), ...args], {
      cwd: tmpdir(),
      // Next.js's types make NODE_ENV required in ProcessEnv; the check's environment deliberately has only these.
      env: { PATH: process.env.PATH ?? '', SIGNUP_SHEET_LIVE_CHECK_PIPE: '3,4', SIGNUP_SHEET_LIVE_CHECK_PACE_MS: '10', ...env } as unknown as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe']
    });
    const requests = child.stdio[3] as Readable;
    const answers = child.stdio[4] as Writable;
    // Once the check has ended, a late answer has nowhere to go.
    requests.on('error', () => {});
    answers.on('error', () => {});
    createInterface({ input: requests }).on('line', (line) => {
      const wire = JSON.parse(line) as Wire;
      answer(load, table, rules, wire)
        .catch(() => ({ status: 500, headers: [['x-bridge', 'the bridge failed to call the handler']] as Header[], body: '' }))
        .then((reply) => answers.write(`${JSON.stringify({ id: wire.id, ...reply })}\n`));
    });
    let out = '';
    let err = '';
    child.stdout!.on('data', (chunk) => (out += chunk));
    child.stderr!.on('data', (chunk) => (err += chunk));
    // No python3 (or SIGNUP_SHEET_PYTHON) on PATH: the check could not start, which the test reports.
    child.on('error', (error) => resolve({ code: null, out, err: `could not start the check: ${error.message}` }));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}
