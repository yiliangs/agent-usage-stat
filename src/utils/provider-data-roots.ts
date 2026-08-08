import { join, resolve } from "node:path";
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
  provider: ProviderName;
  label: string;
  environmentVariable: string;
  defaultDirectory: string;
}

const DEFINITIONS: readonly ProviderDataRootDefinition[] = [
  {
    provider: "claude",
    label: "Claude Code",
    environmentVariable: "CLAUDE_CONFIG_DIR",
    defaultDirectory: ".claude",
  },
  {
    provider: "codex",
    label: "Codex",
    environmentVariable: "CODEX_HOME",
    defaultDirectory: ".codex",
  },
  {
    provider: "copilot",
    label: "Copilot CLI",
    environmentVariable: "COPILOT_HOME",
    defaultDirectory: ".copilot",
  },
];

export function resolveProviderDataRoot(
  provider: ProviderName,
  config: Pick<AppConfig, "providerDataRoots"> = {},
  environment: NodeJS.ProcessEnv = process.env,
  home = homeDir(),
): ResolvedProviderDataRoot {
  const definition = DEFINITIONS.find((item) => item.provider === provider);
  if (!definition) throw new Error(`Unsupported provider: ${provider}`);

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
  return DEFINITIONS.map((item) =>
    resolveProviderDataRoot(item.provider, config, environment, home)
  );
}
