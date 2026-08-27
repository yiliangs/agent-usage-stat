import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, relative, resolve, sep } from "node:path";
import test from "node:test";

/**
 * Static guards for the structural invariants in AGENTS.md.
 *
 * Each invariant here is checkable by reading the source tree, so it is
 * enforced rather than merely written down. The import-light invariant has
 * already regressed once (52d2c6d, #46), which is what these exist to prevent.
 *
 * Behavioral invariants (recomputation never lowering a record, per-line JSONL
 * isolation) need fixtures and are not here. Bracket-suffix normalization is
 * guarded structurally below and covered behaviorally by the provider suites.
 */

const root = process.cwd();
const sourceRoot = join(root, "src");

/** Strip comments so a guard matches code, not prose about the code. The
 *  line-comment pass deliberately spares `://` so URLs and `aus://` survive. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function sourceFiles(directory = sourceRoot) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (entry.name.endsWith(".ts")) found.push(path);
  }
  return found.sort();
}

function readCode(path) {
  return stripComments(readFileSync(path, "utf8"));
}

/** Every `import … from "x"` that survives compilation: type-only imports erase,
 *  and `await import()` is deferred, so neither weighs on a cold start. */
function staticImports(path) {
  const specifiers = [];
  const pattern = /import\s+(type\s+)?[\s\S]*?from\s*["']([^"']+)["']/g;
  for (const [, typeOnly, specifier] of readCode(path).matchAll(pattern)) {
    if (!typeOnly) specifiers.push(specifier);
  }
  return specifiers;
}

function resolveLocal(fromPath, specifier) {
  if (!specifier.startsWith(".")) return null;
  return resolve(dirname(fromPath), specifier.replace(/\.js$/, ".ts"));
}

function staticClosure(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.pop();
    for (const specifier of staticImports(current)) {
      const local = resolveLocal(current, specifier);
      if (!local || seen.has(local)) continue;
      seen.add(local);
      queue.push(local);
    }
  }
  return [...seen].map((path) => relative(root, path)).sort();
}

test("the hook entry path stays import-light", () => {
  // helper.ts is the standalone hook entry point: it runs on every SessionEnd,
  // so anything it pulls in statically is paid on every captured session. The
  // command modules are reached through `await import()` and must stay there.
  assert.deepEqual(staticClosure(join(sourceRoot, "helper.ts")), [
    join("src", "commands", "detach-shim.ts"),
    join("src", "utils", "capture-run.ts"),
    join("src", "utils", "hook-log.ts"),
    join("src", "utils", "paths.ts"),
  ]);
});

test("the detach shim reads a bounded head of a Claude transcript", () => {
  const shim = readCode(join(sourceRoot, "commands", "detach-shim.ts"));
  const allocations = [...shim.matchAll(/Buffer\.alloc\((\d+)\)/g)]
    .map(([, size]) => Number(size));

  assert.deepEqual(allocations, [128 * 1024]);
  // A bounded buffer only bounds the read if the read is capped by it.
  assert.match(shim, /readSync\(\s*fd,\s*buf,\s*0,\s*buf\.length,\s*0\s*\)/);
});

test("no code path reads or writes a CSV spend source", () => {
  const offenders = sourceFiles()
    .filter((path) => /\.csv\b/i.test(readCode(path)))
    .map((path) => relative(root, path));

  assert.deepEqual(offenders, []);
});

test("production opens no localhost server", () => {
  const forbidden = /createServer|\.listen\(|localhost|127\.0\.0\.1/;
  const offenders = sourceFiles()
    .filter((path) => forbidden.test(readCode(path)))
    .map((path) => relative(root, path));

  assert.deepEqual(offenders, []);
});

test("the logbook shard directory name has exactly one owner", () => {
  // Every consumer reaches the shards through LOGBOOK_SHARD_DIR and
  // resolveUsageRoot, so a redirected data root stays authoritative instead of
  // forking the ledger. A second spelling of the literal is how that forks.
  const owners = sourceFiles()
    .filter((path) => /["']logbook\.d["']/.test(readCode(path)))
    .map((path) => relative(root, path));

  assert.deepEqual(owners, [join("src", "core", "usage-ledger.ts")]);
});

test("project attribution has exactly one owner", () => {
  // The project a session belongs to used to be the last segment of its
  // working directory, derived once per provider. Four copies of that rule
  // meant a worktree layout none of them knew about (#64) mislabelled every
  // session in it. A second derivation is how that comes back.
  const derives = /["']worktrees["']|[Bb]asename\([^)]*cwd/;
  const owners = sourceFiles()
    .filter((path) => derives.test(readCode(path)))
    .map((path) => relative(root, path));

  assert.deepEqual(owners, [join("src", "core", "project-name.ts")]);
});

test("every provider pricing table normalizes through the shared model-id rule", () => {
  // Bracket suffixes are stripped in one place, src/core/model-id.ts, because
  // a table that re-derives the rule drops a clause: Codex kept only the date
  // strip (#101), so a context-routed rollout missed the lookup and billed at
  // $0. A provider may add its own naming pass, but it reaches the shared rule
  // either directly or through the sibling table that already does.
  const shared = /normalizeModelId[\s\S]*?from\s*["'](\.\.\/\.\.\/core\/model-id\.js|\.\.\/claude\/pricing\.js)["']/;
  const tables = sourceFiles(join(sourceRoot, "providers"))
    .filter((path) => path.endsWith(`${sep}pricing.ts`));
  const detached = tables
    .filter((path) => !shared.test(readCode(path)))
    .map((path) => relative(root, path));

  assert.ok(tables.length >= 4, "expected a pricing table per provider");
  assert.deepEqual(detached, []);
});
