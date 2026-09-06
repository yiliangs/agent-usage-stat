import { createHash } from "crypto";
import { existsSync } from "fs";
import { homedir } from "os";
import { basename, join, resolve } from "path";
import { mkdir, open, readFile, stat, unlink } from "fs/promises";
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
  normalizeModelId,
  priceForRequest,
  priceMultiplierForSpeed,
} from "./pricing.js";
import { findSessionTranscriptFiles } from "./session-files.js";
import {
  claudeSnapshotVersion,
  fingerprintTranscriptParts,
  fingerprintTranscriptTail,
} from "./transcript-fingerprint.js";
import type { TranscriptMessage } from "./transcript-format.js";

interface ModelTotals {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  cost: number;
}

interface StoredFile {
  processedBytes: number;
  sourceMtimeMs: number;
  tailBase64: string;
}

interface StoredSnapshot {
  version: string;
  transcriptPath: string;
  sessionId: string;
  files: Record<string, StoredFile>;
  lastReadBytes: number;
  sourceFingerprint: string;
  totalsByModel: Record<string, ModelTotals>;
  turns: TurnUsage[];
  seenBillingKeys: string[];
  unknownModels: string[];
  temporalComplete: boolean;
  firstUserSeen: boolean;
  sessionSlug?: string;
  firstPrompt?: string;
  startTime?: string;
  endTime?: string;
  cwd?: string;
  gitBranch?: string;
  userMessageCount: number;
  assistantMessageCount: number;
  totalMessages: number;
  createdAt: string;
}

const SYNTHETIC_MODEL = "<synthetic>";
const TAIL_BYTES = 64 * 1024;
const CHUNK_BYTES = 8 * 1024 * 1024;
const LOCK_WAIT_ATTEMPTS = 250;

/** Incrementally derive billing and metadata from one Claude session tree. */
export async function readClaudeSnapshot(
  transcriptPath: string,
  fallbackSessionId: string,
): Promise<ProviderSessionSnapshot> {
  const expanded = resolve(expandHome(transcriptPath));
  if (!existsSync(expanded)) {
    throw new Error(`Transcript file not found: ${transcriptPath}`);
  }
  const sessionId = fallbackSessionId || basename(expanded, ".jsonl");
  const cachePath = snapshotCachePath(expanded);

  return withCacheLock(cachePath, async () => {
    const files = await findSessionTranscriptFiles(expanded, sessionId);
    let state = await loadState(cachePath, expanded, sessionId);
    if (await requiresRebuild(state, files)) {
      state = newState(expanded, sessionId);
    }

    state.lastReadBytes = 0;
    const applier = createLineApplier(state);
    for (const file of files) {
      const isMain = file === expanded;
      try {
        const info = await stat(file);
        const stored = state.files[file] ?? {
          processedBytes: 0,
          sourceMtimeMs: 0,
          tailBase64: "",
        };
        const appended = await readCompleteAppend(
          file,
          stored.processedBytes,
          (line) => applier.apply(line, isMain),
        );
        state.lastReadBytes += appended.bytesRead;
        if (appended.acceptedBytes > 0) {
          stored.processedBytes = appended.nextOffset;
          const priorTail = Buffer.from(stored.tailBase64 || "", "base64");
          const combined = Buffer.concat([priorTail, appended.tail]);
          stored.tailBase64 = combined
            .subarray(Math.max(0, combined.length - TAIL_BYTES))
            .toString("base64");
        }
        stored.sourceMtimeMs = info.mtimeMs;
        state.files[file] = stored;
      } catch {
        if (isMain) throw new Error(`Transcript file not found: ${transcriptPath}`);
        delete state.files[file];
      }
    }
    applier.finish();
    state.sourceFingerprint = fingerprintTranscriptParts(
      Object.values(state.files).map((file) =>
        fingerprintTranscriptTail(
          file.processedBytes,
          Buffer.from(file.tailBase64 || "", "base64"),
        )
      ),
    );
    await saveState(cachePath, state);
    return toSnapshot(state);
  });
}

export function snapshotCachePath(transcriptPath: string): string {
  const root = process.env.AGENT_USAGE_STAT_CACHE_ROOT
    ? join(process.env.AGENT_USAGE_STAT_CACHE_ROOT, "claude")
    : join(homedir(), ".agent-usage-stat", "cache", "claude");
  const key = createHash("sha256")
    .update(resolve(transcriptPath).toLowerCase())
    .digest("hex");
  return join(root, `${key}.json`);
}

async function requiresRebuild(
  state: StoredSnapshot,
  files: string[],
): Promise<boolean> {
  const current = new Set(files);
  if (Object.keys(state.files).some((file) => !current.has(file))) return true;
  for (const file of files) {
    const stored = state.files[file];
    if (!stored) continue;
    let info;
    try {
      info = await stat(file);
    } catch {
      if (file === state.transcriptPath) throw new Error(`Transcript file not found: ${file}`);
      return true;
    }
    if (info.size < stored.processedBytes) return true;
    if (info.size === stored.processedBytes && info.mtimeMs !== stored.sourceMtimeMs) {
      const tail = await readTail(file, info.size);
      const fingerprint = fingerprintTranscriptTail(info.size, tail);
      const prior = fingerprintTranscriptTail(
        stored.processedBytes,
        Buffer.from(stored.tailBase64 || "", "base64"),
      );
      if (fingerprint !== prior) return true;
    }
  }
  return false;
}

async function loadState(
  cachePath: string,
  transcriptPath: string,
  sessionId: string,
): Promise<StoredSnapshot> {
  try {
    const parsed = JSON.parse(await readFile(cachePath, "utf-8")) as StoredSnapshot;
    if (
      parsed.version === claudeSnapshotVersion() &&
      parsed.transcriptPath === transcriptPath &&
      parsed.sessionId === sessionId
    ) return parsed;
  } catch {
    // Missing, stale, or interrupted cache writes rebuild from transcripts.
  }
  return newState(transcriptPath, sessionId);
}

function newState(transcriptPath: string, sessionId: string): StoredSnapshot {
  return {
    version: claudeSnapshotVersion(),
    transcriptPath,
    sessionId,
    files: {},
    lastReadBytes: 0,
    sourceFingerprint: "",
    totalsByModel: {},
    turns: [],
    seenBillingKeys: [],
    unknownModels: [],
    temporalComplete: true,
    firstUserSeen: false,
    userMessageCount: 0,
    assistantMessageCount: 0,
    totalMessages: 0,
    createdAt: new Date().toISOString(),
  };
}

interface LineApplier {
  apply(line: string, isMain: boolean): void;
  finish(): void;
}

/**
 * Fold transcript lines into `state` one line at a time, so a caller can feed
 * them as they are read rather than holding the file. Billing keys and unknown
 * models stay in sets across the whole session tree, exactly as one pass over
 * one joined string did, and `finish` writes them back once at the end.
 */
function createLineApplier(state: StoredSnapshot): LineApplier {
  const seen = new Set(state.seenBillingKeys);
  const unknown = new Set(state.unknownModels);

  function apply(line: string, isMain: boolean): void {
    if (!line.trim()) return;
    let message: TranscriptMessage;
    try {
      message = JSON.parse(line) as TranscriptMessage;
    } catch {
      return;
    }
    if (isMain) applyMetadata(state, message);
    if (
      message.type !== "assistant" ||
      !message.message?.usage ||
      !message.message.model ||
      message.message.model === SYNTHETIC_MODEL
    ) return;

    const id = message.message.id;
    if (id && seen.has(id)) return;
    if (id) seen.add(id);
    const model = normalizeModelId(message.message.model);
    const usage = message.message.usage;
    const input = Math.max(0, usage.input_tokens || 0);
    const output = Math.max(0, usage.output_tokens || 0);
    const cacheWrite = Math.max(0, usage.cache_creation_input_tokens || 0);
    const cacheRead = Math.max(0, usage.cache_read_input_tokens || 0);
    const pricing = priceForRequest(model, input + cacheWrite + cacheRead);
    if (!pricing) unknown.add(model);
    const standardCost = pricing
      ? (input * pricing.input + output * pricing.output +
          cacheWrite * pricing.cacheWrite + cacheRead * pricing.cacheRead) /
        1_000_000
      : 0;
    const cost = standardCost * priceMultiplierForSpeed(model, usage.speed);
    addUsage(state.totalsByModel, model, input, output, cacheWrite, cacheRead, cost);

    if (!message.timestamp || Number.isNaN(Date.parse(message.timestamp))) {
      state.temporalComplete = false;
      return;
    }
    const breakdown = breakdownFor(model, input, output, cacheWrite, cacheRead, cost);
    state.turns.push(buildTurnUsage({
      id: id || message.uuid || message.requestId || `claude-response-${state.turns.length + 1}`,
      startTime: message.timestamp,
      endTime: message.timestamp,
      modelBreakdowns: [breakdown],
    }));
  }

  function finish(): void {
    state.seenBillingKeys = [...seen];
    state.unknownModels = [...unknown];
  }

  return { apply, finish };
}

function applyMetadata(state: StoredSnapshot, message: TranscriptMessage): void {
  state.totalMessages++;
  if (message.timestamp && !Number.isNaN(Date.parse(message.timestamp))) {
    state.startTime ||= message.timestamp;
    state.endTime = message.timestamp;
  }
  if (message.cwd) state.cwd = message.cwd;
  if (message.gitBranch) state.gitBranch = message.gitBranch;
  if (message.type === "user") {
    state.userMessageCount++;
    if (!state.firstUserSeen) {
      state.firstUserSeen = true;
      state.sessionSlug = message.slug || undefined;
      state.firstPrompt = promptText(message);
    }
  } else if (message.type === "assistant") {
    state.assistantMessageCount++;
  }
}

function toSnapshot(state: StoredSnapshot): ProviderSessionSnapshot {
  const breakdowns = toBreakdowns(state.totalsByModel);
  const created = new Date(state.createdAt);
  return {
    sessionData: buildSessionUsage({
      provider: "claude",
      sessionId: state.sessionId,
      modelBreakdowns: breakdowns,
      turns: state.temporalComplete
        ? [...state.turns].sort((a, b) => Date.parse(a.endTime) - Date.parse(b.endTime))
        : undefined,
      sourceFingerprint: state.sourceFingerprint,
    }),
    transcriptData: {
      sessionSlug: state.sessionSlug || state.sessionId.slice(0, 8) || "unknown-session",
      firstPrompt: state.firstPrompt || "No prompt available",
      startTime: safeDate(state.startTime, created),
      endTime: safeDate(state.endTime, created),
      userMessageCount: state.userMessageCount,
      assistantMessageCount: state.assistantMessageCount,
      totalMessages: state.totalMessages,
      gitBranch: state.gitBranch,
      cwd: state.cwd,
    },
    unknownModels: state.unknownModels,
  };
}

function addUsage(
  totals: Record<string, ModelTotals>,
  model: string,
  input: number,
  output: number,
  cacheWrite: number,
  cacheRead: number,
  cost: number,
): void {
  const item = totals[model] ||= emptyTotals();
  item.inputTokens += input;
  item.outputTokens += output;
  item.cacheCreationTokens += cacheWrite;
  item.cacheReadTokens += cacheRead;
  item.cost += cost;
}

function toBreakdowns(totals: Record<string, ModelTotals>): ModelBreakdown[] {
  return Object.entries(totals)
    .map(([model, item]) => breakdownFor(
      model,
      item.inputTokens,
      item.outputTokens,
      item.cacheCreationTokens,
      item.cacheReadTokens,
      item.cost,
    ))
    .sort((a, b) => b.cost - a.cost);
}

function breakdownFor(
  modelName: string,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
  cost: number,
): ModelBreakdown {
  return {
    modelName,
    displayName: displayModelName(modelName),
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    cost,
  };
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

interface AppendedRange {
  acceptedBytes: number;
  nextOffset: number;
  bytesRead: number;
  tail: Buffer;
}

/**
 * Hand every complete JSONL line appended since `offset` to `onLine`, reading
 * the pending range in bounded chunks. Any snapshot invalidation replays a
 * session tree from byte zero, and a transcript can be larger than the heap
 * comfortably holds and larger than one string may ever hold, so nothing on
 * this path materializes the pending range whole. The final partial record is
 * accepted only if it already parses, and deferred to the next checkpoint
 * otherwise.
 */
async function readCompleteAppend(
  path: string,
  offset: number,
  onLine: (line: string) => void,
): Promise<AppendedRange> {
  const info = await stat(path);
  const requested = Math.max(0, info.size - offset);
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

async function readTail(path: string, size: number): Promise<Buffer> {
  const length = Math.min(size, TAIL_BYTES);
  const buffer = Buffer.alloc(length);
  const handle = await open(path, "r");
  try {
    const result = await handle.read(buffer, 0, length, Math.max(0, size - length));
    return buffer.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }
}

async function saveState(path: string, state: StoredSnapshot): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeJsonAtomic(path, state);
}

async function withCacheLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  await mkdir(resolve(path, ".."), { recursive: true });
  const lockPath = `${path}.lock`;
  let handle;
  for (let attempt = 0; attempt < LOCK_WAIT_ATTEMPTS; attempt++) {
    try {
      handle = await open(lockPath, "wx");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - (await stat(lockPath)).mtimeMs > 30_000) await unlink(lockPath);
      } catch {
        // Released between open and inspection.
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
  }
  if (!handle) throw new Error(`timed out waiting for snapshot cache: ${path}`);
  try {
    return await action();
  } finally {
    await handle.close();
    await unlink(lockPath).catch(() => undefined);
  }
}

function promptText(message: TranscriptMessage): string {
  const content = message.message?.content;
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.filter((part) => part.type === "text" && part.text)
        .map((part) => part.text).join(" ")
      : "";
  return text.length <= 100 ? text || "No prompt available" : `${text.slice(0, 100).trim()}...`;
}

function safeDate(value: string | undefined, fallback: Date): Date {
  const parsed = new Date(value || fallback);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}
