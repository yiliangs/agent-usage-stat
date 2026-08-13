import { createHash } from "crypto";
import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { basename, join, resolve } from "path";
import {
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "fs/promises";
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

    const appended = await readCompleteAppend(expanded, state.processedBytes);
    state.lastReadBytes = appended.bytesRead;
    if (appended.text) {
      if (state.processedBytes === 0) {
        state.currentModel = firstDeclaredModel(appended.text) ?? "unknown";
      }
      applyLines(state, appended.text);
      state.processedBytes = appended.nextOffset;
      const priorTail = Buffer.from(state.tailBase64 || "", "base64");
      const combined = Buffer.concat([priorTail, appended.completeBytes]);
      state.tailBase64 = combined
        .subarray(Math.max(0, combined.length - 64 * 1024))
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

async function readCompleteAppend(
  path: string,
  offset: number,
): Promise<{
  text: string;
  completeBytes: Buffer;
  nextOffset: number;
  bytesRead: number;
}> {
  const info = await stat(path);
  const requested = Math.max(0, info.size - offset);
  if (requested === 0) {
    return { text: "", completeBytes: Buffer.alloc(0), nextOffset: offset, bytesRead: 0 };
  }
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(requested);
    const result = await handle.read(buffer, 0, requested, offset);
    const bytes = buffer.subarray(0, result.bytesRead);
    let completeLength = bytes.lastIndexOf(0x0a) + 1;
    if (completeLength === 0) {
      const candidate = bytes.toString("utf-8");
      try {
        JSON.parse(candidate);
        completeLength = bytes.length;
      } catch {
        return {
          text: "",
          completeBytes: Buffer.alloc(0),
          nextOffset: offset,
          bytesRead: result.bytesRead,
        };
      }
    } else if (completeLength < bytes.length) {
      const candidate = bytes.subarray(completeLength).toString("utf-8");
      try {
        JSON.parse(candidate);
        completeLength = bytes.length;
      } catch {
        // A writer is still appending the final JSONL record. Defer it.
      }
    }
    const completeBytes = bytes.subarray(0, completeLength);
    return {
      text: completeBytes.toString("utf-8"),
      completeBytes,
      nextOffset: offset + completeLength,
      bytesRead: result.bytesRead,
    };
  } finally {
    await handle.close();
  }
}

function applyLines(state: StoredSnapshot, content: string): void {
  const seen = new Set(state.seenCumulativeUsage);
  const unknown = new Set(state.unknownModels);
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let record: CodexRolloutRecord;
    try {
      record = JSON.parse(line) as CodexRolloutRecord;
    } catch {
      continue;
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
      continue;
    }

    if (
      record.type === "event_msg" &&
      record.payload?.type === "thread_settings_applied" &&
      typeof record.payload.thread_settings?.service_tier === "string"
    ) {
      state.currentServiceTier = record.payload.thread_settings.service_tier;
      continue;
    }

    if (record.type === "turn_context") {
      if (record.payload?.model) {
        state.currentModel = normalizeModelId(record.payload.model);
      }
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
      continue;
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
      continue;
    }

    const cumulative = record.payload.info.total_token_usage;
    if (cumulative) {
      const key = usageKey(cumulative);
      if (seen.has(key)) continue;
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
  state.seenCumulativeUsage = [...seen];
  state.unknownModels = [...unknown];
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
      projectName: state.cwd ? basename(state.cwd.replace(/[\\/]+$/, "")) : undefined,
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

function firstDeclaredModel(content: string): string | null {
  for (const line of content.split("\n")) {
    if (!line.includes("turn_context")) continue;
    try {
      const record = JSON.parse(line) as CodexRolloutRecord;
      if (record.type === "turn_context" && record.payload?.model) {
        return normalizeModelId(record.payload.model);
      }
    } catch {
      continue;
    }
  }
  return null;
}

async function saveState(path: string, state: StoredSnapshot): Promise<void> {
  mkdirSync(resolve(path, ".."), { recursive: true });
  const temp = `${path}.${process.pid}-${Date.now()}.tmp`;
  await writeFile(temp, JSON.stringify(state), "utf-8");
  await rename(temp, path);
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
