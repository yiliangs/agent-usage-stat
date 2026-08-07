import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ProviderName } from "../types/provider.js";
import { homeDir } from "../utils/paths.js";
import { installClaudeHook, removeClaudeHook } from "./claude-hooks.js";
import { installCodexHooks, removeCodexHooks } from "./codex-hooks.js";
import { installCopilotHook, removeCopilotHook } from "./copilot-hooks.js";

export interface AgentIntegration {
  provider: ProviderName;
  label: string;
  isInstalled(): boolean;
  install(): Promise<{ needsTrust: boolean }>;
  remove(): Promise<void>;
}

type CommandExists = (command: string) => boolean;

/** The single registry for host detection, hook locations, and hook lifecycle. */
export function createAgentIntegrations(
  home = homeDir(),
  commandExists: CommandExists = hasCommand,
  environment: NodeJS.ProcessEnv = process.env,
): AgentIntegration[] {
  const claudeHome = environment.CLAUDE_CONFIG_DIR || join(home, ".claude");
  const codexHome = environment.CODEX_HOME || join(home, ".codex");
  const copilotHome = environment.COPILOT_HOME || join(home, ".copilot");
  const claudeSettings = join(claudeHome, "settings.json");
  const codexHooks = join(codexHome, "hooks.json");
  const copilotHooks = join(copilotHome, "hooks", "agent-usage-stat.json");

  return [
    {
      provider: "claude",
      label: "Claude Code",
      isInstalled: () => existsSync(claudeHome) || commandExists("claude"),
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
      install: async () => ({
        needsTrust: await installCodexHooks(codexHooks),
      }),
      remove: () => removeCodexHooks(codexHooks),
    },
    {
      provider: "copilot",
      label: "GitHub Copilot CLI",
      isInstalled: () => existsSync(copilotHome) || commandExists("copilot"),
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
): ProviderName[] {
  return createAgentIntegrations(home, commandExists, environment)
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
