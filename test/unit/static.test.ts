// Rules checked by reading the source: every POST is guarded, every page and route is dynamic, user text is never
// HTML, and nothing TOFU.md rules out exists (server actions, middleware or proxy, next/image). A new page or route
// falls under the same walk.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '../..');
const APP = join(ROOT, 'src/app');

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]
  );
}

const source = files(join(ROOT, 'src')).filter((file) => /\.(ts|tsx)$/.test(file));
const routes = source.filter((file) => file.startsWith(APP) && /\/route\.ts$/.test(file));
const pages = source.filter((file) => file.startsWith(APP) && /\/(page|layout)\.tsx$/.test(file));

test('every exported POST is guarded(…)', () => {
  for (const file of routes) {
    const text = readFileSync(file, 'utf8');
    assert.ok(!/export\s+(async\s+)?function\s+POST\b/.test(text), `${relative(ROOT, file)}: POST must be guarded(...)`);
    for (const match of text.matchAll(/export\s+const\s+POST\s*=\s*([^\n]*)/g)) {
      assert.match(match[1]!, /^guarded\(/, relative(ROOT, file));
    }
    assert.ok(!/export\s+(const|async\s+function|function)\s+(PUT|PATCH|DELETE)\b/.test(text), `${relative(ROOT, file)}: writes are POST only`);
  }
});

test('every page and route is dynamic', () => {
  assert.ok(routes.length > 0 && pages.length > 0);
  for (const file of [...routes, ...pages]) {
    assert.match(readFileSync(file, 'utf8'), /export const dynamic = 'force-dynamic';/, relative(ROOT, file));
  }
});

test('no HTML from user text, no server actions, no middleware or proxy, no next/image, no static params, no test hooks', () => {
  for (const file of source.concat(files(join(ROOT, 'scripts')))) {
    const text = readFileSync(file, 'utf8');
    const name = relative(ROOT, file);
    // The pauses and failures only changed copies in the tests call (test/support/core.ts).
    assert.ok(!text.includes('__signupSheet'), `${name}: a test hook`);
    assert.ok(!text.includes('dangerouslySetInnerHTML'), name);
    assert.ok(!/['"]use server['"]/.test(text), name);
    assert.ok(!/['"]use cache['"]/.test(text), name);
    assert.ok(!text.includes('next/image'), name);
    assert.ok(!text.includes('generateStaticParams'), name);
  }
  for (const name of ['middleware.ts', 'proxy.ts', 'src/middleware.ts', 'src/proxy.ts']) {
    assert.equal(existsSync(join(ROOT, name)), false, name);
  }
});

test('T36, its static half: every organizer route checks the organizer first; only the access routes do not; no route queries itself', () => {
  const access = ['organizer/setup', 'organizer/sign-in', 'organizer/sign-out', 'organizer/give-up'];
  const organizerRoutes = routes.filter((file) => relative(APP, file).startsWith('organizer/'));
  assert.ok(organizerRoutes.length > access.length);
  for (const file of organizerRoutes) {
    const path = relative(APP, file).replace(/\/route\.ts$/, '');
    if (access.includes(path)) continue;
    // organizerPost and organizerGet (routes.ts) call requireOrganizer before any other query.
    assert.match(readFileSync(file, 'utf8'), /\b(organizerPost|organizerGet|requireOrganizer)\(/, path);
  }
  // Every query is in src/lib, behind those checks: a route file never runs one of its own.
  for (const file of routes) assert.ok(!/\.query\(/.test(readFileSync(file, 'utf8')), relative(ROOT, file));
});

test('queries are never named, and nothing is set for a session (the transaction pooler)', () => {
  for (const file of source.concat([join(ROOT, 'scripts/tofu-migrate.mjs')])) {
    const text = readFileSync(file, 'utf8');
    const name = relative(ROOT, file);
    assert.ok(!/query\(\s*\{[^}]*\bname\s*:/.test(text), `${name}: a named query`);
    assert.ok(!/\bpg_advisory_(un)?lock(_shared)?\s*\(/.test(text), `${name}: a session advisory lock`);
    // A SET statement starts right after a quote or a semicolon; only SET LOCAL may appear.
    assert.ok(!/['"`;]\s*set\s+(session\s+)?(?!local\b)[a-z_.]+\s*(=|to)\s/i.test(text), `${name}: a session SET`);
    assert.ok(!/['"`;]\s*listen\s+\w/i.test(text), `${name}: LISTEN`);
    assert.ok(!/create\s+temp(orary)?\s+table/i.test(text), `${name}: a temporary table`);
  }
});
