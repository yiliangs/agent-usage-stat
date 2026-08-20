import {
  normalizeModelId as normalizeSharedModelId,
  priceFor as sharedPriceFor,
  pricingFingerprintSource as sharedPricingFingerprintSource,
} from "../claude/pricing.js";
import { displayModelName as sharedDisplayModelName } from "../claude/model-names.js";

/**
 * opencode names models by their maker's own id (`claude-sonnet-4-5`,
 * `gpt-5.4`), which is exactly the shape the shared tables are keyed by, so
 * normalization is the shared rule and nothing more. The host's `providerID`
 * is routing — `mock`, `github-copilot`, `openrouter` — and never selects a
 * price table.
 */
export function normalizeModelId(model: string): string {
  return normalizeSharedModelId(model.trim().toLowerCase());
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
