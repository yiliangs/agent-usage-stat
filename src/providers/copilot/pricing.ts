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
export function normalizeModelId(model: string): string {
  const dottedClaude = model
    .trim()
    .toLowerCase()
    .replace(/^(claude-[a-z]+-\d+)\.(\d+)/, "$1-$2")
    .replace(/^(claude-\d+)\.(\d+)/, "$1-$2");
  return normalizeSharedModelId(dottedClaude);
}

export function priceFor(model: string) {
  return sharedPriceFor(normalizeModelId(model));
}

export function displayModelName(model: string): string {
  return sharedDisplayModelName(normalizeModelId(model));
}

export function pricingFingerprintSource(): string {
  return sharedPricingFingerprintSource();
}
