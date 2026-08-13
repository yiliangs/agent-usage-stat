/** Canonical provider identity and iteration order. */
export const PROVIDER_NAMES = ["claude", "codex", "copilot"] as const;

export type ProviderName = (typeof PROVIDER_NAMES)[number];

export function isProviderName(value: unknown): value is ProviderName {
  return typeof value === "string" &&
    (PROVIDER_NAMES as readonly string[]).includes(value);
}
