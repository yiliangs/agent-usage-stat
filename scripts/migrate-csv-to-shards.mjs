#!/usr/bin/env node
/**
 * migrate-csv-to-shards.mjs — one-shot: fold the frozen legacy logbook.csv into
 * logbook.d/ so the shard directory becomes the SINGLE source of truth.
 *
 * Why: with two sources, every consumer (portal build-data, terminal
 * statusline) had to re-implement the same merge/de-dup rules, and they
 * drifted — a session recorded in the CSV era and re-recorded as a shard after
 * a resume was double-counted by the statusline ($6,026) but de-duped by the
 * portal ($5,831). One directory keyed by session_id (shard filename IS the
 * session id) makes duplicates structurally impossible and reduces every
 * consumer to "sum the shards".
 *
 * Semantics: an existing shard always wins over its CSV row (same rule
 * build-data used). Rows without a session_id get the writer's fallback name.
 * After a successful apply the CSV is renamed to logbook.csv.migrated-<date>.bak
 * — nothing is deleted.
 *
 * Usage:
 *   node scripts/migrate-csv-to-shards.mjs           # dry run — report only
 *   node scripts/migrate-csv-to-shards.mjs --apply   # write shards + retire CSV
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import { LOGBOOK_SHARD_DIR, shardPathFor } from "../dist/core/usage-ledger.js";
import { resolveUsageRootFromDisk } from "../dist/utils/usage-root.js";

const APPLY = process.argv.includes("--apply");
// The legacy CSV sat beside the shard directory in the usage root, so both are
// resolved from that one root rather than from a drive letter this machine
// happens to mount. health-check.mjs looks for a resurrected CSV in the same
// place.
const ROOT = resolveUsageRootFromDisk().root;
const CSV = join(ROOT, "logbook.csv");
const SHARD_DIR = join(ROOT, LOGBOOK_SHARD_DIR);

if (!existsSync(CSV)) {
  console.log(`nothing to migrate: ${CSV} not found (already retired?)`);
  process.exit(0);
}

// RFC-4180-ish line parser (same as build-data.mjs)
function parseLine(line) {
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (q && line[i + 1] === '"') { cur += '"'; i++; }
      else q = !q;
    } else if (c === "," && !q) { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}
const num = (v) => {
  const n = Number(typeof v === "string" ? v.trim() : v);
  return Number.isFinite(n) ? n : 0;
};

const lines = readFileSync(CSV, "utf8").split(/\r?\n/).filter((l) => l.trim().length);
const header = parseLine(lines[0]).map((h) => h.trim());

const existing = new Set(
  existsSync(SHARD_DIR)
    ? readdirSync(SHARD_DIR).filter((f) => f.toLowerCase().endsWith(".json"))
    : [],
);

let migrated = 0, skippedShardWins = 0, skippedMalformed = 0, noId = 0;
const anomalies = [];

for (let li = 1; li < lines.length; li++) {
  const r = parseLine(lines[li]);
  if (r.length < header.length) {
    skippedMalformed++;
    anomalies.push(`line ${li + 1}: ${r.length}/${header.length} fields — skipped`);
    continue;
  }
  const rec = {};
  header.forEach((h, i) => { rec[h] = r[i]; });

  if (Number.isNaN(Date.parse(rec.start_time))) {
    anomalies.push(`line ${li + 1}: unparseable start_time "${rec.start_time}"`);
  }

  // Field order and shape mirror LogbookRecord (logbook-writer.ts).
  const shard = {
    timestamp: rec.timestamp || "",
    session_slug: rec.session_slug || "",
    session_id: rec.session_id || "",
    project: rec.project || "",
    branch: rec.branch || "",
    cwd: rec.cwd || "",
    machine: rec.machine || "",
    location: rec.location || "",
    start_time: rec.start_time || "",
    end_time: rec.end_time || "",
    duration_seconds: num(rec.duration_seconds),
    duration_human: rec.duration_human || "",
    input_tokens: num(rec.input_tokens),
    output_tokens: num(rec.output_tokens),
    cache_creation_tokens: num(rec.cache_creation_tokens),
    cache_read_tokens: num(rec.cache_read_tokens),
    total_tokens: num(rec.total_tokens),
    total_cost_usd: num(rec.total_cost_usd),
    models: String(rec.models || "").split(/[;,]/).map((m) => m.trim()).filter(Boolean),
  };

  if (!shard.session_id) noId++;
  // The shard's path is the writer's derivation, not this script's: a key
  // carrying a character no filename can hold has to map to the one file every
  // reader looks for.
  const base = shard.session_id || `${shard.session_slug || "session"}-${shard.end_time}`;
  const path = shardPathFor(ROOT, base);
  const name = basename(path);

  if (existing.has(name)) {
    skippedShardWins++;
    console.log(`  shard wins over CSV row: ${name} (csv $${shard.total_cost_usd.toFixed(2)})`);
    continue;
  }

  if (APPLY) writeFileSync(path, JSON.stringify(shard, null, 2), "utf-8");
  existing.add(name); // csv-internal duplicate sids: first row wins, later ones reported
  migrated++;
}

console.log(`\n${APPLY ? "APPLIED" : "DRY RUN"}: ${migrated} rows -> shards, ` +
  `${skippedShardWins} superseded by existing shards, ${skippedMalformed} malformed skipped, ${noId} without session_id`);
for (const a of anomalies) console.log("  anomaly:", a);

if (APPLY) {
  const bak = CSV.replace(/\.csv$/, `.csv.migrated-${new Date().toISOString().slice(0, 10)}.bak`);
  renameSync(CSV, bak);
  console.log(`CSV retired -> ${bak}`);

  // verify: total over shards must equal the old merged (shard-wins) total
  let total = 0, n = 0;
  for (const f of readdirSync(SHARD_DIR)) {
    if (!f.toLowerCase().endsWith(".json")) continue;
    total += num(JSON.parse(readFileSync(join(SHARD_DIR, f), "utf8")).total_cost_usd);
    n++;
  }
  console.log(`verify: ${n} shards, lifetime total $${total.toFixed(2)}`);
}
