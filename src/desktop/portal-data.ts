import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { writeJsonAtomic } from "../utils/atomic-file.js";
import {
  vendorForModel,
  type ModelVendor,
} from "../core/model-vendor.js";
import { worktreeProjectForCwd } from "../core/project-name.js";
import {
  LOGBOOK_SHARD_DIR,
  type LogbookModelRecord,
  type LogbookRecord,
  type LogbookTurnRecord,
} from "../core/usage-ledger.js";

const CACHE_FILE = "snapshot-cache.json";
const CACHE_VERSION = 2;
const SHARD_CONCURRENCY = 8;

/** Raw JSON also includes legacy shards whose missing/coercible fields are frozen. */
type RawLogbookRecord = {
  [Key in keyof LogbookRecord]?: unknown;
};

type RawLogbookModelRecord = {
  [Key in keyof LogbookModelRecord]?: unknown;
};

type RawLogbookTurnRecord = {
  [Key in keyof LogbookTurnRecord]?: unknown;
};

export interface BuildPortalDataOptions {
  root: string;
  outDir: string;
}

/** One key's slice of a session's spend and tokens. The key is a model vendor
 *  on one axis and a model name on the other, and both axes carry the same
 *  pair of figures, so one shape serves them. */
export interface PortalSplitRecord {
  cost: number;
  tokens: number;
}

export interface PortalTurnRecord {
  id: string;
  start: string;
  end: string;
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  totalTokens: number;
  cost: number;
  models: string[];
}

/** Compact session shape consumed by the browser renderer. */
export interface PortalSessionRecord {
  slug: string;
  sid: string;
  project: string;
  branch: string;
  cwd: string;
  machine: string;
  start: string;
  end: string | null;
  durSec: number;
  durHuman: string;
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  totalTokens: number;
  cost: number;
  models: string[];
  turns: PortalTurnRecord[];
  provider: string;
  byVendor: Record<string, PortalSplitRecord>;
  /** Per-model spend and tokens, the axis every model chart is drawn on. A
   *  session's total alone cannot be divided between the models that produced
   *  it, so the split is carried rather than reconstructed downstream. */
  byModel: Record<string, PortalSplitRecord>;
}

export interface PortalSnapshotSpan {
  from: string | null;
  to: string | null;
}

export interface PortalSnapshotMeta {
  generatedAt: string;
  source: string;
  shardDir: string;
  sessions: number;
  projects: number;
  machines: number;
  totalCost: number;
  parsedShards: number;
  reusedShards: number;
  span: PortalSnapshotSpan;
}

export interface PortalSnapshotCacheEntry {
  size: number;
  mtimeMs: number;
  session: PortalSessionRecord | null;
}

export interface PortalSnapshotCache {
  version: 2;
  source: string;
  entries: Record<string, PortalSnapshotCacheEntry>;
}

interface ReusedShard extends PortalSnapshotCacheEntry {
  file: string;
  reused: true;
}

interface ParsedShard extends PortalSnapshotCacheEntry {
  file: string;
  reused: false;
}

interface FailedShard {
  file: string;
  error: unknown;
  prior?: PortalSnapshotCacheEntry;
}

type ReadShard = ReusedShard | ParsedShard | FailedShard;

/** Build the portal's compact browser artifacts from persisted session shards. */
export async function buildPortalData(
  options: BuildPortalDataOptions,
): Promise<PortalSnapshotMeta> {
  const { root } = options;
  const outDir = resolve(options.outDir);
  const shardDir = root ? resolve(root, LOGBOOK_SHARD_DIR) : null;

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
    async (file): Promise<ReadShard> => {
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
        const record = JSON.parse(
          await readFile(path, "utf8"),
        ) as RawLogbookRecord;
        return {
          file,
          size: fileStat.size,
          mtimeMs: fileStat.mtimeMs,
          session: normalizeSession(record),
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

  const byId = new Map<string, PortalSessionRecord>();
  const noId: PortalSessionRecord[] = [];
  let shardCount = 0;
  let badShards = 0;
  const nextCache: Record<string, PortalSnapshotCacheEntry> = {};

  for (const entry of entries) {
    if ("error" in entry) {
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
    (left, right) => Date.parse(left.start) - Date.parse(right.start),
  );
  const projects = new Set<string>();
  const machines = new Set<string>();
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

  const meta: PortalSnapshotMeta = {
    generatedAt: new Date().toISOString(),
    source: root,
    shardDir,
    sessions: sessions.length,
    projects: projects.size,
    machines: machines.size,
    totalCost: Math.round(totalCost * 100) / 100,
    parsedShards: entries.filter(
      (entry) => !("error" in entry) && !entry.reused,
    ).length,
    reusedShards: entries.filter(
      (entry) => !("error" in entry) && entry.reused,
    ).length,
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
  } satisfies PortalSnapshotCache);
  await writeJsonAtomic(resolve(outDir, "meta.json"), meta, 2);
  console.log(
    `[build-data] ${sessions.length} sessions (${shardCount} shards` +
      `${badShards ? `, ${badShards} skipped` : ""}) · ${projects.size} projects · ` +
      `$${meta.totalCost.toLocaleString("en-US")} -> ${outDir}`,
  );
  return meta;
}

async function readSnapshotCache(
  outDir: string,
  root: string,
): Promise<PortalSnapshotCache> {
  try {
    const cache = JSON.parse(
      await readFile(resolve(outDir, CACHE_FILE), "utf8"),
    ) as Partial<PortalSnapshotCache>;
    if (
      cache.version === CACHE_VERSION &&
      cache.source === root &&
      cache.entries &&
      typeof cache.entries === "object"
    ) {
      return cache as PortalSnapshotCache;
    }
  } catch {
    // A missing or invalid cache requires a complete rebuild.
  }
  return { version: CACHE_VERSION, source: root, entries: {} };
}

function addSession(
  session: PortalSessionRecord | null,
  byId: Map<string, PortalSessionRecord>,
  noId: PortalSessionRecord[],
): void {
  if (!session) return;
  if (session.sid) byId.set(session.sid, session);
  else noId.push(session);
}

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await map(items[index]);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, items.length) },
      () => worker(),
    ),
  );
  return results;
}

function normalizeSession(
  record: RawLogbookRecord,
): PortalSessionRecord | null {
  const start = record.start_time as string | undefined;
  if (!start || Number.isNaN(Date.parse(start))) return null;
  const cwd = (record.cwd || "") as string;
  const models = Array.isArray(record.models)
    ? record.models.map(String).map((model) => model.trim()).filter(Boolean)
    : String(record.models || "").split(/[;,]/).map((model) => model.trim()).filter(Boolean);
  const splits = usageSplits(record, models);
  return {
    slug: (
      record.session_slug ||
      String(record.session_id || "").slice(0, 8) ||
      "-"
    ) as string,
    sid: String(record.session_id || ""),
    // A shard captured before worktree attribution landed still carries the
    // worktree directory in `project`. Its `cwd` proves that, so the owning
    // project replaces it. Any other path proves nothing about the recorded
    // name, which is the record's own claim and stays as written.
    project: worktreeProjectForCwd(cwd) ?? String(record.project || "-").trim(),
    branch: String(record.branch || "").trim(),
    cwd,
    machine: String(record.machine || "-").trim(),
    start,
    end: (record.end_time || null) as string | null,
    durSec: number(record.duration_seconds),
    durHuman: (record.duration_human || "") as string,
    input: number(record.input_tokens),
    output: number(record.output_tokens),
    cacheCreate: number(record.cache_creation_tokens),
    cacheRead: number(record.cache_read_tokens),
    totalTokens: number(record.total_tokens),
    cost: number(record.total_cost_usd),
    models,
    turns: Array.isArray(record.turns)
      ? record.turns.map(normalizeTurn).filter(isPresent)
      : [],
    provider: String(record.provider || "claude"),
    byVendor: splits.byVendor,
    byModel: splits.byModel,
  };
}

interface PortalUsageSplits {
  byVendor: Record<string, PortalSplitRecord>;
  byModel: Record<string, PortalSplitRecord>;
}

/**
 * Split a session's spend and tokens by model vendor and by model, both
 * independently of the host provider. Claude Code can route to GPT, so
 * provider is neither a billing key nor a chart series.
 *
 * The two axes are read off one walk of `model_breakdowns`, because they are
 * two groupings of the same per-model figures rather than two measurements.
 * Legacy shards carry no breakdowns at all, so both axes fall back to the
 * historical equal split, through one helper so they cannot drift apart.
 */
function usageSplits(
  record: RawLogbookRecord,
  models: string[],
): PortalUsageSplits {
  const byVendor: Record<string, PortalSplitRecord> = {};
  const byModel: Record<string, PortalSplitRecord> = {};

  if (Array.isArray(record.model_breakdowns) && record.model_breakdowns.length) {
    for (const value of record.model_breakdowns) {
      const breakdown = value as RawLogbookModelRecord;
      const model = String(breakdown.model || "").trim();
      const cost = number(breakdown.total_cost_usd);
      const tokens = number(breakdown.total_tokens);
      addSlice(
        byVendor,
        (breakdown.vendor || vendorForModel(model)) as string,
        cost,
        tokens,
      );
      addSlice(byModel, model || "unknown", cost, tokens);
    }
    return { byVendor, byModel };
  }

  const vendors = [
    ...new Set<ModelVendor>(models.map((model) => vendorForModel(model))),
  ];
  const cost = number(record.total_cost_usd);
  const tokens = number(record.total_tokens);
  equalSplit(byVendor, vendors, cost, tokens);
  equalSplit(byModel, models, cost, tokens);
  return { byVendor, byModel };
}

function addSlice(
  split: Record<string, PortalSplitRecord>,
  key: string,
  cost: number,
  tokens: number,
): void {
  const bucket = (split[key] ??= { cost: 0, tokens: 0 });
  bucket.cost += cost;
  bucket.tokens += tokens;
}

/** Divide a session evenly between the keys it names. A legacy shard records
 *  no per-model figures, so an even division is the only split available; a
 *  shard naming one key, or none, hands that key the whole session. */
function equalSplit(
  split: Record<string, PortalSplitRecord>,
  keys: string[],
  cost: number,
  tokens: number,
): void {
  if (!keys.length) {
    addSlice(split, "unknown", cost, tokens);
    return;
  }
  for (const key of keys) {
    addSlice(split, key, cost / keys.length, tokens / keys.length);
  }
}

function normalizeTurn(
  value: unknown,
): PortalTurnRecord | null {
  const record = value as RawLogbookTurnRecord | null | undefined;
  const start = record?.start_time as string | undefined;
  const end = (record?.end_time || start) as string | undefined;
  if (
    !start ||
    !end ||
    Number.isNaN(Date.parse(start)) ||
    Number.isNaN(Date.parse(end))
  ) {
    return null;
  }
  const turn = record as RawLogbookTurnRecord;
  return {
    id: String(turn.turn_id || ""),
    start,
    end,
    input: number(turn.input_tokens),
    output: number(turn.output_tokens),
    cacheCreate: number(turn.cache_creation_tokens),
    cacheRead: number(turn.cache_read_tokens),
    totalTokens: number(turn.total_tokens),
    cost: number(turn.total_cost_usd),
    models: Array.isArray(turn.models)
      ? turn.models.map(String).map((model) => model.trim()).filter(Boolean)
      : [],
  };
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}

function number(value: unknown): number {
  const parsed = Number(typeof value === "string" ? value.trim() : value);
  return Number.isFinite(parsed) ? parsed : 0;
}
