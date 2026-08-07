/**
 * Per-million-token pricing for Anthropic Claude models (USD).
 *
 * Verified against ccusage output 2026-05-19: a real Opus 4.7 session
 * with 9,495 in / 6,185 out / 132,921 cache-create / 1,854,610 cache-read
 * cost $1.960 — exactly matches input×$5 + output×$25 + cacheWrite×$6.25
 * + cacheRead×$0.50 per million.
 *
 * Cache write here is the 5-minute TTL rate (1.25× input). The transcript
 * JSONL reports cache_creation_input_tokens as a single field with no TTL
 * distinction, so 1-hour cache writes (2× input) get priced as 5-minute.
 * The discrepancy is bounded — a session that exclusively uses 1h caching
 * would underbill by up to ~12% of the cache-write cost (typically <2% of
 * total session cost).
 *
 * Claude Code can also route requests to GPT models. Those IDs reuse the
 * canonical OpenAI table under providers/codex so the same model never drifts
 * to different rates depending on which host tool produced the transcript.
 * Unknown models bill at $0 and emit a pricing-miss warning to hook.log.
 */
import {
  LONG_CONTEXT_THRESHOLD,
  priceFor as openAiPriceFor,
  pricingFingerprintSource as openAiPricingFingerprintSource,
} from "../codex/pricing.js";

export interface ModelPricing {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  longInput?: number;
  longOutput?: number;
  longCacheWrite?: number;
  longCacheRead?: number;
}

const PRICING: Record<string, ModelPricing> = {
  // Current generation (July 2026)
  // Fable 5 is the top tier above Opus at $10/$50 per MTok.
  "claude-fable-5":     { input: 10, output: 50, cacheWrite: 12.50, cacheRead: 1.00 },
  "claude-opus-5":      { input: 5,  output: 25, cacheWrite: 6.25, cacheRead: 0.50 },
  "claude-opus-4-8":    { input: 5,  output: 25, cacheWrite: 6.25, cacheRead: 0.50 },
  "claude-opus-4-7":    { input: 5,  output: 25, cacheWrite: 6.25, cacheRead: 0.50 },
  "claude-sonnet-5":    { input: 3,  output: 15, cacheWrite: 3.75, cacheRead: 0.30 },
  "claude-sonnet-4-6":  { input: 3,  output: 15, cacheWrite: 3.75, cacheRead: 0.30 },
  "claude-haiku-4-5":   { input: 1,  output: 5,  cacheWrite: 1.25, cacheRead: 0.10 },

  // Prior generation — still appears in older transcripts.
  // Opus dropped to $5/$25 at the 4.5 launch (Nov 2025); only 4.1 and
  // earlier carry the old $15/$75 rate.
  "claude-opus-4-6":    { input: 5,  output: 25, cacheWrite: 6.25,  cacheRead: 0.50 },
  "claude-opus-4-5":    { input: 5,  output: 25, cacheWrite: 6.25,  cacheRead: 0.50 },
  "claude-sonnet-4-5":  { input: 3,  output: 15, cacheWrite: 3.75,  cacheRead: 0.30 },
  "claude-opus-4-1":    { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.50 },
  "claude-opus-4-0":    { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.50 },
  "claude-opus-4":      { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.50 },
  "claude-sonnet-4-0":  { input: 3,  output: 15, cacheWrite: 3.75,  cacheRead: 0.30 },
  "claude-sonnet-4":    { input: 3,  output: 15, cacheWrite: 3.75,  cacheRead: 0.30 },

  // Legacy
  "claude-3-7-sonnet":  { input: 3,    output: 15,   cacheWrite: 3.75, cacheRead: 0.30 },
  "claude-3-5-sonnet":  { input: 3,    output: 15,   cacheWrite: 3.75, cacheRead: 0.30 },
  "claude-3-5-haiku":   { input: 0.80, output: 4,    cacheWrite: 1.00, cacheRead: 0.08 },
  "claude-3-opus":      { input: 15,   output: 75,   cacheWrite: 18.75, cacheRead: 1.50 },
  "claude-3-haiku":     { input: 0.25, output: 1.25, cacheWrite: 0.30,  cacheRead: 0.03 },
};

/** Fast-mode premium by model; usage.speed is authoritative per response. */
const FAST_MODE_MULTIPLIERS: Record<string, number> = {
  "claude-opus-5": 2,
  "claude-opus-4-8": 2,
  // Historical Fast requests retain the rate that applied while supported.
  "claude-opus-4-7": 6,
  "claude-opus-4-6": 6,
};

/** Stable input for transcript fingerprints; changes automatically with rates. */
export function pricingFingerprintSource(): string {
  return JSON.stringify({
    longContextThreshold: LONG_CONTEXT_THRESHOLD,
    anthropic: PRICING,
    fastModeMultipliers: FAST_MODE_MULTIPLIERS,
    openAi: openAiPricingFingerprintSource(),
  });
}

/**
 * Anthropic model IDs come in three flavors:
 *   - Alias:           "claude-opus-5"
 *   - Snapshot:        "claude-haiku-4-5-20251001"
 *   - Context variant: "claude-opus-5[1m]" (1M-context routing with the same
 *     standard pricing and no long-context premium)
 * Strip the bracket suffix first, then an 8-digit date suffix, so every
 * shape resolves to the same table entry. Without the bracket strip, [1m]
 * sessions fail the lookup and silently bill at $0.
 */
export function normalizeModelId(model: string): string {
  return model
    .replace(/\[[^\]]*\]$/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-\d{4}-\d{2}-\d{2}$/, "");
}

/**
 * Look up pricing for any model that can appear in a Claude Code transcript.
 * GPT cache creations use OpenAI's cache-write rate; cache reads use the
 * discounted cached-input rate.
 */
export function priceFor(model: string): ModelPricing | null {
  const normalized = normalizeModelId(model);
  const anthropic = PRICING[normalized];
  if (anthropic) return anthropic;

  const openAi = openAiPriceFor(normalized);
  if (!openAi) return null;

  return {
    input: openAi.input,
    output: openAi.output,
    cacheWrite: openAi.cacheWrite ?? openAi.input,
    cacheRead: openAi.cachedInput,
    longInput: openAi.longInput,
    longOutput: openAi.longOutput,
    longCacheWrite: openAi.longCacheWrite ?? openAi.longInput,
    longCacheRead: openAi.longCachedInput,
  };
}

export function priceMultiplierForSpeed(model: string, speed?: string): number {
  if (speed !== "fast") return 1;
  return FAST_MODE_MULTIPLIERS[normalizeModelId(model)] ?? 1;
}

/** Apply OpenAI's full-request long-context premium when the model has one. */
export function priceForRequest(
  model: string,
  inputTokens: number,
): ModelPricing | null {
  const pricing = priceFor(model);
  if (
    !pricing ||
    inputTokens <= LONG_CONTEXT_THRESHOLD ||
    pricing.longInput === undefined ||
    pricing.longOutput === undefined ||
    pricing.longCacheWrite === undefined ||
    pricing.longCacheRead === undefined
  ) {
    return pricing;
  }

  return {
    input: pricing.longInput,
    output: pricing.longOutput,
    cacheWrite: pricing.longCacheWrite,
    cacheRead: pricing.longCacheRead,
  };
}
