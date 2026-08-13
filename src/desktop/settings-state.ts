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
import type {
  ProviderName,
  SessionProvider,
} from "../types/provider.js";
import {
  readCaptureHealth,
} from "../utils/capture-health.js";
import {
  captureMonitor,
  type CaptureMonitor,
} from "./capture-monitor.js";
import {
  createAgentIntegrations,
  type AgentIntegration,
} from "../integrations/agent-integrations.js";

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
  captureMonitor: CaptureMonitor;
}

export interface DesktopSettingsState {
  ledger: ResolvedUsageRoot;
  capturePolicy: CapturePolicy;
  providers: ProviderLocationSetting[];
}

export interface DesktopSettingsDependencies {
  providers?: readonly SessionProvider[];
  integrations?: readonly AgentIntegration[];
}

export async function buildDesktopSettingsState(
  config: AppConfig,
  ledger: ResolvedUsageRoot,
  environment: NodeJS.ProcessEnv = process.env,
  home = homeDir(),
  dependencies: DesktopSettingsDependencies = {},
): Promise<DesktopSettingsState> {
  const roots = resolveProviderDataRoots(config, environment, home);
  const providers = dependencies.providers ??
    allProviders(config, environment, home);
  const integrations = dependencies.integrations ??
    createAgentIntegrations(home, () => false, environment, config);
  const providersByName = new Map(
    providers.map((provider) => [provider.name, provider]),
  );
  const integrationsByName = new Map(
    integrations.map((integration) => [integration.provider, integration]),
  );
  const locations = await Promise.all(roots.map(async (root) => {
    const provider = requireProvider(providersByName, root.provider);
    const integration = requireProvider(integrationsByName, root.provider);
    let sessions = 0;
    try {
      sessions = (await provider.findAllSessions()).length;
    } catch {
      // A settings diagnostic must not prevent the page from opening.
    }
    const strategy = resolvedCaptureStrategy(config, root.provider);
    const available = existsSync(root.root);
    const [observation, hookConfiguration] = await Promise.all([
      readCaptureHealth(root.provider, environment),
      integration.inspect(),
    ]);
    return {
      ...root,
      available,
      sessions,
      captureStrategy: strategy,
      captureOverride: config.capturePolicy?.providers?.[root.provider] !== undefined,
      captureMonitor: captureMonitor(
        strategy,
        available,
        hookConfiguration,
        observation,
      ),
    };
  }));

  return {
    ledger,
    capturePolicy: resolvedCapturePolicy(config),
    providers: locations,
  };
}

function requireProvider<T>(
  items: ReadonlyMap<ProviderName, T>,
  provider: ProviderName,
): T {
  const item = items.get(provider);
  if (!item) {
    throw new Error(`Missing desktop settings collaborator: ${provider}`);
  }
  return item;
}
