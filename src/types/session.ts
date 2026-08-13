// Session usage shape consumed by the shard writer and portal.
// Produced by a provider (src/types/provider.ts) — provider-neutral on the
// way out: renderers and the logbook writer never branch on the provider.

import type { ProviderName } from "../core/provider-definition.js";

export type { ProviderName };

export interface ModelBreakdown {
  /** Normalized model id — aggregation key, logbook `models` entry. */
  modelName: string;
  /** Human-readable name supplied by the provider. */
  displayName: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  cost: number;
}

/** One turn-scoped usage slice. Session totals remain the sum of these slices. */
export interface TurnUsage {
  id: string;
  startTime: string;
  endTime: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  totalCost: number;
  modelBreakdowns: ModelBreakdown[];
}

export interface SessionUsage {
  provider: ProviderName;
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  totalCost: number;
  modelBreakdowns: ModelBreakdown[];
  turns?: TurnUsage[];
  /** Provider-source fingerprint used for idempotent reconciliation. */
  sourceFingerprint: string;
}
