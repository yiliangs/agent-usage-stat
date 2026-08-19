import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PROVIDER_NAMES } from "../core/provider-definition.js";
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
  /** The file inspect() reads and install() writes, shown to users in repair guidance. */
  hookConfigPath: string;
  /**
   * True when the hook file belongs to this application and install() rewrites
   * it wholesale, so an unparseable file is repairable from the app. False when
   * the file is agent-owned and install() refuses to clobber it.
   */
  ownsHookFile: boolean;
  isInstalled(): boolean;
  inspect(): Promise<HookConfigurationStatus>;
  install(): Promise<{ needsTrust: boolean }>;
  remove(): Promise<void>;
}

type CommandExists = (command: string) => boolean;
type CreateAgentIntegration = (
  root: string,
  commandExists: CommandExists,
) => AgentIntegration;

const INTEGRATIONS = {
  claude: (root, commandExists) => {
    const settings = join(root, "settings.json");
    return {
      provider: "claude",
      label: "Claude Code",
      hookConfigPath: settings,
      ownsHookFile: false,
      isInstalled: () => existsSync(root) || commandExists("claude"),
      inspect: () => inspectClaudeHook(settings),
      install: async () => {
        await installClaudeHook(settings);
        return { needsTrust: false };
      },
      remove: () => removeClaudeHook(settings),
    };
  },
  codex: (root, commandExists) => {
    const hooks = join(root, "hooks.json");
    return {
      provider: "codex",
      label: "Codex",
      hookConfigPath: hooks,
      ownsHookFile: false,
      isInstalled: () => existsSync(root) || commandExists("codex"),
      inspect: () => inspectCodexHooks(hooks),
      install: async () => ({
        needsTrust: await installCodexHooks(hooks),
      }),
      remove: () => removeCodexHooks(hooks),
    };
  },
  copilot: (root, commandExists) => {
    const hooks = join(root, "hooks", "agent-usage-stat.json");
    return {
      provider: "copilot",
      label: "GitHub Copilot CLI",
      hookConfigPath: hooks,
      ownsHookFile: true,
      isInstalled: () => existsSync(root) || commandExists("copilot"),
      inspect: () => inspectCopilotHook(hooks),
      install: async () => {
        await installCopilotHook(hooks);
        return { needsTrust: false };
      },
      remove: () => removeCopilotHook(hooks),
    };
  },
} satisfies Record<ProviderName, CreateAgentIntegration>;

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
  return PROVIDER_NAMES.map((provider) =>
    INTEGRATIONS[provider](rootFor(provider), commandExists)
  );
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
