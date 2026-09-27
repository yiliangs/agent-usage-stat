import {
  normalizeModelId as normalizeSharedModelId,
  priceFor as sharedPriceFor,
  pricingFingerprintSource as sharedPricingFingerprintSource,
} from "../claude/pricing.js";
import { displayModelName as sharedDisplayModelName } from "../claude/model-names.js";

/**
 * Copilot uses dotted Claude versions; the shared tables use hyphenated IDs.
 *
 * The version sits on either side of the family name depending on the
 * generation: `claude-sonnet-4.5` puts it last, `claude-3.5-sonnet` puts it
 * first. Both orderings reach the canonical hyphenated id here, before the
 * shared normalizer runs, or the lookup misses and the session records its
 * tokens at zero cost.
 */
export const DOTTED_CLAUDE_ID_RULES: readonly RegExp[] = [
  /^(claude-[a-z]+-\d+)\.(\d+)/,
  /^(claude-\d+)\.(\d+)/,
];

export function normalizeModelId(model: string): string {
  const dottedClaude = DOTTED_CLAUDE_ID_RULES.reduce(
    (id, rule) => id.replace(rule, "$1-$2"),
    model.trim().toLowerCase(),
  );
  return normalizeSharedModelId(dottedClaude);
}

/**
 * Copilot records `totalNanoAiu`, billionths of one GitHub AI Credit, and one
 * AI Credit is USD $0.01 (GitHub Docs, "GitHub Copilot billing",
 * https://docs.github.com/en/billing/concepts/product-billing/github-copilot-billing).
 * So USD = nanoAIU / (1e9 * 100).
 */
export const NANO_AIU_PER_USD = 1_000_000_000 * 100;

/**
 * The host's own billed figure. It wins over the baked tables for Copilot:
 * `modelMetrics` carry no speed field, so the tables cannot see a Fast premium
 * that the AIU figure already includes. See the pricing invariant in AGENTS.md.
 */
export function nativeUsdCost(totalNanoAiu: unknown): number | null {
  return typeof totalNanoAiu === "number" &&
    Number.isFinite(totalNanoAiu) &&
    totalNanoAiu > 0
    ? totalNanoAiu / NANO_AIU_PER_USD
    : null;
}

export function priceFor(model: string) {
  return sharedPriceFor(normalizeModelId(model));
}

export function displayModelName(model: string): string {
  return sharedDisplayModelName(normalizeModelId(model));
}

/**
 * Stable input for transcript fingerprints. Beyond the shared tables it pins
 * everything that moves a Copilot cost: the AIU-to-USD rate behind the native
 * figure, and the dotted-id rules that decide which table row a model hits.
 */
export function pricingFingerprintSource(): string {
  return JSON.stringify({
    shared: sharedPricingFingerprintSource(),
    nanoAiuPerUsd: NANO_AIU_PER_USD,
    dottedClaudeIds: DOTTED_CLAUDE_ID_RULES.map((rule) => rule.source),
  });
}
