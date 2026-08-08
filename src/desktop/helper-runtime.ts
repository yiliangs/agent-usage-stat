import { app } from "electron";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  desktopSetupStatePath,
  installedHelperPath,
  installedHelperStatePath,
} from "../core/application-paths.js";
import { ConfigManager } from "../core/config-manager.js";
import { resolvedCaptureMode, type CaptureMode } from "../types/config.js";
import type { ProviderName } from "../types/provider.js";
import { createAgentIntegrations } from "../integrations/agent-integrations.js";
import { homeDir } from "../utils/paths.js";
import {
  resolveProviderDataRoot,
  resolveProviderDataRoots,
} from "../utils/provider-data-roots.js";
import { resolveUsageRootFromDisk } from "../utils/usage-root.js";

export interface HelperRunResult {
  code: number;
  stdout: string;
  stderr: string;
  updated: number;
}

export interface DesktopSetupResult {
  configured: boolean;
  codexNeedsTrust: boolean;
  detail?: string;
}

/** Owns the installed helper executable and its first-run setup state. */
export class HelperRuntime {
  private configManager = new ConfigManager();

  needsSetup(): boolean {
    return !existsSync(desktopSetupStatePath());
  }

  async syncInstallation(): Promise<void> {
    const source = this.bundledPath();
    const destination = installedHelperPath();
    const versionState = installedHelperStatePath();
    if (!existsSync(source)) {
      throw new Error(`Bundled application helper is missing: ${source}`);
    }

    await mkdir(join(destination, ".."), { recursive: true });
    if (app.isPackaged && existsSync(destination)) {
      try {
        const state = JSON.parse(await readFile(versionState, "utf8")) as {
          version?: string;
        };
        if (state.version === app.getVersion()) return;
      } catch {
        // Missing or invalid state requires reinstalling the helper.
      }
    }
    if (await filesEqual(source, destination)) {
      await this.writeVersionState();
      return;
    }

    const staged = `${destination}.${process.pid}.new`;
    const previous = `${destination}.previous`;
    await copyFile(source, staged);
    if (process.platform !== "win32") await chmod(staged, 0o755);

    try {
      await rm(previous, { force: true });
      if (existsSync(destination)) await rename(destination, previous);
      await rename(staged, destination);
      await rm(previous, { force: true });
      await this.writeVersionState();
    } catch (error) {
      await rm(staged, { force: true }).catch(() => undefined);
      if (!existsSync(destination) && existsSync(previous)) {
        await rename(previous, destination).catch(() => undefined);
      }
      throw error;
    }
  }

  async run(args: string[]): Promise<HelperRunResult> {
    const executable = installedHelperPath();
    if (!existsSync(executable)) {
      throw new Error(`Application helper is missing: ${executable}`);
    }

    return new Promise((resolveRun, reject) => {
      const child = spawn(executable, args, {
        cwd: app.getPath("userData"),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.once("error", reject);
      child.once("exit", (code) => {
        const updated = Number(/Reconciled (\d+)/.exec(stdout + stderr)?.[1] || 0);
        resolveRun({ code: code ?? 1, stdout, stderr, updated });
      });
    });
  }

  async ensureSetup(): Promise<DesktopSetupResult> {
    const statePath = desktopSetupStatePath();
    const usageRoot = resolveUsageRootFromDisk().root;
    const config = await this.configManager.loadConfig();
    const captureMode = resolvedCaptureMode(config);
    const providerDataRoots = Object.fromEntries(
      resolveProviderDataRoots(config).map((item) => [item.provider, item.root]),
    );
    let previousProviderDataRoots: Record<string, string> | undefined;
    if (existsSync(statePath)) {
      try {
        const state = JSON.parse(await readFile(statePath, "utf8")) as {
          dataRoot?: string;
          captureMode?: CaptureMode;
          providerDataRoots?: Record<string, string>;
        };
        if (
          state.dataRoot === usageRoot &&
          resolvedCaptureMode(state) === captureMode &&
          sameProviderDataRoots(state.providerDataRoots, providerDataRoots)
        ) {
          return { configured: true, codexNeedsTrust: false };
        }
        previousProviderDataRoots = state.providerDataRoots;
      } catch {
        // Missing, stale, or invalid setup state requires reconciliation.
      }
    }

    if (previousProviderDataRoots) {
      await this.removeMovedProviderHooks(
        previousProviderDataRoots,
        providerDataRoots,
      );
    }

    const setup = await this.run([
      "setup",
      "--data-root",
      usageRoot,
      "--skip-terminal-config",
      "--migrate-terminal-wrappers",
    ]);
    if (setup.code !== 0) {
      return {
        configured: false,
        codexNeedsTrust: false,
        detail: setup.stderr.trim() || setup.stdout.trim(),
      };
    }

    await mkdir(join(statePath, ".."), { recursive: true });
    await writeFile(
      statePath,
      JSON.stringify({
        version: app.getVersion(),
        configuredAt: new Date().toISOString(),
        dataRoot: usageRoot,
        captureMode,
        providerDataRoots,
        helper: installedHelperPath(),
      }, null, 2),
      "utf8",
    );
    return {
      configured: true,
      codexNeedsTrust: (setup.stdout + setup.stderr).includes("one final action"),
    };
  }

  async configureDataRoot(root: string): Promise<void> {
    await this.configure("dataRoot", root);
  }

  async configureCaptureMode(mode: CaptureMode): Promise<void> {
    await this.configure("captureMode", mode);
  }

  async configureProviderDataRoot(
    provider: ProviderName,
    root?: string,
  ): Promise<void> {
    const config = await this.configManager.loadConfig();
    const previous = createAgentIntegrations(
      homeDir(),
      undefined,
      process.env,
      config,
    ).find((integration) => integration.provider === provider);
    await previous?.remove();

    const providerDataRoots = { ...config.providerDataRoots };
    if (root) {
      providerDataRoots[provider] = resolveProviderDataRoot(
        provider,
        { providerDataRoots: { [provider]: root } },
      ).root;
    } else {
      delete providerDataRoots[provider];
    }
    const next = {
      ...config,
      providerDataRoots: Object.keys(providerDataRoots).length > 0
        ? providerDataRoots
        : undefined,
    };
    await this.configManager.saveConfig(next);
  }

  async captureMode(): Promise<CaptureMode> {
    return resolvedCaptureMode(await this.configManager.loadConfig());
  }

  private async configure(key: string, value: string): Promise<void> {
    const configured = await this.run(["config", "--set", `${key}=${value}`]);
    if (configured.code !== 0) {
      throw new Error(
        configured.stderr.trim() ||
        configured.stdout.trim() ||
        "Application configuration could not be saved.",
      );
    }
  }

  private async removeMovedProviderHooks(
    previousRoots: Record<string, string>,
    currentRoots: Record<string, string>,
  ): Promise<void> {
    const integrations = createAgentIntegrations(
      homeDir(),
      undefined,
      process.env,
      { providerDataRoots: previousRoots },
    );
    for (const integration of integrations) {
      if (previousRoots[integration.provider] !== currentRoots[integration.provider]) {
        await integration.remove();
      }
    }
  }

  resetSetup(): Promise<void> {
    return rm(desktopSetupStatePath(), { force: true });
  }

  private bundledPath(): string {
    const name = process.platform === "win32"
      ? "agent-usage-stat-helper.exe"
      : "agent-usage-stat-helper";
    return app.isPackaged
      ? join(process.resourcesPath, name)
      : join(app.getAppPath(), "build", "helper", name);
  }

  private writeVersionState(): Promise<void> {
    return writeFile(
      installedHelperStatePath(),
      JSON.stringify({ version: app.getVersion() }, null, 2),
      "utf8",
    );
  }
}

function sameProviderDataRoots(
  left: Record<string, string> | undefined,
  right: Record<string, string>,
): boolean {
  if (!left) return false;
  return ["claude", "codex", "copilot"].every(
    (provider) => left[provider] === right[provider],
  );
}

async function filesEqual(left: string, right: string): Promise<boolean> {
  try {
    const [leftStat, rightStat] = await Promise.all([stat(left), stat(right)]);
    if (leftStat.size !== rightStat.size) return false;
    const [leftData, rightData] = await Promise.all([
      readFile(left),
      readFile(right),
    ]);
    return leftData.equals(rightData);
  } catch {
    return false;
  }
}
