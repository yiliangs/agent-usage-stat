import { existsSync } from "node:fs";
import type { AppConfig } from "../types/config.js";
import { resolvedCaptureMode } from "../types/config.js";
import { allProviders } from "../providers/registry.js";
import type { ResolvedUsageRoot } from "../utils/usage-root.js";
import {
  resolveProviderDataRoots,
  type ProviderDataRootSource,
} from "../utils/provider-data-roots.js";
import { homeDir } from "../utils/paths.js";
import type { ProviderName } from "../types/provider.js";

export interface ProviderLocationSetting {
  provider: ProviderName;
  label: string;
  root: string;
  source: ProviderDataRootSource;
  environmentVariable: string;
  available: boolean;
  sessions: number;
}

export interface DesktopSettingsState {
  ledger: ResolvedUsageRoot;
  captureMode: "automatic" | "on-open";
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
    return {
      ...root,
      available: existsSync(root.root),
      sessions,
    };
  }));

  return {
    ledger,
    captureMode: resolvedCaptureMode(config),
    providers: locations,
  };
}
