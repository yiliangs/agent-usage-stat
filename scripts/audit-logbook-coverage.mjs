#!/usr/bin/env node
/**
 * audit-logbook-coverage.mjs — find session transcripts on disk that have NO
 * row in logbook.csv, and classify why.
 *
 * reconcile-logbook.mjs corrects rows that already exist. This script answers
 * the complementary question: which *interactive, non-empty* sessions were
 * never logged at all? Those are true coverage gaps — a hook that didn't fire,
 * a worker that died before the logbook append, a session ended on a machine
 * that couldn't reach the Drive.
 *
 * For every <projectDir>/<sid>.jsonl main transcript not present in the
 * logbook, it reproduces the two skip gates the hook applies and buckets each:
 *   - sdk          intentionally skipped (non-interactive entrypoint)
 *   - zero-token   intentionally skipped (no usage signal)
 *   - MISSING      should have been logged but wasn't  <-- the finding
 *
 * Read-only. Prints a report; writes nothing.
 *
 * Usage:
 *   node scripts/audit-logbook-coverage.mjs
 *   node scripts/audit-logbook-coverage.mjs --logbook="D:/path/logbook.csv"
 *   node scripts/audit-logbook-coverage.mjs --all   # list every MISSING row, not just first 50
 */
import {
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const args = process.argv.slice(2);
const SHOW_ALL = args.includes("--all");
const home = process.env.USERPROFILE || process.env.HOME || "";

function defaultLogbook() {
  if (existsSync("H:/My Drive")) return "H:/My Drive/claude-receipts/logbook.csv";
  return join(home, ".claude-receipts", "projects", "logbook.csv");
}
const logArg = args.find((a) => a.startsWith("--logbook="));
const LOG = logArg ? logArg.slice("--logbook=".length) : defaultLogbook();
const projectsRoot = join(home, ".claude", "projects");

const calcPath = join(repoRoot, "dist", "core", "usage-calculator.js");
if (!existsSync(calcPath)) {
  console.error(`dist not built: ${calcPath}\nRun \`npm run build\` first.`);
  process.exit(1);
}
const { UsageCalculator } = await import(pathToFileURL(calcPath).href);

if (!existsSync(projectsRoot)) {
  console.error(`transcripts dir not found: ${projectsRoot}`);
  process.exit(1);
}

// --- logged session ids (3rd CSV column; never contains a comma) -----------
const logged = new Set();
let logbookRows = 0;
if (existsSync(LOG)) {
  const lines = readFileSync(LOG, "utf-8").split("\n");
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const sid = lines[i].split(",")[2];
    if (sid) logged.add(sid);
    logbookRows++;
  }
} else {
  console.error(`(logbook not found at ${LOG} — treating every session as unlogged)`);
}

// --- enumerate main transcripts: <projectDir>/<sid>.jsonl ------------------
// Keep the largest copy of any sid seen across project dirs (same dedupe the
// reconcile script uses; a session can appear under more than one cwd slug).
const projectDirs = readdirSync(projectsRoot);
const mains = new Map(); // sid -> { path, size, mtime }
for (const d of projectDirs) {
  const dir = join(projectsRoot, d);
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    continue;
  }
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const sid = name.slice(0, -".jsonl".length);
    const p = join(dir, name);
    let s;
    try {
      s = statSync(p);
    } catch {
      continue;
    }
    const prev = mains.get(sid);
    if (!prev || s.size > prev.size) {
      mains.set(sid, { path: p, size: s.size, mtime: s.mtime });
    }
  }
}

/** entrypoint from the 128 KB head of a transcript (mirror of detach-shim). */
function entrypointOf(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(131072);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const head = buf.toString("utf-8", 0, n);
    const m = /"entrypoint"\s*:\s*"([^"]+)"/.exec(head);
    return m ? m[1] : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

// --- classify the unlogged ones --------------------------------------------
const calc = new UsageCalculator();
const missing = [];
let sdkSkip = 0,
  zeroSkip = 0,
  loggedCount = 0;

for (const [sid, info] of mains) {
  if (logged.has(sid)) {
    loggedCount++;
    continue;
  }
  const entry = entrypointOf(info.path);
  if (entry && entry.startsWith("sdk")) {
    sdkSkip++;
    continue;
  }
  let r;
  try {
    r = await calc.calculate(info.path, sid);
  } catch {
    r = { totalTokens: 0, totalCost: 0 };
  }
  if (r.totalTokens <= 0) {
    zeroSkip++;
    continue;
  }
  missing.push({
    sid,
    path: info.path,
    project: dirname(info.path).split(/[\\/]/).pop(),
    mtime: info.mtime,
    tokens: r.totalTokens,
    cost: r.totalCost,
    entry: entry || "?",
  });
}

// --- report -----------------------------------------------------------------
console.log(`logbook:     ${LOG}  (${logbookRows} rows, ${logged.size} distinct session ids)`);
console.log(`transcripts: ${projectsRoot}  (${mains.size} distinct main transcripts)\n`);
console.log("coverage of on-disk transcripts:");
console.log(`  logged already:            ${loggedCount}`);
console.log(`  skipped — sdk/headless:    ${sdkSkip}`);
console.log(`  skipped — zero-token:      ${zeroSkip}`);
console.log(`  MISSING (should be logged):${String(missing.length).padStart(4)}`);

const onlyInLog = logged.size - loggedCount;
console.log(
  `\nlogbook rows with no transcript on disk (rotated away / other machine): ${onlyInLog}`,
);

if (missing.length) {
  missing.sort((a, b) => b.cost - a.cost);
  const shown = SHOW_ALL ? missing : missing.slice(0, 50);
  console.log(`\nMISSING sessions (by cost desc${SHOW_ALL ? "" : ", top 50"}):`);
  console.log("  sid       date        tokens        $      entry      project");
  let costSum = 0;
  for (const m of missing) costSum += m.cost;
  for (const m of shown) {
    const date = m.mtime.toISOString().slice(0, 10);
    console.log(
      `  ${m.sid.slice(0, 8)}  ${date}  ${String(m.tokens).padStart(10)}  ${m.cost
        .toFixed(2)
        .padStart(7)}  ${(m.entry || "?").padEnd(9)}  ${m.project}`,
    );
  }
  if (!SHOW_ALL && missing.length > shown.length) {
    console.log(`  ... and ${missing.length - shown.length} more (pass --all)`);
  }
  console.log(`\n  total unlogged cost: $${costSum.toFixed(2)} across ${missing.length} sessions`);
} else {
  console.log("\nNo missing interactive sessions — logbook coverage is complete.");
}
