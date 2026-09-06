#!/usr/bin/env node
/**
 * backfill-logbook.mjs — write logbook rows for interactive, non-empty
 * sessions whose transcript is still on disk but which never got logged
 * (the "MISSING" bucket from audit-logbook-coverage.mjs).
 *
 * It reconstructs each row through the SAME compiled LogbookWriter the hook
 * uses, so column order, escaping, and the per-session de-dupe are identical to
 * a live append. Usage and cost come from the current subagent-aware
 * UsageCalculator; metadata (slug, timestamps, branch, cwd, project) from
 * TranscriptParser. Two fields can't be recovered after the fact:
 *   - location  left blank (IP geolocation now would record TODAY's location,
 *               not where the session actually ran — a blank is honest)
 *   - machine   stamped as THIS host by LogbookWriter; correct when you run the
 *               backfill on the same machine the sessions ran on
 *
 * Skips sdk/headless and zero-token transcripts exactly like the hook, and
 * skips any sid already in the logbook — so it is idempotent and safe to re-run.
 *
 * Prereq: `npm run build`.
 *
 * Usage:
 *   node scripts/backfill-logbook.mjs            # dry run — lists what it would add
 *   node scripts/backfill-logbook.mjs --apply    # writes, after a timestamped .bak
 *   node scripts/backfill-logbook.mjs --logbook="D:/path/logbook.csv"
 */
import {
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  copyFileSync,
} from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const home = process.env.USERPROFILE || process.env.HOME || "";

function defaultLogbook() {
  if (existsSync("H:/My Drive")) return "H:/My Drive/claude-receipts/logbook.csv";
  return join(home, ".claude-receipts", "projects", "logbook.csv");
}
const logArg = args.find((a) => a.startsWith("--logbook="));
const LOG = logArg ? logArg.slice("--logbook=".length) : defaultLogbook();
const root = dirname(LOG); // LogbookWriter.append joins root + "logbook.csv"
const projectsRoot = join(home, ".claude", "projects");

const distUrl = (rel) => pathToFileURL(join(repoRoot, "dist", rel)).href;
for (const rel of [
  "core/usage-calculator.js",
  "core/transcript-parser.js",
  "core/logbook-writer.js",
]) {
  if (!existsSync(join(repoRoot, "dist", rel))) {
    console.error(`dist not built: dist/${rel}\nRun \`npm run build\` first.`);
    process.exit(1);
  }
}
const { UsageCalculator } = await import(distUrl("core/usage-calculator.js"));
const { TranscriptParser } = await import(distUrl("core/transcript-parser.js"));
const { LogbookWriter } = await import(distUrl("core/logbook-writer.js"));

if (!existsSync(projectsRoot)) {
  console.error(`transcripts dir not found: ${projectsRoot}`);
  process.exit(1);
}

// --- logged session ids -----------------------------------------------------
const logged = new Set();
if (existsSync(LOG)) {
  const lines = readFileSync(LOG, "utf-8").split("\n");
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const sid = lines[i].split(",")[2];
    if (sid) logged.add(sid);
  }
}

// --- enumerate main transcripts (largest copy per sid) ----------------------
const projectDirs = readdirSync(projectsRoot);
const mains = new Map();
for (const d of projectDirs) {
  let entries;
  try {
    entries = readdirSync(join(projectsRoot, d));
  } catch {
    continue;
  }
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const sid = name.slice(0, -".jsonl".length);
    const p = join(projectsRoot, d, name);
    let s;
    try {
      s = statSync(p);
    } catch {
      continue;
    }
    const prev = mains.get(sid);
    if (!prev || s.size > prev.size) mains.set(sid, { path: p, size: s.size });
  }
}

function entrypointOf(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(131072);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const m = /"entrypoint"\s*:\s*"([^"]+)"/.exec(buf.toString("utf-8", 0, n));
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

// --- find + reconstruct MISSING rows ---------------------------------------
const calc = new UsageCalculator();
const parser = new TranscriptParser();
const writer = new LogbookWriter();
const toAdd = [];

for (const [sid, info] of mains) {
  if (logged.has(sid)) continue;
  const entry = entrypointOf(info.path);
  if (entry && entry.startsWith("sdk")) continue;

  let sessionData;
  try {
    sessionData = await calc.calculate(info.path, sid);
  } catch {
    continue;
  }
  if (sessionData.totalTokens <= 0) continue;

  let transcriptData;
  try {
    transcriptData = await parser.parseTranscript(info.path, sid);
  } catch (e) {
    console.error(`  ! parse failed for ${sid.slice(0, 8)}: ${e.message}`);
    continue;
  }
  toAdd.push({ sid, sessionData, transcriptData });
}

console.log(`logbook:     ${LOG}`);
console.log(`transcripts: ${projectsRoot}`);
console.log(`missing interactive sessions to backfill: ${toAdd.length}\n`);

if (!toAdd.length) {
  console.log("nothing to backfill — coverage already complete.");
  process.exit(0);
}

toAdd.sort((a, b) => b.sessionData.totalCost - a.sessionData.totalCost);
console.log("  sid       date        tokens        $   slug / project");
let costSum = 0;
for (const r of toAdd) {
  costSum += r.sessionData.totalCost;
  console.log(
    `  ${r.sid.slice(0, 8)}  ${r.transcriptData.endTime.toISOString().slice(0, 10)}  ${String(
      r.sessionData.totalTokens,
    ).padStart(10)}  ${r.sessionData.totalCost.toFixed(2).padStart(7)}  ${
      r.transcriptData.sessionSlug
    } / ${r.transcriptData.projectName ?? "?"}`,
  );
}
console.log(`\n  total: $${costSum.toFixed(2)}`);

if (!APPLY) {
  console.log("\n(dry run — re-run with --apply to write; a timestamped .bak is made first)");
  process.exit(0);
}

if (existsSync(LOG)) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const bak = LOG.replace(/\.csv$/, `.bak-${stamp}.csv`);
  copyFileSync(LOG, bak);
  console.log(`\nbackup: ${bak}`);
}

// Append sequentially — LogbookWriter reads-then-writes the whole file per call
// to de-dupe by sid; concurrent appends would race on that read/write.
for (const r of toAdd) {
  await writer.append(root, {
    sessionData: r.sessionData,
    transcriptData: r.transcriptData,
    location: "",
    config: {},
    weather: null,
  });
}
console.log(`APPLIED. ${toAdd.length} rows written to ${join(root, "logbook.csv")}`);
