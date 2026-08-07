#!/usr/bin/env node
/** Build the portal's compact browser artifacts from per-session shards. */
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = "snapshot-cache.json";
const CACHE_VERSION = 1;
const SHARD_CONCURRENCY = 8;

export async function buildPortalData(options = {}) {
  const root = options.root || (await canonicalRoot());
  const outDir = resolve(options.outDir || resolve(here, "../public/data"));
  const shardDir = root ? resolve(root, "logbook.d") : null;

  if (!shardDir || !existsSync(shardDir)) {
    throw new Error(`Usage data not found: ${shardDir || "unresolved data root"}`);
  }

  const priorCache = await readSnapshotCache(outDir, root);
  const files = (await readdir(shardDir))
    .filter((file) => file.toLowerCase().endsWith(".json"))
    .sort();
  const entries = await mapConcurrent(
    files,
    SHARD_CONCURRENCY,
    async (file) => {
      const path = resolve(shardDir, file);
      const prior = priorCache.entries[file];
      try {
        const fileStat = await stat(path);
        if (
          prior &&
          prior.size === fileStat.size &&
          prior.mtimeMs === fileStat.mtimeMs
        ) {
          return { ...prior, file, reused: true };
        }
        return {
          file,
          size: fileStat.size,
          mtimeMs: fileStat.mtimeMs,
          session: normalizeSession(JSON.parse(await readFile(path, "utf8"))),
          reused: false,
        };
      } catch (error) {
        console.warn(
          `[build-data] skipping ${file}: ${error instanceof Error ? error.message : error}`,
        );
        return { file, error, prior };
      }
    },
  );

  const byId = new Map();
  const noId = [];
  let shardCount = 0;
  let badShards = 0;
  const nextCache = {};

  for (const entry of entries) {
    if (entry.error) {
      badShards++;
      if (!entry.prior) continue;
      nextCache[entry.file] = entry.prior;
      addSession(entry.prior.session, byId, noId);
      shardCount++;
      continue;
    }
    nextCache[entry.file] = {
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      session: entry.session,
    };
    if (!entry.session) continue;
    addSession(entry.session, byId, noId);
    shardCount++;
  }

  const sessions = [...byId.values(), ...noId].sort(
    (a, b) => Date.parse(a.start) - Date.parse(b.start),
  );
  const projects = new Set();
  const machines = new Set();
  let minStart = Infinity;
  let maxStart = -Infinity;
  let totalCost = 0;

  for (const session of sessions) {
    const time = Date.parse(session.start);
    minStart = Math.min(minStart, time);
    maxStart = Math.max(maxStart, time);
    totalCost += session.cost;
    projects.add(session.project);
    machines.add(session.machine);
  }

  const meta = {
    generatedAt: new Date().toISOString(),
    source: root,
    shardDir,
    sessions: sessions.length,
    projects: projects.size,
    machines: machines.size,
    totalCost: Math.round(totalCost * 100) / 100,
    parsedShards: entries.filter((entry) => !entry.reused && !entry.error).length,
    reusedShards: entries.filter((entry) => entry.reused).length,
    span: sessions.length
      ? {
          from: new Date(minStart).toISOString(),
          to: new Date(maxStart).toISOString(),
        }
      : { from: null, to: null },
  };

  await mkdir(outDir, { recursive: true });
  await writeJsonAtomic(resolve(outDir, "sessions.json"), sessions);
  await writeJsonAtomic(resolve(outDir, CACHE_FILE), {
    version: CACHE_VERSION,
    source: root,
    entries: nextCache,
  });
  await writeJsonAtomic(resolve(outDir, "meta.json"), meta, 2);
  console.log(
    `[build-data] ${sessions.length} sessions (${shardCount} shards` +
      `${badShards ? `, ${badShards} skipped` : ""}) · ${projects.size} projects · ` +
      `$${meta.totalCost.toLocaleString("en-US")} -> ${outDir}`,
  );
  return meta;
}

async function readSnapshotCache(outDir, root) {
  try {
    const cache = JSON.parse(await readFile(resolve(outDir, CACHE_FILE), "utf8"));
    if (
      cache.version === CACHE_VERSION &&
      cache.source === root &&
      cache.entries &&
      typeof cache.entries === "object"
    ) {
      return cache;
    }
  } catch {
    // A missing or invalid cache requires a complete rebuild.
  }
  return { version: CACHE_VERSION, source: root, entries: {} };
}

function addSession(session, byId, noId) {
  if (!session) return;
  if (session.sid) byId.set(session.sid, session);
  else noId.push(session);
}

async function writeJsonAtomic(path, value, space) {
  const staged = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(staged, JSON.stringify(value, null, space), "utf8");
  await rename(staged, path);
}

async function mapConcurrent(items, concurrency, map) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await map(items[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}

async function canonicalRoot() {
  const { resolveUsageRootFromDisk } = await import(
    "../../dist/utils/usage-root.js"
  );
  return resolveUsageRootFromDisk().root;
}

function normalizeSession(record) {
  const start = record.start_time;
  if (!start || Number.isNaN(Date.parse(start))) return null;
  return {
    slug: record.session_slug || String(record.session_id || "").slice(0, 8) || "-",
    sid: String(record.session_id || ""),
    project: String(record.project || "-").trim(),
    branch: String(record.branch || "").trim(),
    cwd: record.cwd || "",
    machine: String(record.machine || "-").trim(),
    start,
    end: record.end_time || null,
    durSec: number(record.duration_seconds),
    durHuman: record.duration_human || "",
    input: number(record.input_tokens),
    output: number(record.output_tokens),
    cacheCreate: number(record.cache_creation_tokens),
    cacheRead: number(record.cache_read_tokens),
    totalTokens: number(record.total_tokens),
    cost: number(record.total_cost_usd),
    models: Array.isArray(record.models)
      ? record.models.map(String).map((model) => model.trim()).filter(Boolean)
      : String(record.models || "").split(/[;,]/).map((model) => model.trim()).filter(Boolean),
    turns: Array.isArray(record.turns)
      ? record.turns.map(normalizeTurn).filter(Boolean)
      : [],
    provider: String(record.provider || "claude"),
    byVendor: vendorSplit(record),
  };
}

/**
 * Split a session's spend and tokens by MODEL VENDOR, which is independent of
 * `provider` (the host tool). Claude Code can route to GPT, so charting spend by
 * provider files OpenAI usage under Anthropic.
 *
 * Shards written from 2026-07-20 carry `model_breakdowns` and split exactly.
 * Older shards only recorded model NAMES, so we attribute the session total to
 * the single vendor its models belong to — exact unless a pre-2026-07-20 session
 * mixed vendors, which none in the corpus do. A mixed legacy shard falls back to
 * splitting by token share rather than silently picking one vendor.
 */
function vendorSplit(record) {
  const split = {};
  const add = (vendor, cost, tokens) => {
    const bucket = (split[vendor] ??= { cost: 0, tokens: 0 });
    bucket.cost += cost;
    bucket.tokens += tokens;
  };

  if (Array.isArray(record.model_breakdowns) && record.model_breakdowns.length) {
    for (const breakdown of record.model_breakdowns) {
      add(
        breakdown.vendor || vendorForModel(String(breakdown.model || "")),
        number(breakdown.total_cost_usd),
        number(breakdown.total_tokens),
      );
    }
    return split;
  }

  const models = Array.isArray(record.models) ? record.models : [];
  const vendors = [...new Set(models.map((m) => vendorForModel(String(m))))];
  const cost = number(record.total_cost_usd);
  const tokens = number(record.total_tokens);
  if (vendors.length <= 1) {
    add(vendors[0] || "unknown", cost, tokens);
  } else {
    for (const vendor of vendors) add(vendor, cost / vendors.length, tokens / vendors.length);
  }
  return split;
}

/** Mirrors src/core/model-vendor.ts — kept inline so the builder stays dist-free. */
function vendorForModel(model) {
  const id = model.trim().toLowerCase();
  if (id.startsWith("claude")) return "anthropic";
  if (id.startsWith("gpt") || id.startsWith("codex")) return "openai";
  return "unknown";
}

function normalizeTurn(record) {
  const start = record?.start_time;
  const end = record?.end_time || start;
  if (!start || Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end))) {
    return null;
  }
  return {
    id: String(record.turn_id || ""),
    start,
    end,
    input: number(record.input_tokens),
    output: number(record.output_tokens),
    cacheCreate: number(record.cache_creation_tokens),
    cacheRead: number(record.cache_read_tokens),
    totalTokens: number(record.total_tokens),
    cost: number(record.total_cost_usd),
    models: Array.isArray(record.models)
      ? record.models.map(String).map((model) => model.trim()).filter(Boolean)
      : [],
  };
}

function number(value) {
  const parsed = Number(typeof value === "string" ? value.trim() : value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function cliOption(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = cliOption("--root") || process.env.AGENT_USAGE_STAT_DATA_ROOT;
  const outDir = cliOption("--output");
  buildPortalData({ root, outDir }).catch((error) => {
    console.error(`[build-data] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
