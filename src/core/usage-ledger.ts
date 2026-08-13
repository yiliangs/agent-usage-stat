import type { ModelVendor } from "./model-vendor.js";

/** Application-owned directory containing one persisted record per session. */
export const LOGBOOK_SHARD_DIR = "logbook.d";

/** Persisted JSON shape for one captured agent session. */
export interface LogbookRecord {
  timestamp: string;
  session_slug: string;
  session_id: string;
  project: string;
  branch: string;
  cwd: string;
  machine: string;
  start_time: string;
  end_time: string;
  duration_seconds: number;
  duration_human: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
  models: string[];
  /**
   * Per-model tokens, cost, and vendor. Shards written before 2026-07-20 omit
   * this field, so readers must retain their legacy model-name fallback.
   */
  model_breakdowns?: LogbookModelRecord[];
  /** Turn-scoped slices for accurate time attribution. Older shards omit it. */
  turns?: LogbookTurnRecord[];
  /** Fingerprint of the provider transcript used to build this snapshot. */
  source_fingerprint?: string;
  /**
   * Host tool that produced the session. Shards written before 2026-07-09 omit
   * this field, so readers default it to "claude".
   */
  provider: string;
}

export interface LogbookModelRecord {
  model: string;
  vendor: ModelVendor;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
}

export interface LogbookTurnRecord {
  turn_id: string;
  start_time: string;
  end_time: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
  models: string[];
}
