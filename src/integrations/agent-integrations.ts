import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ProviderName } from "../types/provider.js";
import type { AppConfig } from "../types/config.js";
import { homeDir } from "../utils/paths.js";
import { resolveProviderDataRoots } from "../utils/provider-data-roots.js";
import {
  inspectClaudeHook,
  installClaudeHook,
  removeClaudeHook,
} from "./claude-hooks.js";
import {
  inspectCodexHooks,
  installCodexHooks,
  removeCodexHooks,
} from "./codex-hooks.js";
import {
  inspectCopilotHook,
  installCopilotHook,
  removeCopilotHook,
} from "./copilot-hooks.js";
import type { HookConfigurationStatus } from "./hook-status.js";

export interface AgentIntegration {
  provider: ProviderName;
  label: string;
  isInstalled(): boolean;
  inspect(): Promise<HookConfigurationStatus>;
  install(): Promise<{ needsTrust: boolean }>;
  remove(): Promise<void>;
}

type CommandExists = (command: string) => boolean;

/** The single registry for host detection, hook locations, and hook lifecycle. */
export function createAgentIntegrations(
  home = homeDir(),
  commandExists: CommandExists = hasCommand,
  environment: NodeJS.ProcessEnv = process.env,
  config: Pick<AppConfig, "providerDataRoots"> = {},
): AgentIntegration[] {
  const roots = resolveProviderDataRoots(config, environment, home);
  const rootFor = (provider: ProviderName) =>
    roots.find((item) => item.provider === provider)?.root || "";
  const claudeHome = rootFor("claude");
  const codexHome = rootFor("codex");
  const copilotHome = rootFor("copilot");
  const claudeSettings = join(claudeHome, "settings.json");
  const codexHooks = join(codexHome, "hooks.json");
  const copilotHooks = join(copilotHome, "hooks", "agent-usage-stat.json");

  return [
    {
      provider: "claude",
      label: "Claude Code",
      isInstalled: () => existsSync(claudeHome) || commandExists("claude"),
      inspect: () => inspectClaudeHook(claudeSettings),
      install: async () => {
        await installClaudeHook(claudeSettings);
        return { needsTrust: false };
      },
      remove: () => removeClaudeHook(claudeSettings),
    },
    {
      provider: "codex",
      label: "Codex",
      isInstalled: () => existsSync(codexHome) || commandExists("codex"),
      inspect: () => inspectCodexHooks(codexHooks),
      install: async () => ({
        needsTrust: await installCodexHooks(codexHooks),
      }),
      remove: () => removeCodexHooks(codexHooks),
    },
    {
      provider: "copilot",
      label: "GitHub Copilot CLI",
      isInstalled: () => existsSync(copilotHome) || commandExists("copilot"),
      inspect: () => inspectCopilotHook(copilotHooks),
      install: async () => {
        await installCopilotHook(copilotHooks);
        return { needsTrust: false };
      },
      remove: () => removeCopilotHook(copilotHooks),
    },
  ];
}

export function detectInstalledAgents(
  home = homeDir(),
  commandExists: CommandExists = hasCommand,
  environment: NodeJS.ProcessEnv = process.env,
  config: Pick<AppConfig, "providerDataRoots"> = {},
): ProviderName[] {
  return createAgentIntegrations(home, commandExists, environment, config)
    .filter((integration) => integration.isInstalled())
    .map((integration) => integration.provider);
}

function hasCommand(command: string): boolean {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  return spawnSync(locator, [command], {
    stdio: "ignore",
    timeout: 1500,
    windowsHide: true,
  }).status === 0;
}
