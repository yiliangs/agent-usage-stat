import { existsSync } from "fs";
import { basename } from "path";
import type { ProviderSessionSnapshot } from "../../types/provider.js";
import type { ModelBreakdown } from "../../types/session.js";
import type { ParsedTranscript } from "../../types/transcript.js";
import { expandHome } from "../../utils/paths.js";
import { buildSessionUsage } from "../../core/usage-summary.js";
import {
  displayModelName,
  normalizeModelId,
  priceFor,
} from "./pricing.js";
import type {
  CopilotEvent,
  CopilotModelMetric,
  CopilotSessionShutdown,
  CopilotSessionStart,
} from "./transcript-format.js";
import { fingerprintTranscriptFile } from "./transcript-fingerprint.js";
import { readCopilotEvents } from "./transcript-reader.js";

interface TokenTotals {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/** Derive Copilot billing and metadata from one isolated JSONL event set. */
export async function readCopilotSnapshot(
  path: string,
  fallbackSessionId: string,
): Promise<ProviderSessionSnapshot> {
  const expanded = expandHome(path);
  if (!existsSync(expanded)) {
    throw new Error(`Transcript file not found: ${path}`);
  }

  const events = await readCopilotEvents(expanded);
  const startEvent = events.find((event) => event.type === "session.start");
  const shutdownEvent = [...events]
    .reverse()
    .find((event) => event.type === "session.shutdown");
  if (!shutdownEvent?.data) {
    throw new Error(`Copilot session is not complete: ${fallbackSessionId}`);
  }

  const sessionId = stringValue(startEvent?.data, "sessionId") || fallbackSessionId;
  const metrics = (shutdownEvent.data as CopilotSessionShutdown).modelMetrics || {};
  const unknownModels = new Set<string>();
  const breakdowns = Object.entries(metrics).map(([rawModel, metric]) =>
    toBreakdown(rawModel, metric, unknownModels),
  );
  breakdowns.sort((a, b) => b.cost - a.cost);

  return {
    sessionData: buildSessionUsage({
      provider: "copilot",
      sessionId,
      modelBreakdowns: breakdowns,
      sourceFingerprint: await fingerprintTranscriptFile(expanded),
    }),
    transcriptData: toTranscript(events, sessionId),
    unknownModels: [...unknownModels],
  };
}

function toBreakdown(
  rawModel: string,
  metric: CopilotModelMetric,
  unknownModels: Set<string>,
): ModelBreakdown {
  const model = normalizeModelId(rawModel);
  const tokens = tokenTotals(metric);
  const pricing = priceFor(model);
  const nativeCost = nativeUsdCost(metric.totalNanoAiu);
  if (nativeCost === null && !pricing) unknownModels.add(model);
  const cost =
    nativeCost ??
    (pricing
      ? (tokens.input * pricing.input +
          tokens.output * pricing.output +
          tokens.cacheWrite * pricing.cacheWrite +
          tokens.cacheRead * pricing.cacheRead) /
        1_000_000
      : 0);
  return {
    modelName: model,
    displayName: displayModelName(model),
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    cacheCreationTokens: tokens.cacheWrite,
    cacheReadTokens: tokens.cacheRead,
    cost,
  };
}

function toTranscript(
  events: CopilotEvent[],
  fallbackSessionId: string,
): ParsedTranscript {
  const startEvent = events.find((event) => event.type === "session.start");
  const start = (startEvent?.data || {}) as CopilotSessionStart;
  const shutdown = [...events]
    .reverse()
    .find((event) => event.type === "session.shutdown");
  const users = events.filter((event) => event.type === "user.message");
  const assistants = events.filter((event) => event.type === "assistant.message");
  const firstPrompt = promptText(users[0]) || "No prompt available";
  const timestamps = events
    .map((event) => event.timestamp)
    .filter((value): value is string => !!value && !Number.isNaN(Date.parse(value)));
  const startTime = safeDate(start.startTime || startEvent?.timestamp || timestamps[0]);
  const endTime = safeDate(
    shutdown?.timestamp || timestamps[timestamps.length - 1],
    startTime,
  );
  const cwd = start.context?.cwd;

  return {
    sessionSlug: slugify(firstPrompt, fallbackSessionId),
    firstPrompt,
    startTime,
    endTime,
    userMessageCount: users.length,
    assistantMessageCount: assistants.length,
    totalMessages: users.length + assistants.length,
    projectName: cwd ? basename(cwd.replace(/[\\/]+$/, "")) : undefined,
    gitBranch: start.context?.branch,
    cwd,
  };
}

/** GitHub records billionths of one AI Credit; one AI Credit is USD $0.01. */
function nativeUsdCost(totalNanoAiu: unknown): number | null {
  return typeof totalNanoAiu === "number" &&
    Number.isFinite(totalNanoAiu) &&
    totalNanoAiu > 0
    ? totalNanoAiu / 100_000_000_000
    : null;
}

function tokenTotals(metric: CopilotModelMetric): TokenTotals {
  const usage = metric.usage || {};
  const details = metric.tokenDetails;
  const cacheWrite = nonNegative(
    details?.cache_write?.tokenCount ?? usage.cacheWriteTokens,
  );
  const cacheRead = nonNegative(
    details?.cache_read?.tokenCount ?? usage.cacheReadTokens,
  );
  const input = nonNegative(
    details?.input?.tokenCount ??
      nonNegative(usage.inputTokens) - cacheWrite - cacheRead,
  );
  return {
    input,
    output: nonNegative(details?.output?.tokenCount ?? usage.outputTokens),
    cacheWrite,
    cacheRead,
  };
}

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}

function stringValue(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

function promptText(event: CopilotEvent | undefined): string {
  const content = valueAt(event?.data, "content");
  if (typeof content === "string") return truncate(content);
  if (!Array.isArray(content)) return "";
  return truncate(
    content
      .map((part) => valueAt(part, "text"))
      .filter((part): part is string => typeof part === "string")
      .join(" "),
  );
}

function valueAt(value: unknown, key: string): unknown {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)[key]
    : undefined;
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

function safeDate(value: string | undefined, fallback = new Date()): Date {
  const date = value ? new Date(value) : fallback;
  return Number.isNaN(date.getTime()) ? fallback : date;
}
