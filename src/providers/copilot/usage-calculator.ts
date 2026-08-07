import { existsSync } from "fs";
import { expandHome } from "../../utils/paths.js";
import type { ModelBreakdown, SessionUsage } from "../../types/session.js";
import type {
  CopilotModelMetric,
  CopilotSessionShutdown,
} from "./transcript-format.js";
import { readCopilotEvents } from "./transcript-reader.js";
import {
  displayModelName,
  normalizeModelId,
  priceFor,
} from "./pricing.js";
import { fingerprintTranscriptFile } from "./transcript-fingerprint.js";

interface TokenTotals {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export class UsageCalculator {
  private unknownModels = new Set<string>();

  async calculate(path: string, fallbackId: string): Promise<SessionUsage> {
    this.unknownModels.clear();
    const expanded = expandHome(path);
    if (!existsSync(expanded)) {
      throw new Error(`Transcript file not found: ${path}`);
    }

    const events = await readCopilotEvents(expanded);
    const start = events.find((event) => event.type === "session.start");
    const shutdown = [...events]
      .reverse()
      .find((event) => event.type === "session.shutdown");
    if (!shutdown?.data) {
      throw new Error(`Copilot session is not complete: ${fallbackId}`);
    }

    const sessionId = stringValue(start?.data, "sessionId") || fallbackId;
    const metrics = (shutdown.data as CopilotSessionShutdown).modelMetrics || {};
    const breakdowns = Object.entries(metrics).map(([rawModel, metric]) =>
      this.toBreakdown(rawModel, metric),
    );
    breakdowns.sort((a, b) => b.cost - a.cost);

    const sum = (pick: (item: ModelBreakdown) => number): number =>
      breakdowns.reduce((total, item) => total + pick(item), 0);
    const inputTokens = sum((item) => item.inputTokens);
    const outputTokens = sum((item) => item.outputTokens);
    const cacheCreationTokens = sum((item) => item.cacheCreationTokens || 0);
    const cacheReadTokens = sum((item) => item.cacheReadTokens || 0);

    return {
      provider: "copilot",
      sessionId,
      inputTokens,
      outputTokens,
      cacheCreationTokens,
      cacheReadTokens,
      totalTokens:
        inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens,
      totalCost: sum((item) => item.cost),
      modelsUsed: breakdowns.map((item) => item.modelName),
      modelBreakdowns: breakdowns,
      sourceFingerprint: await fingerprintTranscriptFile(expanded),
    };
  }

  getUnknownModels(): string[] {
    return [...this.unknownModels];
  }

  private toBreakdown(rawModel: string, metric: CopilotModelMetric): ModelBreakdown {
    const model = normalizeModelId(rawModel);
    const tokens = tokenTotals(metric);
    const pricing = priceFor(model);
    const nativeCost = nativeUsdCost(metric.totalNanoAiu);
    if (nativeCost === null && !pricing) this.unknownModels.add(model);
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
