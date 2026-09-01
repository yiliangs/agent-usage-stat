import { app } from "electron";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  desktopSetupStatePath,
  installedHelperPath,
} from "../core/application-paths.js";
import {
  helperBinaryName,
  installHelperBinary,
  installedHelperVersion,
} from "../core/helper-installation.js";
import { ConfigManager } from "../core/config-manager.js";
import { PROVIDER_NAMES } from "../core/provider-definition.js";
import {
  resolvedCapturePolicy,
  resolvedCaptureStrategy,
  type CapturePolicy,
  type CaptureStrategy,
} from "../types/config.js";
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

  /**
   * A packaged launch settles the common case on a version string rather than
   * comparing 92 MB of binary. Anything else — an unpackaged run, a version
   * the state does not vouch for, a missing helper — falls through to the
   * installer, which compares the binaries themselves.
   */
  async syncInstallation(): Promise<void> {
    if (
      app.isPackaged &&
      existsSync(installedHelperPath()) &&
      (await installedHelperVersion()) === app.getVersion()
    ) {
      return;
    }
    await installHelperBinary(this.bundledPath(), app.getVersion());
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
    const capturePolicy = resolvedCapturePolicy(config);
    const providerDataRoots = Object.fromEntries(
      resolveProviderDataRoots(config).map((item) => [item.provider, item.root]),
    );
    let previousProviderDataRoots: Record<string, string> | undefined;
    if (existsSync(statePath)) {
      try {
        const state = JSON.parse(await readFile(statePath, "utf8")) as {
          dataRoot?: string;
          capturePolicy?: CapturePolicy;
          providerDataRoots?: Record<string, string>;
        };
        if (
          state.capturePolicy &&
          state.dataRoot === usageRoot &&
          sameCapturePolicy(resolvedCapturePolicy(state), capturePolicy) &&
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
        capturePolicy,
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

  async configureCapturePolicy(
    strategy: CaptureStrategy | undefined,
    provider?: ProviderName,
  ): Promise<void> {
    const config = await this.configManager.loadConfig();
    const current = resolvedCapturePolicy(config);
    if (!provider) {
      if (!strategy) throw new Error("A default capture strategy is required.");
      await this.configManager.saveConfig({
        ...config,
        capturePolicy: { ...current, default: strategy },
      });
      return;
    }

    const providers = { ...current.providers };
    if (!strategy) delete providers[provider];
    else providers[provider] = strategy;
    await this.configManager.saveConfig({
      ...config,
      capturePolicy: {
        default: current.default,
        ...(Object.keys(providers).length > 0 ? { providers } : {}),
      },
    });
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

  async captureStrategy(provider?: ProviderName): Promise<CaptureStrategy> {
    return resolvedCaptureStrategy(await this.configManager.loadConfig(), provider);
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
    const name = helperBinaryName();
    return app.isPackaged
      ? join(process.resourcesPath, name)
      : join(app.getAppPath(), "dist", "helper", name);
  }
}

function sameProviderDataRoots(
  left: Record<string, string> | undefined,
  right: Record<string, string>,
): boolean {
  if (!left) return false;
  return PROVIDER_NAMES.every(
    (provider) => left[provider] === right[provider],
  );
}

function sameCapturePolicy(left: CapturePolicy, right: CapturePolicy): boolean {
  return left.default === right.default &&
    PROVIDER_NAMES.every((provider) =>
      left.providers?.[provider] === right.providers?.[provider]
    );
}

