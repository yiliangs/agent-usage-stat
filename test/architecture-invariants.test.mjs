import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { isBuiltin } from "node:module";
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

/**
 * Every tree these invariants govern.
 *
 * `src/` is the application. `scripts/` and `portal/scripts/` are the tooling
 * that reads and writes the same ledger from a checkout, and they were outside
 * every guard here: the comments claimed "every consumer" while the walk saw
 * only compiled TypeScript, which is how a second spelling of the shard
 * directory and a hardcoded drive path both survived (#111).
 *
 * The extensions are the two this repository authors Node code in. The `.js`
 * files beside the `.mjs` ones under `scripts/` are probe bodies evaluated
 * inside a rendered page, where none of these invariants apply.
 */
const SOURCE_ROOTS = [
  sourceRoot,
  join(root, "scripts"),
  join(root, "portal", "scripts"),
];

/** Strip comments so a guard matches code, not prose about the code. The
 *  line-comment pass deliberately spares `://` so URLs and `aus://` survive. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function filesUnder(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(path));
    else if (/\.(ts|mjs)$/.test(entry.name)) found.push(path);
  }
  return found;
}

/** The files a guard reads: every governed tree, or only the ones it names.
 *  A guard names a narrower root when its subject is narrower than the
 *  repository, and says so where it does. */
function sourceFiles(...roots) {
  return (roots.length > 0 ? roots : SOURCE_ROOTS).flatMap(filesUnder).sort();
}

function readCode(path) {
  return stripComments(readFileSync(path, "utf8"));
}

/** Every specifier that survives compilation as a static dependency: the
 *  `import … from` and `export … from` bindings plus the bare `import "x"`
 *  side-effect form. Type-only imports erase and `await import()` is deferred,
 *  so neither weighs on a cold start. The clause between the keyword and `from`
 *  is matched narrowly, by the characters an import clause can hold, so a later
 *  `export` of a function or a type cannot swallow the import that follows it. */
function staticImports(path) {
  const specifiers = [];
  const pattern =
    /import\s*["']([^"']+)["']|\b(?:import|export)\s+(type\s+)?[\w\s{},*$]*?from\s*["']([^"']+)["']/g;
  for (const [, sideEffect, typeOnly, bound] of readCode(path).matchAll(pattern)) {
    if (sideEffect) specifiers.push(sideEffect);
    else if (!typeOnly) specifiers.push(bound);
  }
  return specifiers;
}

/**
 * Walk the static graph from `entry` and report what it reaches: the local
 * modules, and the third-party packages that hang off any of them.
 *
 * The walk once resolved only relative specifiers and dropped everything else
 * on the floor, which made the import-light guard blind to the one regression
 * shape it exists to catch (#137): a `chalk` or `ora` in the shim changes no
 * local module, so the closure stayed exactly as asserted while cold-start cost
 * arrived anyway. A bare specifier is now classified rather than discarded: a
 * Node built-in in either spelling is free, anything else is a package.
 */
function staticClosure(entry) {
  const modules = new Set();
  const packages = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.pop();
    for (const specifier of staticImports(current)) {
      if (!specifier.startsWith(".")) {
        if (!isBuiltin(specifier)) {
          packages.add(`${relative(root, current)} imports "${specifier}"`);
        }
        continue;
      }
      const local = resolve(dirname(current), specifier.replace(/\.js$/, ".ts"));
      if (modules.has(local)) continue;
      modules.add(local);
      queue.push(local);
    }
  }
  return {
    modules: [...modules].map((path) => relative(root, path)).sort(),
    packages: [...packages].sort(),
  };
}

test("the hook entry path stays import-light", () => {
  // helper.ts is the standalone hook entry point: it runs on every SessionEnd,
  // so anything it pulls in statically is paid on every captured session. The
  // command modules are reached through `await import()` and must stay there.
  const closure = staticClosure(join(sourceRoot, "helper.ts"));

  // Node built-ins are already in the process; a package is the weight the
  // invariant is about, so the entry path may reach none of them at any depth.
  assert.deepEqual(
    closure.packages,
    [],
    `the import-light entry path reached third-party packages: ${closure.packages.join("; ")}`,
  );
  assert.deepEqual(closure.modules, [
    join("src", "commands", "detach-shim.ts"),
    join("src", "utils", "atomic-file.ts"),
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
  // logbook.d/ is the only spend source. Two files still name the retired CSV,
  // and both exist to keep it retired rather than to read it: the one-shot
  // that folded the legacy file into the shards, and the health check that
  // reports one reappearing beside them. They are named here so a third file
  // learning to read a CSV is a failure rather than a silent second source.
  const RETIRING_THE_CSV = [
    join("scripts", "health-check.mjs"),
    join("scripts", "migrate-csv-to-shards.mjs"),
  ];

  const offenders = sourceFiles()
    .filter((path) => /\.csv\b/i.test(readCode(path)))
    .map((path) => relative(root, path));

  assert.deepEqual(offenders, RETIRING_THE_CSV);
});

test("production opens no localhost server", () => {
  // Only the application ships, so only the application is bound by this: the
  // renderer reaches main through `aus://` instead of a port. The repository's
  // own tooling is not production and one piece of it must serve over
  // loopback, since the layout guards render the built portal in headless
  // Chrome, which loads a page over HTTP or not at all.
  const forbidden = /createServer|\.listen\(|localhost|127\.0\.0\.1/;
  const offenders = sourceFiles(sourceRoot)
    .filter((path) => forbidden.test(readCode(path)))
    .map((path) => relative(root, path));

  assert.deepEqual(offenders, []);
});

test("every renderer window is sandboxed and none is given a bridge into main", () => {
  // The renderer draws transcript-derived strings, and `aus://` is the only
  // channel it has back into the application. contextIsolation, a disabled
  // node integration, and the sandbox are what keep it the only one; a preload
  // script or an ipcMain handler is a second one, opened for every window at
  // once. The dashboard and the status-area glance both go through here.
  const windows = sourceFiles()
    .filter((path) => /new BrowserWindow\(/.test(readCode(path)));

  assert.ok(windows.length >= 2, "expected the dashboard and the glance panel");
  for (const path of windows) {
    const code = readCode(path);
    const name = relative(root, path);
    const declared = [...code.matchAll(/new BrowserWindow\(/g)].length;
    const preferences = [...code.matchAll(/webPreferences: \{[\s\S]*?\}/g)];

    assert.equal(preferences.length, declared, `${name} opens a window without webPreferences`);
    for (const [block] of preferences) {
      assert.match(block, /contextIsolation: true/, name);
      assert.match(block, /nodeIntegration: false/, name);
      assert.match(block, /sandbox: true/, name);
    }
  }

  const offenders = sourceFiles()
    .filter((path) => /\bipcMain\b|\bpreload\b|\bwebSecurity\b/.test(readCode(path)))
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

test("the logbook shard filename has exactly one owner", () => {
  // Naming a file inside the shard directory is `shardPathFor`'s job alone,
  // because the name is the session id with every character a filename cannot
  // hold replaced. Sync spelled that path itself without the substitution, so
  // an id carrying `:` or `/` made its existence check false forever and every
  // run recomputed the session (#87). Appending a segment to the directory
  // constant is how that second spelling comes back.
  const namesAFile = /\b(?:join|resolve)\([^()]*LOGBOOK_SHARD_DIR\s*,/;
  const owners = sourceFiles()
    .filter((path) => namesAFile.test(readCode(path)))
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
