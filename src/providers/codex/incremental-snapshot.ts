import { createHash } from "crypto";
import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { open, readFile, stat, unlink } from "fs/promises";
import { writeJsonAtomic } from "../../utils/atomic-file.js";
import { expandHome } from "../../utils/paths.js";
import {
  buildSessionUsage,
  buildTurnUsage,
} from "../../core/usage-summary.js";
import type {
  ModelBreakdown,
  TurnUsage,
} from "../../types/session.js";
import type { ProviderSessionSnapshot } from "../../types/provider.js";
import { displayModelName } from "./model-names.js";
import {
  LONG_CONTEXT_THRESHOLD,
  normalizeModelId,
  priceFor,
  priceMultiplierForTier,
  type ModelPricing,
} from "./pricing.js";
import {
  codexSnapshotVersion,
  fingerprintTranscriptFile,
  fingerprintTranscriptTail,
} from "./transcript-fingerprint.js";
import type {
  CodexRolloutRecord,
  CodexTokenUsage,
} from "./transcript-format.js";

interface ModelTotals {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  cost: number;
}

interface StoredTurn {
  id: string;
  startTime: string;
  endTime: string;
  totalsByModel: Record<string, ModelTotals>;
}

interface StoredSnapshot {
  version: string;
  transcriptPath: string;
  processedBytes: number;
  lastReadBytes: number;
  sourceFingerprint: string;
  sourceMtimeMs: number;
  tailBase64: string;
  sessionId: string;
  hasSessionIdentity: boolean;
  currentModel: string;
  currentServiceTier: string;
  currentTurnId?: string;
  totalsByModel: Record<string, ModelTotals>;
  turns: Record<string, StoredTurn>;
  seenCumulativeUsage: string[];
  unknownModels: string[];
  firstPrompt?: string;
  fallbackPrompt?: string;
  startTime?: string;
  endTime?: string;
  cwd?: string;
  gitBranch?: string;
  userMessageCount: number;
  assistantMessageCount: number;
  createdAt: string;
}

interface MemoEntry {
  size: number;
  mtimeMs: number;
  snapshot: ProviderSessionSnapshot;
}

const memo = new Map<string, MemoEntry>();
const TAIL_BYTES = 64 * 1024;
const CHUNK_BYTES = 8 * 1024 * 1024;
const LOCK_WAIT_ATTEMPTS = 250;

/** Read one append-only rollout once and derive both billing and metadata. */
export async function readCodexSnapshot(
  transcriptPath: string,
  fallbackSessionId: string,
): Promise<ProviderSessionSnapshot> {
  const expanded = resolve(expandHome(transcriptPath));
  if (!existsSync(expanded)) {
    throw new Error(`Transcript file not found: ${transcriptPath}`);
  }
  const info = await stat(expanded);
  const cachedMemo = memo.get(expanded);
  if (
    cachedMemo &&
    cachedMemo.size === info.size &&
    cachedMemo.mtimeMs === info.mtimeMs
  ) {
    return cachedMemo.snapshot;
  }

  const cachePath = snapshotCachePath(expanded);
  const snapshot = await withCacheLock(cachePath, async () => {
    const currentInfo = await stat(expanded);
    let state = await loadState(cachePath, expanded, fallbackSessionId);
    if (currentInfo.size < state.processedBytes) {
      state = newState(expanded, fallbackSessionId);
    } else if (
      currentInfo.size === state.processedBytes &&
      currentInfo.mtimeMs !== state.sourceMtimeMs
    ) {
      const currentFingerprint = await fingerprintTranscriptFile(expanded);
      if (
        state.sourceFingerprint &&
        currentFingerprint !== state.sourceFingerprint
      ) {
        state = newState(expanded, fallbackSessionId);
      }
    }

    if (state.processedBytes === 0) {
      state.currentModel = (await firstDeclaredModel(expanded)) ?? "unknown";
    }
    const applier = createLineApplier(state);
    const appended = await readCompleteAppend(
      expanded,
      state.processedBytes,
      applier.apply,
    );
    applier.finish();
    state.lastReadBytes = appended.bytesRead;
    if (appended.acceptedBytes > 0) {
      state.processedBytes = appended.nextOffset;
      const priorTail = Buffer.from(state.tailBase64 || "", "base64");
      const combined = Buffer.concat([priorTail, appended.tail]);
      state.tailBase64 = combined
        .subarray(Math.max(0, combined.length - TAIL_BYTES))
        .toString("base64");
    }
    state.sourceMtimeMs = currentInfo.mtimeMs;
    state.sourceFingerprint = fingerprintTranscriptTail(
      state.processedBytes,
      Buffer.from(state.tailBase64 || "", "base64"),
    );
    await saveState(cachePath, state);
    return toSnapshot(state);
  });

  const finalInfo = await stat(expanded);
  memo.set(expanded, {
    size: finalInfo.size,
    mtimeMs: finalInfo.mtimeMs,
    snapshot,
  });
  return snapshot;
}

export function snapshotCachePath(transcriptPath: string): string {
  const root =
    process.env.AGENT_USAGE_STAT_CACHE_ROOT ||
    join(homedir(), ".agent-usage-stat", "cache", "codex");
  const key = createHash("sha256")
    .update(resolve(transcriptPath).toLowerCase())
    .digest("hex");
  return join(root, `${key}.json`);
}

async function loadState(
  cachePath: string,
  transcriptPath: string,
  fallbackSessionId: string,
): Promise<StoredSnapshot> {
  try {
    const parsed = JSON.parse(await readFile(cachePath, "utf-8")) as StoredSnapshot;
    if (
      parsed.version === codexSnapshotVersion() &&
      parsed.transcriptPath === transcriptPath &&
      Number.isSafeInteger(parsed.processedBytes)
    ) {
      return parsed;
    }
  } catch {
    // Missing, stale, or interrupted cache writes rebuild from the transcript.
  }
  return newState(transcriptPath, fallbackSessionId);
}

function newState(
  transcriptPath: string,
  fallbackSessionId: string,
): StoredSnapshot {
  return {
    version: codexSnapshotVersion(),
    transcriptPath,
    processedBytes: 0,
    lastReadBytes: 0,
    sourceFingerprint: "",
    sourceMtimeMs: 0,
    tailBase64: "",
    sessionId: fallbackSessionId,
    hasSessionIdentity: false,
    currentModel: "unknown",
    currentServiceTier: "default",
    totalsByModel: {},
    turns: {},
    seenCumulativeUsage: [],
    unknownModels: [],
    userMessageCount: 0,
    assistantMessageCount: 0,
    createdAt: new Date().toISOString(),
  };
}

interface AppendedRange {
  acceptedBytes: number;
  nextOffset: number;
  bytesRead: number;
  tail: Buffer;
}

/**
 * Hand every complete JSONL line appended since `offset` to `onLine`, reading
 * at most `limit` bytes and never more than one chunk at a time. A rollout can
 * exceed 100 MB, any snapshot invalidation replays it from byte zero, and one
 * string cannot hold that much, so nothing on this path materializes the
 * pending range whole. The final partial record is accepted only if it already
 * parses, and deferred to the next checkpoint otherwise.
 */
async function readCompleteAppend(
  path: string,
  offset: number,
  onLine: (line: string) => void,
  limit = Number.POSITIVE_INFINITY,
): Promise<AppendedRange> {
  const info = await stat(path);
  const requested = Math.min(Math.max(0, info.size - offset), limit);
  if (requested === 0) {
    return { acceptedBytes: 0, nextOffset: offset, bytesRead: 0, tail: Buffer.alloc(0) };
  }
  const handle = await open(path, "r");
  try {
    const chunk = Buffer.allocUnsafe(Math.min(requested, CHUNK_BYTES));
    let pending = Buffer.alloc(0);
    let acceptedBytes = 0;
    let bytesRead = 0;
    let tail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    while (bytesRead < requested) {
      const result = await handle.read(
        chunk,
        0,
        Math.min(chunk.length, requested - bytesRead),
        offset + bytesRead,
      );
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
      // What is scanned starts at the accepted cursor rather than at the read
      // cursor, because it carries the partial line the last chunk ended on.
      const scanned = pending.length === 0
        ? chunk.subarray(0, result.bytesRead)
        : Buffer.concat([pending, chunk.subarray(0, result.bytesRead)]);
      const completeLength = scanned.lastIndexOf(0x0a) + 1;
      if (completeLength > 0) {
        emitLines(scanned.subarray(0, completeLength), onLine);
        acceptedBytes += completeLength;
        tail = extendTail(tail, scanned.subarray(0, completeLength));
      }
      pending = Buffer.from(scanned.subarray(completeLength));
    }
    if (pending.length > 0) {
      const candidate = pending.toString("utf-8");
      try {
        JSON.parse(candidate);
        onLine(candidate);
        acceptedBytes += pending.length;
        tail = extendTail(tail, pending);
      } catch {
        // A writer is still appending the final JSONL record. Defer it.
      }
    }
    return { acceptedBytes, nextOffset: offset + acceptedBytes, bytesRead, tail };
  } finally {
    await handle.close();
  }
}

/**
 * Split one newline-terminated block into lines. A line is decoded from the
 * bytes that bound it, so a character split across two chunks is rejoined
 * before it is decoded rather than after.
 */
function emitLines(block: Buffer, onLine: (line: string) => void): void {
  let start = 0;
  while (start < block.length) {
    const newline = block.indexOf(0x0a, start);
    const end = newline === -1 ? block.length : newline;
    if (end > start) onLine(block.toString("utf-8", start, end));
    start = end + 1;
  }
}

/** Carry the last `TAIL_BYTES` of everything accepted so far. */
function extendTail(tail: Buffer, block: Buffer): Buffer {
  const combined = Buffer.concat([
    tail,
    block.subarray(Math.max(0, block.length - TAIL_BYTES)),
  ]);
  return combined.subarray(Math.max(0, combined.length - TAIL_BYTES));
}

interface LineApplier {
  apply(line: string): void;
  finish(): void;
}

/**
 * Fold rollout lines into `state` one line at a time, so a caller can feed them
 * as they are read rather than holding the file. The cumulative-usage keys and
 * unknown models stay in sets for the whole pass, exactly as one pass over one
 * joined string did, and `finish` writes them back once at the end.
 */
function createLineApplier(state: StoredSnapshot): LineApplier {
  const seen = new Set(state.seenCumulativeUsage);
  const unknown = new Set(state.unknownModels);

  function apply(line: string): void {
    if (!line.trim()) return;
    let record: CodexRolloutRecord;
    try {
      record = JSON.parse(line) as CodexRolloutRecord;
    } catch {
      return;
    }
    applyMetadata(state, record);

    if (record.type === "session_meta") {
      if (!state.hasSessionIdentity) {
        state.sessionId =
          record.payload?.id || record.payload?.session_id || state.sessionId;
        state.hasSessionIdentity = true;
      }
      state.cwd ||= record.payload?.cwd;
      state.gitBranch ||= record.payload?.git?.branch;
      return;
    }

    const declared = declaredModel(record);
    if (declared) state.currentModel = declared;

    if (
      record.type === "event_msg" &&
      record.payload?.type === "thread_settings_applied"
    ) {
      if (typeof record.payload.thread_settings?.service_tier === "string") {
        state.currentServiceTier = record.payload.thread_settings.service_tier;
      }
      return;
    }

    if (record.type === "turn_context") {
      const id = record.payload?.turn_id || `turn-${Object.keys(state.turns).length + 1}`;
      const timestamp = record.timestamp || "";
      state.currentTurnId = id;
      state.turns[id] ||= {
        id,
        startTime: timestamp,
        endTime: timestamp,
        totalsByModel: {},
      };
      if (record.payload?.cwd) state.cwd = record.payload.cwd;
      return;
    }

    const currentTurn = state.currentTurnId
      ? state.turns[state.currentTurnId]
      : undefined;
    if (currentTurn && record.timestamp) currentTurn.endTime = record.timestamp;
    if (
      record.type !== "event_msg" ||
      record.payload?.type !== "token_count" ||
      !record.payload.info?.last_token_usage
    ) {
      return;
    }

    const cumulative = record.payload.info.total_token_usage;
    if (cumulative) {
      const key = usageKey(cumulative);
      if (seen.has(key)) return;
      seen.add(key);
    }
    const usage = record.payload.info.last_token_usage;
    const model = normalizeModelId(state.currentModel);
    let turn = currentTurn;
    if (!turn) {
      const timestamp = record.timestamp || "";
      turn = state.turns["turn-1"] ||= {
        id: "turn-1",
        startTime: timestamp,
        endTime: timestamp,
        totalsByModel: {},
      };
      state.currentTurnId = turn.id;
    }

    const allInput = Math.max(0, usage.input_tokens ?? 0);
    const cached = Math.min(allInput, Math.max(0, usage.cached_input_tokens ?? 0));
    const cacheWrite = Math.min(
      allInput - cached,
      Math.max(0, usage.cache_write_tokens ?? 0),
    );
    const uncached = allInput - cached - cacheWrite;
    const output = Math.max(0, usage.output_tokens ?? 0);
    const cost = costFor(
      model,
      state.currentServiceTier,
      uncached,
      cached,
      cacheWrite,
      output,
      allInput,
      unknown,
    );
    addUsage(state.totalsByModel, model, uncached, cached, cacheWrite, output, cost);
    addUsage(turn.totalsByModel, model, uncached, cached, cacheWrite, output, cost);
  }

  function finish(): void {
    state.seenCumulativeUsage = [...seen];
    state.unknownModels = [...unknown];
  }

  return { apply, finish };
}

function applyMetadata(state: StoredSnapshot, record: CodexRolloutRecord): void {
  if (record.timestamp) {
    state.startTime ||= record.timestamp;
    state.endTime = record.timestamp;
  }
  if (record.type === "event_msg" && record.payload?.type === "user_message") {
    state.userMessageCount++;
    if (!state.firstPrompt && typeof record.payload.message === "string") {
      state.firstPrompt = truncate(record.payload.message.trim(), 100);
    }
  } else if (
    record.type === "event_msg" &&
    record.payload?.type === "agent_message"
  ) {
    state.assistantMessageCount++;
  } else if (
    !state.firstPrompt &&
    !state.fallbackPrompt &&
    record.type === "response_item" &&
    record.payload?.type === "message" &&
    record.payload.role === "user"
  ) {
    const text = record.payload.content
      ?.filter((item) => item.type === "input_text" && item.text)
      .map((item) => item.text)
      .join(" ");
    if (text) state.fallbackPrompt = truncate(text.trim(), 100);
  }
}

function toSnapshot(state: StoredSnapshot): ProviderSessionSnapshot {
  const breakdowns = toBreakdowns(state.totalsByModel);
  const turns = Object.values(state.turns)
    .map(toTurnUsage)
    .filter((turn) => turn.totalTokens > 0)
    .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
  const firstPrompt = state.firstPrompt || state.fallbackPrompt || "No prompt available";
  const startTime = safeDate(state.startTime, state.createdAt);
  const endTime = safeDate(state.endTime, state.createdAt);
  return {
    sessionData: buildSessionUsage({
      provider: "codex",
      sessionId: state.sessionId,
      modelBreakdowns: breakdowns,
      turns,
      sourceFingerprint: state.sourceFingerprint,
    }),
    transcriptData: {
      sessionSlug: slugify(firstPrompt, state.sessionId),
      firstPrompt,
      startTime,
      endTime,
      userMessageCount: state.userMessageCount,
      assistantMessageCount: state.assistantMessageCount,
      totalMessages: state.userMessageCount + state.assistantMessageCount,
      gitBranch: state.gitBranch,
      cwd: state.cwd,
    },
    unknownModels: state.unknownModels,
  };
}

function addUsage(
  totalsByModel: Record<string, ModelTotals>,
  model: string,
  input: number,
  cached: number,
  cacheWrite: number,
  output: number,
  cost: number,
): void {
  const totals = totalsByModel[model] ||= emptyTotals();
  totals.inputTokens += input;
  totals.outputTokens += output;
  totals.cacheCreationTokens += cacheWrite;
  totals.cacheReadTokens += cached;
  totals.cost += cost;
}

function emptyTotals(): ModelTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    cost: 0,
  };
}

function toBreakdowns(totals: Record<string, ModelTotals>): ModelBreakdown[] {
  return Object.entries(totals)
    .map(([modelName, item]) => ({
      modelName,
      displayName: displayModelName(modelName),
      inputTokens: item.inputTokens,
      outputTokens: item.outputTokens,
      cacheCreationTokens: item.cacheCreationTokens,
      cacheReadTokens: item.cacheReadTokens,
      cost: item.cost,
    }))
    .sort((a, b) => b.cost - a.cost);
}

function toTurnUsage(turn: StoredTurn): TurnUsage {
  const breakdowns = toBreakdowns(turn.totalsByModel);
  return buildTurnUsage({
    id: turn.id,
    startTime: turn.startTime,
    endTime: turn.endTime || turn.startTime,
    modelBreakdowns: breakdowns,
  });
}

function costFor(
  model: string,
  serviceTier: string,
  uncachedInput: number,
  cachedInput: number,
  cacheWriteInput: number,
  output: number,
  allInput: number,
  unknown: Set<string>,
): number {
  const pricing = priceFor(model);
  if (!pricing) {
    unknown.add(model);
    return 0;
  }
  const rates = ratesFor(pricing, allInput);
  const standardCost =
    (uncachedInput * rates.input +
      cachedInput * rates.cachedInput +
      cacheWriteInput * (rates.cacheWrite ?? rates.input) +
      output * rates.output) /
    1_000_000;
  return standardCost * priceMultiplierForTier(model, serviceTier);
}

function ratesFor(pricing: ModelPricing, allInput: number): ModelPricing {
  if (
    allInput <= LONG_CONTEXT_THRESHOLD ||
    pricing.longInput === undefined ||
    pricing.longCachedInput === undefined ||
    pricing.longOutput === undefined
  ) {
    return pricing;
  }
  return {
    input: pricing.longInput,
    cachedInput: pricing.longCachedInput,
    cacheWrite: pricing.longCacheWrite ?? pricing.longInput,
    output: pricing.longOutput,
  };
}

function usageKey(usage: CodexTokenUsage): string {
  return [
    usage.input_tokens ?? 0,
    usage.cached_input_tokens ?? 0,
    usage.cache_write_tokens ?? 0,
    usage.output_tokens ?? 0,
    usage.reasoning_output_tokens ?? 0,
    usage.total_tokens ?? 0,
  ].join(":");
}

/**
 * The model a rollout record declares, from either surface Codex uses to
 * declare one. `turn_context` carries the model a turn opened with; a switch
 * made inside a turn is announced only through `thread_settings_applied`, and
 * no fresh `turn_context` follows until the next turn begins. Reading just the
 * first surface bills every event in that gap to the superseded model.
 */
function declaredModel(record: CodexRolloutRecord): string | null {
  if (record.type === "turn_context" && record.payload?.model) {
    return normalizeModelId(record.payload.model);
  }
  if (
    record.type === "event_msg" &&
    record.payload?.type === "thread_settings_applied" &&
    record.payload.thread_settings?.model
  ) {
    return normalizeModelId(record.payload.thread_settings.model);
  }
  return null;
}

/**
 * The model to bill a rollout read from its start with. Events can precede the
 * first record that declares one, so the opening chunk is scanned ahead of the
 * pass that bills it. A rollout declares its model within the first records,
 * which is why one chunk is enough to look at.
 */
async function firstDeclaredModel(path: string): Promise<string | null> {
  const seed: { model: string | null } = { model: null };
  await readCompleteAppend(path, 0, (line) => {
    if (
      seed.model ||
      (!line.includes("turn_context") && !line.includes("thread_settings_applied"))
    ) return;
    try {
      seed.model = declaredModel(JSON.parse(line) as CodexRolloutRecord);
    } catch {
      // A record that does not parse declares nothing.
    }
  }, CHUNK_BYTES);
  return seed.model;
}

async function saveState(path: string, state: StoredSnapshot): Promise<void> {
  mkdirSync(resolve(path, ".."), { recursive: true });
  await writeJsonAtomic(path, state);
}

async function withCacheLock<T>(
  cachePath: string,
  action: () => Promise<T>,
): Promise<T> {
  mkdirSync(resolve(cachePath, ".."), { recursive: true });
  const lockPath = `${cachePath}.lock`;
  let handle;
  for (let attempt = 0; attempt < LOCK_WAIT_ATTEMPTS; attempt++) {
    try {
      handle = await open(lockPath, "wx");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > 30_000) await unlink(lockPath);
      } catch {
        // Released between open and inspection.
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
  }
  if (!handle) throw new Error(`timed out waiting for snapshot cache: ${cachePath}`);
  try {
    return await action();
  } finally {
    await handle.close();
    try {
      await unlink(lockPath);
    } catch {
      // A stale-lock cleanup may already have removed it.
    }
  }
}

function slugify(prompt: string, fallbackId: string): string {
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);
  return words.length > 0 ? words.join("-") : fallbackId.slice(0, 8);
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength
    ? text
    : `${text.slice(0, maxLength).trim()}...`;
}

function safeDate(value: string | undefined, fallback: string): Date {
  const date = new Date(value || fallback);
  return Number.isNaN(date.getTime()) ? new Date(fallback) : date;
}
