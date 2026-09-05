#!/usr/bin/env node
/**
 * reprice-sonnet-5.mjs: one-time correction for the Claude Sonnet 5 rate (#81).
 *
 * The baked table carried the pre-launch announced $3/$15 rate. The effective
 * rate was $2/$10 for the model's whole history, so every Sonnet 5 session
 * captured before the table was corrected is on disk 50 percent high.
 *
 * A recompute cannot repair them. `preserveRecordedUsage` refuses to let a
 * recomputation lower a recorded cost, precisely because a pricing correction
 * moves the rate underneath reads already written, so the correction has to be
 * applied to the ledger deliberately rather than fall out of a re-read.
 *
 * The correction is a scale, not a recomputation from tokens. Every component
 * of the rate fell by the same factor:
 *
 *     input       3     -> 2      output      15    -> 10
 *     cacheWrite  3.75  -> 2.50   cacheRead   0.30  -> 0.20
 *
 * all of them exactly two thirds. So a recorded Sonnet 5 cost scales by 2/3
 * whatever its cache mix, and whatever multiplier was folded in when it was
 * written, because a multiplier is itself multiplicative. Recomputing from
 * tokens instead would also silently absorb every other pricing difference
 * since capture, which is a different change than the one asked for.
 *
 * Cost is recorded at three levels and all three are scaled: the shard total,
 * the per-model breakdown, and the per-turn figure. A turn is scaled only when
 * every model it names is Sonnet 5; a turn mixing Sonnet 5 with another model
 * cannot be split from the turn record alone, so the script reports it and
 * changes nothing rather than guessing. Token counts are never touched.
 *
 * Usage:
 *   node scripts/reprice-sonnet-5.mjs           # dry run — report only
 *   node scripts/reprice-sonnet-5.mjs --apply   # rewrite the shards
 */
import { readFileSync, writeFileSync, renameSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { resolveUsageRootFromDisk } from "../dist/utils/usage-root.js";
import { LOGBOOK_SHARD_DIR } from "../dist/core/usage-ledger.js";

const APPLY = process.argv.includes("--apply");
const FACTOR = 2 / 3;
const SHARD_DIR = join(resolveUsageRootFromDisk().root, LOGBOOK_SHARD_DIR);

/** The model this pass corrects, under any id shape a shard may carry it in. */
function isSonnet5(model) {
  if (typeof model !== "string") return false;
  const normalized = model
    .trim()
    .toLowerCase()
    .replace(/^(claude-[a-z]+-\d+)\.(\d+)/, "$1-$2")
    .replace(/\[[^\]]*\]$/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-\d{4}-\d{2}-\d{2}$/, "");
  return normalized === "claude-sonnet-5";
}

/** Shard costs are written to six decimals; keep the correction in that shape. */
const cents = (value) => Math.round(value * 1e6) / 1e6;

function repriceShard(shard) {
  const breakdowns = shard.model_breakdowns || [];
  const affected = breakdowns.filter((breakdown) => isSonnet5(breakdown.model));
  if (affected.length === 0) return null;

  let removed = 0;
  for (const breakdown of affected) {
    const before = breakdown.total_cost_usd || 0;
    const after = cents(before * FACTOR);
    removed += before - after;
    breakdown.total_cost_usd = after;
  }

  let turnsScaled = 0;
  let turnsMixed = 0;
  for (const turn of shard.turns || []) {
    const models = turn.models || [];
    if (!models.some(isSonnet5)) continue;
    if (!models.every(isSonnet5)) {
      turnsMixed += 1;
      continue;
    }
    turn.total_cost_usd = cents((turn.total_cost_usd || 0) * FACTOR);
    turnsScaled += 1;
  }

  const before = shard.total_cost_usd || 0;
  shard.total_cost_usd = cents(before - removed);
  return { before, after: shard.total_cost_usd, removed, turnsScaled, turnsMixed };
}

const files = readdirSync(SHARD_DIR).filter((name) => name.endsWith(".json"));
let changed = 0;
let recovered = 0;
let mixed = 0;
let unreadable = 0;

for (const name of files) {
  const path = join(SHARD_DIR, name);
  let shard;
  try {
    shard = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    unreadable += 1;
    console.log(`SKIP  ${name}: ${error.message}`);
    continue;
  }

  const result = repriceShard(shard);
  if (!result) continue;

  changed += 1;
  recovered += result.removed;
  mixed += result.turnsMixed;
  console.log(
    `${APPLY ? "WRITE" : "WOULD"} ${name}  ${shard.project}  ` +
    `$${result.before.toFixed(6)} -> $${result.after.toFixed(6)}  ` +
    `(-$${result.removed.toFixed(6)}, ${result.turnsScaled} turns` +
    `${result.turnsMixed > 0 ? `, ${result.turnsMixed} MIXED left alone` : ""})`,
  );

  if (!APPLY) continue;
  // Same atomicity the shard writer uses: a torn write here loses a session.
  const staging = `${path}.reprice.tmp`;
  writeFileSync(staging, `${JSON.stringify(shard, null, 2)}\n`, "utf8");
  renameSync(staging, path);
}

console.log(
  `\n${files.length} shards read, ${changed} carry Sonnet 5, ` +
  `$${recovered.toFixed(2)} overstated${unreadable > 0 ? `, ${unreadable} unreadable` : ""}.`,
);
if (mixed > 0) {
  console.log(`${mixed} turns mix Sonnet 5 with another model and were left alone.`);
  console.log("Their shard and breakdown totals are corrected; only the turn figures are not.");
}
if (!APPLY) console.log("Dry run. Re-run with --apply to write.");
