import type { ProviderSessionSnapshot } from "../../types/provider.js";
import type { ModelBreakdown } from "../../types/session.js";
import type { ParsedTranscript } from "../../types/transcript.js";
import { buildSessionUsage } from "../../core/usage-summary.js";
import { displayModelName, normalizeModelId, priceFor } from "./pricing.js";
import { fingerprintSessionTree } from "./transcript-fingerprint.js";
import { readSessionRecords } from "./transcript-reader.js";
import type {
  OpencodeAssistantMessage,
  OpencodeSessionRecords,
} from "./transcript-format.js";

interface ModelTotals {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** What opencode itself billed, used only where our tables have no rate. */
  hostCost: number;
}

/** Derive opencode billing and metadata from one read of a session tree. */
export async function readOpencodeSnapshot(
  databasePath: string,
  sessionId: string,
): Promise<ProviderSessionSnapshot> {
  if (!sessionId) {
    // The database holds every session, so the id is the only selector.
    throw new Error(
      `An opencode session id is required to read ${databasePath}.`,
    );
  }

  const records = await readSessionRecords(databasePath, sessionId);
  const unknownModels = new Set<string>();
  const breakdowns = toBreakdowns(records.assistants, unknownModels);
  breakdowns.sort((a, b) => b.cost - a.cost);

  return {
    sessionData: buildSessionUsage({
      provider: "opencode",
      sessionId: records.session.id,
      modelBreakdowns: breakdowns,
      sourceFingerprint: await fingerprintSessionTree(databasePath, sessionId),
    }),
    transcriptData: toTranscript(records),
    unknownModels: [...unknownModels],
  };
}

function toBreakdowns(
  assistants: OpencodeAssistantMessage[],
  unknownModels: Set<string>,
): ModelBreakdown[] {
  const totals = new Map<string, ModelTotals>();
  for (const message of assistants) {
    if (!message.modelId) continue;
    const model = normalizeModelId(message.modelId);
    const current = totals.get(model) || {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      hostCost: 0,
    };
    current.inputTokens += message.inputTokens;
    current.outputTokens += message.outputTokens;
    current.cacheCreationTokens += message.cacheWriteTokens;
    current.cacheReadTokens += message.cacheReadTokens;
    current.hostCost += message.cost;
    totals.set(model, current);
  }

  return [...totals].map(([model, tokens]) => ({
    modelName: model,
    displayName: displayModelName(model),
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    cacheCreationTokens: tokens.cacheCreationTokens,
    cacheReadTokens: tokens.cacheReadTokens,
    cost: costOf(model, tokens, unknownModels),
  }));
}

/**
 * Price from our own tables first so one model costs the same whichever host
 * produced it. opencode's recorded cost is the fallback, not the default: it
 * is a list-price estimate from the catalog opencode happened to have, and
 * letting it win would make the same model bill differently per host.
 *
 * A model neither our tables nor opencode can price is surfaced as unknown so
 * it reads as unpriced rather than as free.
 */
function costOf(
  model: string,
  tokens: ModelTotals,
  unknownModels: Set<string>,
): number {
  const pricing = priceFor(model);
  if (pricing) {
    return (
      tokens.inputTokens * pricing.input +
      tokens.outputTokens * pricing.output +
      tokens.cacheCreationTokens * pricing.cacheWrite +
      tokens.cacheReadTokens * pricing.cacheRead
    ) / 1_000_000;
  }
  if (tokens.hostCost > 0) return tokens.hostCost;
  unknownModels.add(model);
  return 0;
}

function toTranscript(records: OpencodeSessionRecords): ParsedTranscript {
  const { session, assistants, userMessageCount } = records;
  const firstPrompt = truncate(records.firstPrompt) ||
    session.title ||
    "No prompt available";
  const cwd = session.directory || undefined;
  const startTime = safeDate(session.timeCreated);
  const endTime = safeDate(session.timeUpdated, startTime);

  return {
    sessionSlug: session.slug || slugify(firstPrompt, session.id),
    firstPrompt,
    startTime,
    endTime,
    userMessageCount,
    assistantMessageCount: assistants.length,
    totalMessages: userMessageCount + assistants.length,
    cwd,
  };
}

function truncate(value: string): string {
  const normalized = value.trim();
  return normalized.length <= 100
    ? normalized
    : normalized.slice(0, 100).trim() + "...";
}

function slugify(prompt: string, fallbackSessionId: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return slug || fallbackSessionId.slice(0, 8) || "unknown-session";
}

function safeDate(value: number, fallback = new Date()): Date {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date;
}
