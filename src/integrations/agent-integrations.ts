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
import {
  inspectOpencodeHook,
  installOpencodeHook,
  removeOpencodeHook,
} from "./opencode-hooks.js";
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

/**
 * Two roots, because a host may read its sessions from one directory and load
 * its hooks from another. opencode does: sessions live under its XDG data
 * directory and plugins under its XDG config directory. For every other host
 * the two are the same path and nothing below can tell the difference.
 */
interface IntegrationRoots {
  /** Where the host keeps sessions. Follows a custom data-root override. */
  data: string;
  /**
   * Where the host loads hooks from. Follows the data root, override included,
   * unless the host declares a separate hook directory: only opencode does, and
   * its hook half answers to its own XDG base rather than to the data root.
   */
  hook: string;
}

type CreateAgentIntegration = (
  roots: IntegrationRoots,
  commandExists: CommandExists,
) => AgentIntegration;

const INTEGRATIONS = {
  claude: ({ data, hook }, commandExists) => {
    const settings = join(hook, "settings.json");
    return {
      provider: "claude",
      label: "Claude Code",
      hookConfigPath: settings,
      ownsHookFile: false,
      isInstalled: () => existsSync(data) || commandExists("claude"),
      inspect: () => inspectClaudeHook(settings),
      install: async () => {
        await installClaudeHook(settings);
        return { needsTrust: false };
      },
      remove: () => removeClaudeHook(settings),
    };
  },
  codex: ({ data, hook }, commandExists) => {
    const hooks = join(hook, "hooks.json");
    return {
      provider: "codex",
      label: "Codex",
      hookConfigPath: hooks,
      ownsHookFile: false,
      isInstalled: () => existsSync(data) || commandExists("codex"),
      inspect: () => inspectCodexHooks(hooks),
      install: async () => ({
        needsTrust: await installCodexHooks(hooks),
      }),
      remove: () => removeCodexHooks(hooks),
    };
  },
  copilot: ({ data, hook }, commandExists) => {
    const hooks = join(hook, "hooks", "agent-usage-stat.json");
    return {
      provider: "copilot",
      label: "GitHub Copilot CLI",
      hookConfigPath: hooks,
      ownsHookFile: true,
      isInstalled: () => existsSync(data) || commandExists("copilot"),
      inspect: () => inspectCopilotHook(hooks),
      install: async () => {
        await installCopilotHook(hooks);
        return { needsTrust: false };
      },
      remove: () => removeCopilotHook(hooks),
    };
  },
  opencode: ({ data, hook }, commandExists) => {
    const plugin = join(hook, "agent-usage-stat.js");
    return {
      provider: "opencode",
      label: "opencode",
      hookConfigPath: plugin,
      ownsHookFile: true,
      isInstalled: () => existsSync(data) || commandExists("opencode"),
      inspect: () => inspectOpencodeHook(plugin),
      install: async () => {
        await installOpencodeHook(plugin);
        return { needsTrust: false };
      },
      remove: () => removeOpencodeHook(plugin),
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
  const rootsFor = (provider: ProviderName): IntegrationRoots => {
    const resolved = roots.find((item) => item.provider === provider);
    return { data: resolved?.root || "", hook: resolved?.hookRoot || "" };
  };
  return PROVIDER_NAMES.map((provider) =>
    INTEGRATIONS[provider](rootsFor(provider), commandExists)
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
