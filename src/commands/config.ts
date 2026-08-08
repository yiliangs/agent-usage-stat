import chalk from "chalk";
import { ConfigManager } from "../core/config-manager.js";
import { resolveUsageRoot } from "../utils/usage-root.js";
import { resolvedCaptureMode, type AppConfig } from "../types/config.js";

export interface ConfigOptions {
  show?: boolean;
  set?: string;
  reset?: boolean;
}

export class ConfigCommand {
  private configManager = new ConfigManager();

  async execute(options: ConfigOptions): Promise<void> {
    try {
      if (options.reset) await this.configManager.resetConfig();
      else if (options.set) await this.setConfig(options.set);
      else await this.showConfig();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(chalk.red(`Error: ${message}`));
      process.exitCode = 1;
    }
  }

  private async showConfig(): Promise<void> {
    const config = await this.configManager.loadConfig();
    const { root, source } = resolveUsageRoot(config);
    console.log(chalk.cyan.bold("\nAgent Usage Stat"));
    console.log(chalk.gray(this.configManager.getConfigPath()));
    console.log(`\n  Data root     ${source === "config" ? root : `${root} (${source})`}`);
    console.log(`  Capture mode  ${resolvedCaptureMode(config)}\n`);
  }

  private async setConfig(expression: string): Promise<void> {
    const [rawKey, ...parts] = expression.split("=");
    const key = rawKey?.trim() as keyof AppConfig;
    const value = parts.join("=").trim();
    if (!value) {
      throw new Error(
        'Use --set dataRoot="<path>" or --set captureMode="automatic|on-open"',
      );
    }
    if (key === "captureMode" && !["automatic", "on-open"].includes(value)) {
      throw new Error('Capture mode must be "automatic" or "on-open"');
    }
    if (key !== "dataRoot" && key !== "captureMode") {
      throw new Error(
        'Use --set dataRoot="<path>" or --set captureMode="automatic|on-open"',
      );
    }
    await this.configManager.updateConfig(key, value);
    const label = key === "dataRoot" ? "Data root" : "Capture mode";
    console.log(chalk.green(`${label} updated: ${value}`));
  }
}
