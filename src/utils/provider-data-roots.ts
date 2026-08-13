import { join, resolve } from "node:path";
import {
  isProviderName,
  PROVIDER_NAMES,
} from "../core/provider-definition.js";
import type { AppConfig } from "../types/config.js";
import type { ProviderName } from "../types/provider.js";
import { expandHome, homeDir } from "./paths.js";

export type ProviderDataRootSource = "custom" | "environment" | "default";

export interface ResolvedProviderDataRoot {
  provider: ProviderName;
  label: string;
  root: string;
  source: ProviderDataRootSource;
  environmentVariable: string;
}

interface ProviderDataRootDefinition {
  label: string;
  environmentVariable: string;
  defaultDirectory: string;
}

const DEFINITIONS = {
  claude: {
    label: "Claude Code",
    environmentVariable: "CLAUDE_CONFIG_DIR",
    defaultDirectory: ".claude",
  },
  codex: {
    label: "Codex",
    environmentVariable: "CODEX_HOME",
    defaultDirectory: ".codex",
  },
  copilot: {
    label: "Copilot CLI",
    environmentVariable: "COPILOT_HOME",
    defaultDirectory: ".copilot",
  },
} satisfies Record<ProviderName, ProviderDataRootDefinition>;

export function resolveProviderDataRoot(
  provider: ProviderName,
  config: Pick<AppConfig, "providerDataRoots"> = {},
  environment: NodeJS.ProcessEnv = process.env,
  home = homeDir(),
): ResolvedProviderDataRoot {
  if (!isProviderName(provider)) {
    throw new Error(`Unsupported provider: ${String(provider)}`);
  }
  const definition = DEFINITIONS[provider];

  const custom = config.providerDataRoots?.[provider]?.trim();
  const fromEnvironment = environment[definition.environmentVariable]?.trim();
  const value = custom || fromEnvironment || join(home, definition.defaultDirectory);
  const source: ProviderDataRootSource = custom
    ? "custom"
    : fromEnvironment
      ? "environment"
      : "default";

  return {
    provider,
    label: definition.label,
    root: resolve(expandHome(value)),
    source,
    environmentVariable: definition.environmentVariable,
  };
}

export function resolveProviderDataRoots(
  config: Pick<AppConfig, "providerDataRoots"> = {},
  environment: NodeJS.ProcessEnv = process.env,
  home = homeDir(),
): ResolvedProviderDataRoot[] {
  return PROVIDER_NAMES.map((provider) =>
    resolveProviderDataRoot(provider, config, environment, home)
  );
}
