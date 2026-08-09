import type { ProviderName } from "./provider.js";

export type CaptureStrategy = "continuous" | "batch";

export interface CapturePolicy {
  default: CaptureStrategy;
  providers?: Partial<Record<ProviderName, CaptureStrategy>>;
}

export interface AppConfig {
  version: string;
  /**
   * Directory containing the per-session `logbook.d/` usage shards.
   * A leading `~` is expanded to the home directory. Set this to a synced
   * folder to combine usage from several machines.
   */
  dataRoot?: string;
  /** Default capture strategy plus optional per-provider overrides. */
  capturePolicy?: CapturePolicy;
  /** Explicit provider state roots; omitted providers resolve automatically. */
  providerDataRoots?: Partial<Record<ProviderName, string>>;
}

export const DEFAULT_CONFIG: AppConfig = {
  version: "2.0.0",
  capturePolicy: { default: "continuous" },
};

export function resolvedCaptureStrategy(
  config: Pick<AppConfig, "capturePolicy">,
  provider?: ProviderName,
): CaptureStrategy {
  const defaultStrategy = config.capturePolicy?.default === "batch"
    ? "batch"
    : "continuous";
  if (!provider) return defaultStrategy;
  return config.capturePolicy?.providers?.[provider] ?? defaultStrategy;
}

export function resolvedCapturePolicy(
  config: Pick<AppConfig, "capturePolicy">,
): CapturePolicy {
  const providers = config.capturePolicy?.providers;
  return {
    default: resolvedCaptureStrategy(config),
    ...(providers && Object.keys(providers).length > 0 ? { providers } : {}),
  };
}
