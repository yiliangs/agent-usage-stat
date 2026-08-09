import { existsSync } from "node:fs";
import type { AppConfig } from "../types/config.js";
import {
  resolvedCapturePolicy,
  resolvedCaptureStrategy,
  type CapturePolicy,
  type CaptureStrategy,
} from "../types/config.js";
import { allProviders } from "../providers/registry.js";
import type { ResolvedUsageRoot } from "../utils/usage-root.js";
import {
  resolveProviderDataRoots,
  type ProviderDataRootSource,
} from "../utils/provider-data-roots.js";
import { homeDir } from "../utils/paths.js";
import type { ProviderName } from "../types/provider.js";
import {
  readCaptureHealth,
  type CaptureHealth,
} from "../utils/capture-health.js";

export interface ProviderLocationSetting {
  provider: ProviderName;
  label: string;
  root: string;
  source: ProviderDataRootSource;
  environmentVariable: string;
  available: boolean;
  sessions: number;
  captureStrategy: CaptureStrategy;
  captureOverride: boolean;
  captureHealth: CaptureHealth | null;
}

export interface DesktopSettingsState {
  ledger: ResolvedUsageRoot;
  capturePolicy: CapturePolicy;
  providers: ProviderLocationSetting[];
}

export async function buildDesktopSettingsState(
  config: AppConfig,
  ledger: ResolvedUsageRoot,
  environment: NodeJS.ProcessEnv = process.env,
  home = homeDir(),
): Promise<DesktopSettingsState> {
  const roots = resolveProviderDataRoots(config, environment, home);
  const providers = allProviders(config, environment, home);
  const locations = await Promise.all(roots.map(async (root, index) => {
    let sessions = 0;
    try {
      sessions = (await providers[index].findAllSessions()).length;
    } catch {
      // A settings diagnostic must not prevent the page from opening.
    }
    const strategy = resolvedCaptureStrategy(config, root.provider);
    const captureHealth = await readCaptureHealth(root.provider, environment);
    return {
      ...root,
      available: existsSync(root.root),
      sessions,
      captureStrategy: strategy,
      captureOverride: config.capturePolicy?.providers?.[root.provider] !== undefined,
      captureHealth,
    };
  }));

  return {
    ledger,
    capturePolicy: resolvedCapturePolicy(config),
    providers: locations,
  };
}
