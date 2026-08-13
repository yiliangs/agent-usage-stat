import { mkdir } from "fs/promises";
import { join, resolve } from "path";
import chalk from "chalk";
import prompts from "prompts";
import ora from "ora";
import { ConfigManager } from "../core/config-manager.js";
import { LOGBOOK_SHARD_DIR } from "../core/usage-ledger.js";
import { expandHome, homeDir } from "../utils/paths.js";
import { resolveUsageRoot } from "../utils/usage-root.js";
import {
  detectShellProfile,
  installTerminalWrappers,
  hasTerminalWrappers,
  removeTerminalWrappers,
  type WrappedCommand,
} from "../core/terminal-wrappers.js";
import {
  createAgentIntegrations,
  type AgentIntegration,
} from "../integrations/agent-integrations.js";
import { hookExecutablePaths } from "../integrations/hook-command.js";
import {
  resolvedCaptureStrategy,
  type AppConfig,
} from "../types/config.js";
import type { ProviderName } from "../types/provider.js";

export { detectInstalledAgents } from "../integrations/agent-integrations.js";

export interface SetupOptions {
  uninstall?: boolean;
  dataRoot?: string;
  terminalMessage?: boolean;
  configureTerminal?: boolean;
  migrateTerminal?: boolean;
}

export class SetupCommand {
  private configManager = new ConfigManager();
  private integrations?: AgentIntegration[];

  constructor(integrations?: AgentIntegration[]) {
    this.integrations = integrations;
  }

  async execute(options: SetupOptions): Promise<void> {
    console.log(chalk.cyan.bold("\nAgent Usage Stat Setup\n"));

    try {
      this.assertSupportedPlatform();
      if (options.uninstall) {
        await this.uninstall();
      } else {
        await this.install(
          options.dataRoot,
          options.terminalMessage !== false,
          options.configureTerminal !== false,
          options.migrateTerminal === true,
        );
      }
    } catch (error) {
      if (error instanceof Error) {
        console.error(chalk.red(`\nError: ${error.message}`));
      } else {
        console.error(chalk.red("\nAn unknown error occurred"));
      }
      process.exit(1);
    }
  }

  /** Configure the ledger and apply the selected provider capture mode. */
  private async install(
    dataRootOption?: string,
    terminalMessage = true,
    configureTerminal = true,
    migrateTerminal = false,
  ): Promise<void> {
    const existing = await this.configManager.loadConfig();
    const integrations = this.integrationsFor(existing);
    const agents = integrations.filter((integration) =>
      integration.isInstalled()
    );
    if (agents.length === 0) {
      throw new Error(
        "No supported agent was found. Install Claude Code, Codex, or Copilot CLI, run it once, then initialize again.",
      );
    }

    const suggestedRoot = resolveUsageRoot(existing).root;
    const answers = dataRootOption
      ? { dataRoot: dataRootOption }
      : existing.dataRoot
        ? { dataRoot: existing.dataRoot }
        : await prompts({
          type: "text",
          name: "dataRoot",
          message: "Usage data folder",
          initial: suggestedRoot,
          validate: (value: string) =>
            value.trim() ? true : "Choose a folder for usage data",
        });

    if (!answers.dataRoot) {
      console.log(chalk.yellow("\nSetup cancelled"));
      return;
    }

    const dataRoot = resolve(expandHome(String(answers.dataRoot).trim()));
    const labels = agents.map((agent) => agent.label).join(", ");
    console.log(chalk.gray(`Detected: ${labels}`));

    const spinner = ora("Connecting installed agents...").start();

    try {
      let codexNeedsTrust = false;
      let terminalProfile: string | undefined;
      let terminalWarning: string | undefined;
      const config: AppConfig = {
        ...existing,
        dataRoot,
      };

      await mkdir(join(dataRoot, LOGBOOK_SHARD_DIR), { recursive: true });
      await this.configManager.saveConfig(config);
      spinner.text = "Usage folder ready...";

      const continuousAgents = agents.filter((agent) =>
        resolvedCaptureStrategy(config, agent.provider) === "continuous"
      );
      for (const integration of integrations) {
        if (
          integration.isInstalled() &&
          resolvedCaptureStrategy(config, integration.provider) === "continuous"
        ) {
          const agent = integration;
          const result = await agent.install();
          if (agent.provider === "codex") {
            codexNeedsTrust = result.needsTrust;
          }
        } else {
          await integration.remove();
        }
      }
      spinner.text = continuousAgents.length > 0
        ? "Best-effort agent hooks configured..."
        : "Agent hooks removed...";

      const continuousProviders = continuousAgents.map((agent) => agent.provider);
      const terminal = continuousProviders.length === 0
        ? await this.configureTerminalMessage(false)
        : configureTerminal
          ? await this.configureTerminalMessage(terminalMessage, continuousProviders)
          : migrateTerminal
            ? await this.migrateTerminalMessage(continuousProviders)
            : {};
      terminalProfile = terminal.profile;
      terminalWarning = terminal.warning;

      spinner.succeed("Initialization complete");

      for (const agent of agents) {
        const continuous = resolvedCaptureStrategy(config, agent.provider) === "continuous";
        const status = continuous
          ? "continuous hook configured (best effort)"
          : "available for batch sync";
        console.log(chalk.green(`\n${agent.label} ${status}`));
        if (
          continuous &&
          agent.provider === "codex" &&
          codexNeedsTrust
        ) {
          console.log(
            chalk.yellow(
              "Codex security requires one final action: open /hooks and trust the new hook.",
            ),
          );
        }
      }
      if (terminalProfile) {
        const terminalEnabled = continuousProviders.length > 0 && terminalMessage;
        const action = terminalEnabled ? "enabled" : "disabled";
        console.log(
          chalk.green(`\nSame-terminal usage message ${action}: ${terminalProfile}`),
        );
        if (terminalEnabled) {
          console.log(chalk.gray("Open a new terminal for the command wrappers."));
        }
      }
      if (terminalWarning) {
        console.log(chalk.yellow(`\nTerminal message setup skipped: ${terminalWarning}`));
      }
      console.log(chalk.cyan(`\nUsage data: ${dataRoot}\n`));
    } catch (error) {
      spinner.fail("Setup failed");
      throw error;
    }
  }

  /** Remove this package's hooks from every supported agent. */
  private async uninstall(): Promise<void> {
    const spinner = ora("Removing agent hooks...").start();

    try {
      const config = await this.configManager.loadConfig();
      for (const integration of this.integrationsFor(config)) {
        await integration.remove();
      }
      const terminal = await this.configureTerminalMessage(false);
      spinner.succeed("Agent hooks removed");

      if (terminal.profile) {
        console.log(
          chalk.gray(`  Terminal wrappers removed from ${terminal.profile}.`),
        );
      }
      if (terminal.warning) {
        console.log(
          chalk.yellow(`  Terminal wrapper cleanup skipped: ${terminal.warning}`),
        );
      }
      console.log(
        chalk.gray(
          '  Config file preserved. Use "config --reset" to reset it.\n',
        ),
      );
    } catch (error) {
      spinner.fail("Uninstall failed");
      throw error;
    }
  }

  private async configureTerminalMessage(
    enabled: boolean,
    providers: ProviderName[] = [],
  ): Promise<{ profile?: string; warning?: string }> {
    const profile = detectShellProfile();
    if (!profile) {
      return { warning: "no supported PowerShell, zsh, or bash profile was found" };
    }

    try {
      if (enabled) {
        const { windowsBin, windowsUsesNode } = hookExecutablePaths();
        await installTerminalWrappers(
          profile,
          windowsBin,
          windowsUsesNode,
          wrapperCommands(providers),
        );
      } else {
        await removeTerminalWrappers(profile);
      }
      return { profile: profile.path };
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      return { warning: message };
    }
  }

  private assertSupportedPlatform(): void {
    if (process.platform !== "win32" && process.platform !== "darwin") {
      throw new Error("Initialization supports Windows and macOS only.");
    }
  }

  private async migrateTerminalMessage(providers: ProviderName[]): Promise<{
    profile?: string;
    warning?: string;
  }> {
    const profile = detectShellProfile();
    if (!profile || !(await hasTerminalWrappers(profile))) return {};
    return this.configureTerminalMessage(true, providers);
  }

  private integrationsFor(config: AppConfig): AgentIntegration[] {
    return this.integrations ?? createAgentIntegrations(
      homeDir(),
      undefined,
      process.env,
      config,
    );
  }
}

function wrapperCommands(providers: ProviderName[]): WrappedCommand[] {
  const commands: WrappedCommand[] = [];
  for (const provider of providers) {
    if (provider === "claude") commands.push("claude", "claudex");
    else commands.push(provider);
  }
  return commands;
}
