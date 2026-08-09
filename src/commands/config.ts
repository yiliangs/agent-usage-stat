import chalk from "chalk";
import { ConfigManager } from "../core/config-manager.js";
import { resolveUsageRoot } from "../utils/usage-root.js";
import {
  resolvedCapturePolicy,
  type AppConfig,
  type CaptureStrategy,
} from "../types/config.js";
import type { ProviderName } from "../types/provider.js";

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
    const policy = resolvedCapturePolicy(config);
    console.log(`  Capture       ${policy.default}`);
    for (const [provider, strategy] of Object.entries(policy.providers ?? {})) {
      console.log(`  ${provider.padEnd(13)} ${strategy} (override)`);
    }
    console.log();
  }

  private async setConfig(expression: string): Promise<void> {
    const [rawKey, ...parts] = expression.split("=");
    const key = rawKey?.trim();
    const value = parts.join("=").trim();
    if (!value) {
      throw new Error(
        'Use --set dataRoot="<path>", capturePolicy="continuous|batch", or capturePolicy.<agent>="continuous|batch|default"',
      );
    }
    if (key === "dataRoot") {
      await this.configManager.updateConfig("dataRoot", value);
      console.log(chalk.green(`Data root updated: ${value}`));
      return;
    }
    if (key === "capturePolicy") {
      this.assertStrategy(value);
      const config = await this.configManager.loadConfig();
      await this.configManager.saveConfig({
        ...config,
        capturePolicy: { ...config.capturePolicy, default: value },
      });
      console.log(chalk.green(`Capture policy updated: ${value}`));
      return;
    }
    const match = /^capturePolicy\.(claude|codex|copilot)$/.exec(key || "");
    if (!match) {
      throw new Error(
        'Use --set dataRoot="<path>", capturePolicy="continuous|batch", or capturePolicy.<agent>="continuous|batch|default"',
      );
    }
    if (!["continuous", "batch", "default"].includes(value)) {
      throw new Error('Provider capture policy must be "continuous", "batch", or "default"');
    }
    const provider = match[1] as ProviderName;
    const config = await this.configManager.loadConfig();
    const providers = { ...config.capturePolicy?.providers };
    if (value === "default") delete providers[provider];
    else providers[provider] = value as CaptureStrategy;
    await this.configManager.saveConfig({
      ...config,
      capturePolicy: {
        default: resolvedCapturePolicy(config).default,
        ...(Object.keys(providers).length > 0 ? { providers } : {}),
      },
    });
    console.log(chalk.green(`${provider} capture policy updated: ${value}`));
  }

  private assertStrategy(value: string): asserts value is CaptureStrategy {
    if (!['continuous', 'batch'].includes(value)) {
      throw new Error('Capture policy must be "continuous" or "batch"');
    }
  }
}
