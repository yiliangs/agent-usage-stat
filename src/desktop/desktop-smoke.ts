import type { BrowserWindow } from "electron";
import { existsSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HelperRuntime } from "./helper-runtime.js";
import type { PortalRuntime } from "./portal-runtime.js";
import type { StatusArea } from "./status-area.js";

const DESKTOP_SMOKE_FLAG = "--desktop-smoke-test";

interface SmokeApplication {
  readonly isPackaged: boolean;
  getName(): string;
  getVersion(): string;
}

type SmokeStatusArea = Pick<
  StatusArea,
  "isActive" | "toggle" | "hide" | "panelWindow"
>;

export interface DesktopSmokeDependencies {
  application: SmokeApplication;
  helperRuntime: Pick<HelperRuntime, "run">;
  portalRuntime: Pick<PortalRuntime, "assetsRoot" | "refresh">;
  statusArea: SmokeStatusArea;
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
    statusArea,
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
  // Last, because proving the application outlives its dashboard means
  // closing the dashboard.
  const statusAreaResult = await inspectStatusArea(statusArea, window);
  trace("smoke-status-area-complete");

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
    statusArea: statusAreaResult,
  }, null, 2);
  const stagedOutput = `${output}.${process.pid}.tmp`;
  await writeFile(stagedOutput, smokeJson, "utf8");
  await rename(stagedOutput, output);
  trace("smoke-output-complete");
  if (!window.isDestroyed()) window.destroy();
  return true;
}

interface StatusAreaSmokeResult {
  installed: boolean;
  opened: boolean;
  dismissed: boolean;
  residentAfterClose: boolean;
  frame: PanelFrame | null;
  glance: PanelGlance | null;
}

/**
 * The rectangle the shell reserves for the panel, beside the one the document
 * is given inside it.
 *
 * The panel draws its own hairline frame at the edge of its content, so any
 * difference between these two is a second owner of those pixels: the shell
 * paints its window border over the outermost point of the window rect, and on
 * an edge where the content is flush with it the document's frame goes under
 * it (#139).
 */
interface PanelFrame {
  window: Electron.Rectangle;
  content: Electron.Rectangle;
}

interface PanelGlance {
  surface: string | null;
  ready: boolean;
  todayTokens: string | null;
  todayCost: string | null;
  todayNote: string | null;
  todayDelta: string | null;
  weekMeta: string | null;
  bars: number;
  cells: number;
  models: number;
  modelsEmpty: boolean;
}

/**
 * The status-area icon, its panel, and the residency that makes both worth
 * having.
 *
 * The panel is opened through the same call the icon's click makes, read back
 * from the rendered document, and dismissed. Then the dashboard is closed: on
 * a platform that hands the application to the status area, reaching the end
 * of this function at all is the evidence, because the application quitting
 * here would leave the smoke result unwritten.
 */
async function inspectStatusArea(
  statusArea: SmokeStatusArea,
  window: BrowserWindow,
): Promise<StatusAreaSmokeResult> {
  if (!statusArea.isActive()) {
    return {
      installed: false,
      opened: false,
      dismissed: false,
      residentAfterClose: false,
      frame: null,
      glance: null,
    };
  }

  await statusArea.toggle();
  const panel = statusArea.panelWindow();
  const opened = panel?.isVisible() ?? false;

  const frame = panel
    ? { window: panel.getBounds(), content: panel.getContentBounds() }
    : null;
  const glance = panel ? await readPanelGlance(panel) : null;
  statusArea.hide();
  const dismissed = !(panel?.isVisible() ?? false);

  if (!window.isDestroyed()) window.destroy();
  await new Promise((settle) => setTimeout(settle, 500));

  return {
    installed: true,
    opened,
    dismissed,
    residentAfterClose: true,
    frame,
    glance,
  };
}

function readPanelGlance(panel: BrowserWindow): Promise<PanelGlance> {
  return panel.webContents.executeJavaScript(`(async () => {
    for (let index = 0; index < 100; index++) {
      if (document.body.dataset.glanceReady) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const read = (slot) =>
      document.querySelector('[data-glance="' + slot + '"]')?.textContent ?? null;
    return {
      surface: document.body.dataset.surface ?? null,
      ready: document.body.dataset.glanceReady === 'true',
      todayTokens: read('today-tokens'),
      todayCost: read('today-cost'),
      todayNote: read('today-note'),
      todayDelta: read('today-delta'),
      weekMeta: read('week-meta'),
      bars: document.querySelectorAll('.glance-traffic i').length,
      cells: document.querySelectorAll('.glance-heatmap i').length,
      models: document.querySelectorAll('.glance-model').length,
      modelsEmpty: !document.querySelector('[data-glance-models-empty]')?.hidden,
    };
  })()`);
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
