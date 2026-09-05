import { readFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { backupOnce, writeJsonAtomic } from "../utils/atomic-file.js";
import { configFilePath } from "../utils/paths.js";
import type { AppConfig } from "../types/config.js";
import { DEFAULT_CONFIG } from "../types/config.js";

export class ConfigManager {
  private configPath: string;

  constructor() {
    this.configPath = configFilePath();
  }

  /**
   * Load configuration from file or return defaults
   */
  async loadConfig(): Promise<AppConfig> {
    if (!existsSync(this.configPath)) {
      return DEFAULT_CONFIG;
    }

    try {
      const content = await readFile(this.configPath, "utf-8");
      const parsed = JSON.parse(content) as AppConfig & {
        captureMode?: "automatic" | "on-open";
      };

      if (!parsed.capturePolicy && parsed.captureMode) {
        const { captureMode, ...withoutLegacyMode } = parsed;
        const migrated: AppConfig = {
          ...DEFAULT_CONFIG,
          ...withoutLegacyMode,
          capturePolicy: {
            default: captureMode === "on-open" ? "batch" : "continuous",
          },
        };
        await this.saveConfig(migrated).catch(() => {
          console.warn("Failed to persist migrated capture policy");
        });
        return migrated;
      }

      // Merge with defaults to ensure all fields exist
      return { ...DEFAULT_CONFIG, ...parsed };
    } catch (error) {
      await this.preserveUnreadableConfig();
      console.warn(
        `Failed to parse config file, using defaults. A copy of it is kept at ${this.getPreservedConfigPath()}`,
      );
      return DEFAULT_CONFIG;
    }
  }

  /**
   * Keep the unreadable config before defaults take its place.
   *
   * A config that will not parse still holds the user's `dataRoot` and every
   * provider root in whatever bytes survived. Returning defaults and letting
   * the next `saveConfig` replace the file destroys them for good (#126), and
   * the ledger the user chose is then unrecoverable rather than merely
   * unreadable.
   *
   * `backupOnce` keeps the first copy and never overwrites it: a second run
   * would only copy the defaults-shaped file that already replaced the
   * original. Preserving is best effort, because whatever stopped the read can
   * equally stop the copy, and defaults must still load either way.
   */
  private async preserveUnreadableConfig(): Promise<void> {
    try {
      await backupOnce(this.configPath, this.getPreservedConfigPath());
    } catch (error) {
      console.warn(
        `Could not preserve the unreadable config file: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Save configuration to file
   */
  async saveConfig(config: AppConfig): Promise<void> {
    const configDir = join(this.configPath, "..");

    // Ensure directory exists
    if (!existsSync(configDir)) {
      await mkdir(configDir, { recursive: true });
    }

    await writeJsonAtomic(this.configPath, config, 2);
  }

  /**
   * Update a specific config value
   */
  async updateConfig(key: keyof AppConfig, value: unknown): Promise<void> {
    const config = await this.loadConfig();
    (config as any)[key] = value;
    await this.saveConfig(config);
  }

  /**
   * Reset config to defaults
   */
  async resetConfig(): Promise<void> {
    await this.saveConfig(DEFAULT_CONFIG);
  }

  /**
   * Get the config file path
   */
  getConfigPath(): string {
    return this.configPath;
  }

  /** Where an unreadable config is kept, named here and nowhere else. */
  getPreservedConfigPath(): string {
    return `${this.configPath}.corrupt`;
  }
}
