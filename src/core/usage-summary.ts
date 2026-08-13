import type {
  ModelBreakdown,
  SessionUsage,
  TurnUsage,
} from "../types/session.js";

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  totalCost: number;
}

/** Derive every aggregate field from the authoritative per-model slices. */
export function summarizeModelBreakdowns(
  modelBreakdowns: readonly ModelBreakdown[],
): UsageTotals {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  let totalCost = 0;

  for (const breakdown of modelBreakdowns) {
    inputTokens += breakdown.inputTokens;
    outputTokens += breakdown.outputTokens;
    cacheCreationTokens += breakdown.cacheCreationTokens;
    cacheReadTokens += breakdown.cacheReadTokens;
    totalCost += breakdown.cost;
  }

  return {
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    totalTokens:
      inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens,
    totalCost,
  };
}

export function buildSessionUsage(
  data: Pick<
    SessionUsage,
    "provider" | "sessionId" | "turns" | "sourceFingerprint"
  > & { modelBreakdowns: ModelBreakdown[] },
): SessionUsage {
  const totals = summarizeModelBreakdowns(data.modelBreakdowns);
  return {
    provider: data.provider,
    sessionId: data.sessionId,
    ...totals,
    modelBreakdowns: data.modelBreakdowns,
    turns: data.turns,
    sourceFingerprint: data.sourceFingerprint,
  };
}

export function buildTurnUsage(
  data: Pick<TurnUsage, "id" | "startTime" | "endTime"> & {
    modelBreakdowns: ModelBreakdown[];
  },
): TurnUsage {
  const totals = summarizeModelBreakdowns(data.modelBreakdowns);
  return {
    id: data.id,
    startTime: data.startTime,
    endTime: data.endTime,
    ...totals,
    modelBreakdowns: data.modelBreakdowns,
  };
}
