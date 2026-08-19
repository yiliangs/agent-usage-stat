import type { BrowserWindow } from "electron";
import { existsSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HelperRuntime } from "./helper-runtime.js";
import type { PortalRuntime } from "./portal-runtime.js";

const DESKTOP_SMOKE_FLAG = "--desktop-smoke-test";

interface SmokeApplication {
  readonly isPackaged: boolean;
  getName(): string;
  getVersion(): string;
}

export interface DesktopSmokeDependencies {
  application: SmokeApplication;
  helperRuntime: Pick<HelperRuntime, "run">;
  portalRuntime: Pick<PortalRuntime, "assetsRoot" | "refresh">;
  ensureSetup(): Promise<void>;
  createWindow(): Promise<BrowserWindow>;
  runtimeIconPath(): string;
  setupStatePath(): string;
  trace(message: string): void;
}

export function isDesktopSmokeRequested(args: readonly string[]): boolean {
  return args.includes(DESKTOP_SMOKE_FLAG);
}

/** Runs the packaged application's end-to-end production smoke protocol. */
export async function runDesktopSmokeIfRequested(
  args: readonly string[],
  dependencies: DesktopSmokeDependencies,
): Promise<boolean> {
  const index = args.indexOf(DESKTOP_SMOKE_FLAG);
  if (index < 0) return false;

  const output = args[index + 1];
  if (!output) throw new Error(`${DESKTOP_SMOKE_FLAG} requires an output path.`);

  const {
    application,
    helperRuntime,
    portalRuntime,
    ensureSetup,
    createWindow,
    runtimeIconPath,
    setupStatePath,
    trace,
  } = dependencies;

  trace("smoke-helper-begin");
  const helper = await helperRuntime.run(["probe"]);
  if (helper.code !== 0) throw new Error(helper.stderr || "Helper probe failed.");
  trace("smoke-helper-complete");
  await ensureSetup();
  trace("smoke-setup-complete");
  const refresh = await portalRuntime.refresh();
  trace("smoke-refresh-complete");
  const window = await createWindow();
  trace("smoke-window-complete");
  const renderer = await inspectRenderer(window);
  const settings = await inspectSettings(window);
  const home = await inspectHomeNavigation(window);
  trace("smoke-renderer-complete");

  const smokeJson = JSON.stringify({
    application: application.getName(),
    version: application.getVersion(),
    packaged: application.isPackaged,
    assets: existsSync(join(portalRuntime.assetsRoot(), "index.html")),
    runtimeIcon: existsSync(runtimeIconPath()),
    helper: JSON.parse(helper.stdout),
    setup: existsSync(setupStatePath()),
    refresh,
    renderer,
    settings,
    home,
  }, null, 2);
  const stagedOutput = `${output}.${process.pid}.tmp`;
  await writeFile(stagedOutput, smokeJson, "utf8");
  await rename(stagedOutput, output);
  trace("smoke-output-complete");
  window.destroy();
  return true;
}

async function inspectHomeNavigation(window: BrowserWindow): Promise<{
  view: string | null;
  markSelectable: boolean;
}> {
  return window.webContents.executeJavaScript(`(async () => {
    const mark = document.querySelector('.mark');
    mark?.click();
    for (let index = 0; index < 50; index++) {
      if (!document.querySelector('#overviewView')?.hidden) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return {
      view: document.querySelector('.portal-view:not([hidden])')?.dataset.view ?? null,
      markSelectable: mark?.hasAttribute('aria-selected') ?? false,
    };
  })()`);
}

async function inspectRenderer(window: BrowserWindow): Promise<{
  title: string;
  hasTimeline: boolean;
  favicon: string | null;
  logoLoaded: boolean;
  protocol: string;
}> {
  return window.webContents.executeJavaScript(`({
    title: document.title,
    hasTimeline: !!document.querySelector('[data-portal-view="sessions"]'),
    favicon: document.querySelector('link[rel="icon"]')?.href ?? null,
    logoLoaded: (() => {
      const logo = document.querySelector('.mark img');
      return logo instanceof HTMLImageElement && logo.complete && logo.naturalWidth > 0;
    })(),
    protocol: location.protocol
  })`);
}

async function inspectSettings(window: BrowserWindow): Promise<{
  api: boolean;
  visible: boolean;
  commonRows: number;
  captureChannels: number;
  captureStatus: string;
  advanced: boolean;
  providerRows: number;
  providers: string[];
  providerMonitorStatuses: string[];
}> {
  return window.webContents.executeJavaScript(`(async () => {
    document.querySelector('[data-portal-view="settings"]')?.click();
    for (let index = 0; index < 50; index++) {
      if (document.querySelectorAll('.provider-location').length === 3) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const response = await fetch('./api/settings', { cache: 'no-store' });
    const state = await response.json();
    return {
      api: response.ok,
      visible: !document.querySelector('#settingsView')?.hidden,
      commonRows: document.querySelectorAll('.settings-common .settings-row').length,
      captureChannels: document.querySelectorAll('.capture-channel').length,
      captureStatus: document.querySelector('#globalCaptureStatus')?.textContent ?? '',
      advanced: !!document.querySelector('details.settings-advanced'),
      providerRows: document.querySelectorAll('.provider-location').length,
      providers: state.providers?.map((provider) => provider.provider) ?? [],
      providerMonitorStatuses: state.providers?.map((provider) => provider.captureMonitor?.status) ?? [],
    };
  })()`);
}
