import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeTheme,
  shell,
  type MenuItemConstructorOptions,
} from "electron";
import { updateElectronApp } from "update-electron-app";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { resolveUsageRootFromDisk } from "../utils/usage-root.js";
import { ConfigManager } from "../core/config-manager.js";
import { isProviderName } from "../core/provider-definition.js";
import {
  desktopSetupStatePath,
  installedHelperPath,
} from "../core/application-paths.js";
import { HelperRuntime } from "./helper-runtime.js";
import { LogbookWatcher } from "./logbook-watcher.js";
import {
  PANEL_URL,
  PORTAL_ORIGIN,
  PORTAL_URL,
  PortalRuntime,
  registerPortalScheme,
} from "./portal-runtime.js";
import { StatusArea } from "./status-area.js";
import {
  closesToStatusArea,
  hasStatusArea,
} from "./status-area-policy.js";
import { singleFlight } from "./single-flight.js";
import { squirrelLifecycleEvent } from "./squirrel-events.js";
import {
  promoteStartMenuShortcut,
  removeStartMenuShortcut,
  startMenuProgramsDir,
  startMenuShortcutName,
} from "./start-menu-shortcut.js";
import {
  firstRunPortalUrl,
  startupIconFilename,
  startupMode,
} from "./startup-policy.js";
import {
  askOnStartupScreen,
  enterStartupStep,
  failStartupScreen,
  installStartupSteps,
  noticeOnStartupScreen,
  STARTUP_URL,
} from "./startup-screen.js";
import {
  ledgerLocationPrompt,
  ledgerMigrationPrompt,
} from "./ledger-onboarding.js";
import {
  setupAnswerAt,
  setupQuestionDetail,
  type SetupNotifier,
} from "./setup-question.js";
import {
  mergeUsageLedger,
  removeUsageLedger,
  sameUsageRoot,
  usageLedgerHasRecords,
} from "../core/usage-ledger-migration.js";
import { capturePolicyPrompt } from "./capture-policy.js";
import type { CaptureStrategy } from "../types/config.js";
import type { ProviderName } from "../types/provider.js";
import { buildDesktopSettingsState } from "./settings-state.js";
import {
  isDesktopSmokeRequested,
  runDesktopSmokeIfRequested,
} from "./desktop-smoke.js";

const WINDOWS_APP_ID = "com.squirrel.AgentUsageStat.AgentUsageStat";
const windowIconPath = (): string => join(
  app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "dist"),
  "icons",
  startupIconFilename(nativeTheme.shouldUseDarkColors),
);

traceStartup("module-loaded");

registerPortalScheme();
traceStartup("scheme-registered");
if (process.platform === "win32") app.setAppUserModelId(WINDOWS_APP_ID);

let mainWindow: BrowserWindow | null = null;
/**
 * The one way into `openApplicationWindow`.
 *
 * Opening awaits a snapshot probe, and on a first run the whole setup
 * sequence, before `mainWindow` is assigned. A dock click, a second launch, or
 * the status-area icon landing inside that gap still sees no window, and
 * without this guard would open a second one and re-run first-run setup
 * alongside the first.
 */
const openWindowOnce = singleFlight(openApplicationWindow);
const helperRuntime = new HelperRuntime();
const statusArea = new StatusArea({
  panelUrl: PANEL_URL,
  iconPath: windowIconPath,
  openDashboard,
  quit: () => app.quit(),
});
const configManager = new ConfigManager();
const portalRuntime = new PortalRuntime(helperRuntime, handlePortalRequest);
const logbookWatcher = new LogbookWatcher(autoRefreshPortal);

const squirrelEvent = handleSquirrelEvent();
const isSmokeTest = isDesktopSmokeRequested(process.argv);
const hasSingleInstanceLock = !squirrelEvent && (
  isSmokeTest || app.requestSingleInstanceLock()
);
traceStartup(`single-instance:${hasSingleInstanceLock}`);
if (squirrelEvent || !hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", openDashboard);

  app.whenReady().then(start).catch(failStartup);
}

app.on("activate", openDashboard);

/**
 * The status area holds the application open once the dashboard is closed.
 *
 * Its panel is a window, so with the icon in place this event usually never
 * fires at all. It still states the rule for the sessions where there is no
 * status area to hand the application to: another platform, or a shell that
 * refused the icon.
 */
app.on("window-all-closed", () => {
  if (closesToStatusArea(process.platform) && statusArea.isActive()) return;
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => statusArea.destroy());

app.on("will-quit", () => logbookWatcher.stop());

nativeTheme.on("updated", () => statusArea.applyTheme());

/** Bring the dashboard back, from the icon, a second launch, or the dock. */
function openDashboard(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  void openWindowOnce().catch(failStartup);
}

async function start(): Promise<void> {
  traceStartup("ready");
  const isSquirrelFirstRun = process.argv.includes("--squirrel-firstrun");
  if (app.isPackaged && !isSmokeTest && !isSquirrelFirstRun) {
    updateElectronApp({ updateInterval: "1 hour", notifyUser: true });
  }
  await portalRuntime.registerProtocol();
  installApplicationMenu();
  traceStartup("protocol-ready");

  if (hasStatusArea(process.platform)) {
    try {
      statusArea.install();
      traceStartup("status-area-ready");
    } catch (error) {
      // The dashboard is the application; the icon is a shortcut into it. A
      // shell that will not take the icon costs the shortcut, not the launch.
      traceStartup("status-area-failed");
      console.error(error);
    }
  }

  if (isSmokeTest) {
    await helperRuntime.syncInstallation();
  }
  if (await runDesktopSmokeIfRequested(process.argv, {
    application: app,
    helperRuntime,
    portalRuntime,
    statusArea,
    ensureSetup: async () => {
      await ensureDesktopSetup(null);
    },
    createWindow: () => createWindow(PORTAL_URL, false),
    runtimeIconPath: windowIconPath,
    setupStatePath: desktopSetupStatePath,
    trace: traceStartup,
  })) {
    traceStartup("smoke-complete");
    app.quit();
    return;
  }

  await openWindowOnce();
}

async function openApplicationWindow(): Promise<void> {
  const mode = startupMode(await portalRuntime.hasSnapshot());
  if (mode === "cached") {
    const window = await createWindow(PORTAL_URL);
    traceStartup("cached-window-ready");
    void synchronizeCachedWindow(window);
    return;
  }

  await openFirstRunWindow();
}

async function openFirstRunWindow(): Promise<void> {
  const window = await createWindow(STARTUP_URL);
  try {
    traceStartup("startup-window-ready");
    await installStartupSteps(window);
    await enterStartupStep(window, "helper");
    await helperRuntime.syncInstallation();
    if (helperRuntime.needsSetup()) {
      await enterStartupStep(window, "storage");
      await helperRuntime.configureDataRoot(
        await chooseFirstRunUsageRoot(window),
      );
      await enterStartupStep(window, "capture");
      await helperRuntime.configureCapturePolicy(
        await chooseCapturePolicy(window),
      );
    }
    await enterStartupStep(window, "agents");
    const setupReady = await ensureDesktopSetup(
      (notice) => noticeOnStartupScreen(window, notice),
    );
    await enterStartupStep(window, "sessions");
    await portalRuntime.refresh();
    await window.loadURL(firstRunPortalUrl(PORTAL_URL, setupReady));
    await logbookWatcher.start(resolveUsageRootFromDisk().root);
    traceStartup("first-run-complete");
  } catch (error) {
    // Closing the window mid-setup rejects the pending question. There is no
    // one left to tell, and the window itself already carries any other
    // failure, so nothing is raised over it.
    if (window.isDestroyed()) return;
    const detail = error instanceof Error ? error.message : String(error);
    await failStartupScreen(window, detail);
  }
}

async function chooseFirstRunUsageRoot(window: BrowserWindow): Promise<string> {
  while (true) {
    const resolved = resolveUsageRootFromDisk();
    const answer = await askOnStartupScreen(window, ledgerLocationPrompt(resolved));
    if (answer.value === "keep") return resolved.root;

    const selected = await dialog.showOpenDialog(window, {
      title: "Choose usage ledger folder",
      defaultPath: resolved.root,
      properties: ["openDirectory", "createDirectory"],
    });
    if (!selected.canceled && selected.filePaths[0]) {
      return selected.filePaths[0];
    }
  }
}

async function chooseCapturePolicy(
  window: BrowserWindow,
): Promise<CaptureStrategy> {
  const answer = await askOnStartupScreen(window, capturePolicyPrompt());
  return answer.value;
}

async function synchronizeCachedWindow(window: BrowserWindow): Promise<void> {
  try {
    await setPortalSyncState(window, "syncing", "SYNCING");
    await helperRuntime.syncInstallation();
    await ensureDesktopSetup(notifyWithDialog);
    const result = await portalRuntime.refresh();
    await setPortalSyncState(window, "complete", syncDetail(result.updated));
    traceStartup("background-sync-complete");
  } catch (error) {
    await setPortalSyncState(window, "error", "SYNC FAILED").catch(() => undefined);
    traceStartup("background-sync-failed");
    console.error(error);
  }
  await logbookWatcher.start(resolveUsageRootFromDisk().root);
}

function syncDetail(updated: number): string {
  return updated > 0
    ? `${updated} SESSION${updated === 1 ? "" : "S"} UPDATED`
    : "UP TO DATE";
}

/**
 * Refresh an open dashboard when detached captures write new shards. Runs
 * through the same corner-status flow as the launch sync, so the renderer
 * re-renders in place instead of reloading out from under the user.
 */
async function autoRefreshPortal(): Promise<void> {
  const window = mainWindow;
  if (!window || window.isDestroyed()) {
    // The dashboard is closed, but the status area is still showing figures
    // from the ledger that just changed.
    await portalRuntime.refresh().catch(() => undefined);
    await statusArea.refresh();
    return;
  }
  try {
    await setPortalSyncState(window, "syncing", "SYNCING");
    const result = await portalRuntime.refresh();
    await statusArea.refresh();
    await setPortalSyncState(window, "complete", syncDetail(result.updated));
  } catch {
    await setPortalSyncState(window, "error", "SYNC FAILED").catch(() => undefined);
  }
}

async function setPortalSyncState(
  window: BrowserWindow,
  status: "syncing" | "complete" | "error",
  detail: string,
): Promise<void> {
  if (window.isDestroyed()) return;
  await window.webContents.executeJavaScript(
    `window.agentUsageStatSetSyncState?.(${JSON.stringify(status)}, ${JSON.stringify(detail)})`,
  );
}

async function createWindow(
  initialUrl = PORTAL_URL,
  show = true,
): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    title: "Agent Usage Stat",
    icon: windowIconPath(),
    width: 1440,
    height: 960,
    minWidth: 1040,
    minHeight: 700,
    // Matches --field in both themes, so the frame never flashes the wrong
    // ground before the first paint.
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#171713" : "#dfddd6",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith(`${PORTAL_ORIGIN}/`) || url.startsWith("data:text/html")) return;
    event.preventDefault();
  });
  if (show) window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    if (mainWindow !== window) return;
    mainWindow = null;
    if (statusArea.isActive()) statusArea.announceResidency();
  });

  mainWindow = window;
  await window.loadURL(initialUrl);
  return window;
}

function installApplicationMenu(): void {
  const applicationItems: MenuItemConstructorOptions[] = [
    {
      label: "Refresh Data",
      accelerator: "CmdOrCtrl+R",
      click: () => void refreshAndReload(),
    },
    { type: "separator" },
    {
      label: "Settings...",
      accelerator: "CmdOrCtrl+,",
      click: () => void openSettings(),
    },
  ];

  const template: MenuItemConstructorOptions[] = process.platform === "darwin"
    ? [
      {
        label: app.name,
        submenu: [
          { role: "about" },
          { type: "separator" },
          ...applicationItems,
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      { role: "editMenu" },
      { role: "windowMenu" },
    ]
    : [
      {
        label: "Application",
        submenu: [
          ...applicationItems,
          { type: "separator" },
          { role: "quit" },
        ],
      },
      { role: "viewMenu" },
      { role: "help", submenu: [{ role: "about" }] },
    ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function refreshAndReload(): Promise<boolean> {
  try {
    await portalRuntime.refresh();
    await mainWindow?.webContents.reload();
    return true;
  } catch (error) {
    await showOperationError("Refresh failed", error);
    return false;
  }
}

async function openSettings(): Promise<void> {
  if (!mainWindow) return;
  await mainWindow.webContents.executeJavaScript(`
    document.querySelector('[data-portal-view="settings"]')?.click()
  `);
  mainWindow.show();
  mainWindow.focus();
}

async function chooseDataFolder(reload = true): Promise<boolean> {
  const current = resolveUsageRootFromDisk().root;
  const options: Electron.OpenDialogOptions = {
    title: "Choose usage data folder",
    defaultPath: current,
    properties: ["openDirectory", "createDirectory"],
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  const selected = result.filePaths[0];
  if (result.canceled || !selected) return false;
  if (sameUsageRoot(current, selected)) return false;

  let keepOriginal = true;
  let hasExistingHistory = false;
  try {
    hasExistingHistory = await usageLedgerHasRecords(current);
    if (hasExistingHistory) {
      const question = ledgerMigrationPrompt(current, selected);
      const migration = await showMessageBox({
        type: "question",
        title: "Change Usage Ledger Folder",
        message: question.message,
        detail: setupQuestionDetail(question),
        buttons: question.options.map((option) => option.label),
        defaultId: 0,
        cancelId: 1,
        noLink: true,
        checkboxLabel: question.toggle?.label,
        checkboxChecked: question.toggle?.checked,
      });
      const answer = setupAnswerAt(
        question,
        migration.response,
        migration.checkboxChecked,
      );
      if (answer?.value !== "migrate") return false;
      keepOriginal = answer.toggled;
      await mergeUsageLedger(current, selected);
    }

    await helperRuntime.configureDataRoot(selected);
    await helperRuntime.resetSetup();
    if (!(await ensureDesktopSetup(notifyWithDialog))) return false;
    await portalRuntime.refresh();
    await logbookWatcher.start(resolveUsageRootFromDisk().root);
    if (reload) await mainWindow?.webContents.reload();

    if (hasExistingHistory && !keepOriginal) {
      await removeUsageLedger(current);
    }
    return true;
  } catch (error) {
    await showOperationError("Data folder was not changed", error);
    return false;
  }
}

async function repairCaptureSetup(): Promise<void> {
  await helperRuntime.resetSetup();
  if (!(await ensureDesktopSetup(notifyWithDialog))) {
    throw new Error("Capture setup could not be repaired.");
  }
}

async function applyCapturePolicy(
  strategy: CaptureStrategy | undefined,
  provider?: ProviderName,
): Promise<void> {
  if (!provider && strategy === await helperRuntime.captureStrategy()) return;
  await helperRuntime.configureCapturePolicy(strategy, provider);
  await helperRuntime.resetSetup();
  if (!(await ensureDesktopSetup(notifyWithDialog))) {
    throw new Error("Capture setup is incomplete. Use Repair capture setup.");
  }
}

async function chooseProviderDataRoot(provider: ProviderName): Promise<boolean> {
  const state = await currentSettingsState();
  const current = state.providers.find((item) => item.provider === provider);
  if (!current) throw new Error(`Unsupported provider: ${provider}`);
  const options: Electron.OpenDialogOptions = {
    title: `Choose ${current.label} data folder`,
    defaultPath: current.root,
    properties: ["openDirectory"],
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  const selected = result.filePaths[0];
  if (result.canceled || !selected) return false;

  await applyProviderDataRoot(provider, selected);
  return true;
}

async function applyProviderDataRoot(
  provider: ProviderName,
  root?: string,
): Promise<void> {
  await helperRuntime.configureProviderDataRoot(provider, root);
  await helperRuntime.resetSetup();
  if (!(await ensureDesktopSetup(notifyWithDialog))) {
    throw new Error("Agent data location was saved, but capture setup is incomplete.");
  }
  await portalRuntime.refresh();
}

async function currentSettingsState() {
  const config = await configManager.loadConfig();
  return buildDesktopSettingsState(config, resolveUsageRootFromDisk());
}

async function handlePortalRequest(
  request: Request,
  url: URL,
): Promise<Response | null> {
  if (url.pathname === "/api/panel") return handlePanelRequest(request);
  if (url.pathname !== "/api/settings") return null;
  try {
    if (request.method === "GET") {
      return settingsJson(await currentSettingsState());
    }
    if (request.method !== "POST") {
      return settingsJson({ error: "Method not allowed" }, 405);
    }

    const body = await request.json() as {
      action?: string;
      strategy?: CaptureStrategy;
      inherit?: boolean;
      provider?: ProviderName;
    };
    if (body.action === "change-ledger") {
      await chooseDataFolder(false);
    } else if (body.action === "capture-policy") {
      if (
        !body.inherit &&
        (!body.strategy || !["continuous", "batch"].includes(body.strategy))
      ) {
        throw new Error("Invalid capture strategy.");
      }
      if (body.provider !== undefined && !isProviderName(body.provider)) {
        throw new Error("Invalid provider.");
      }
      if (body.inherit && !body.provider) {
        throw new Error("Only an agent policy can inherit the default.");
      }
      await applyCapturePolicy(
        body.inherit ? undefined : body.strategy,
        body.provider,
      );
    } else if (body.action === "choose-provider") {
      if (!isProviderName(body.provider)) throw new Error("Invalid provider.");
      await chooseProviderDataRoot(body.provider);
    } else if (body.action === "reset-provider") {
      if (!isProviderName(body.provider)) throw new Error("Invalid provider.");
      await applyProviderDataRoot(body.provider);
    } else if (body.action === "repair-capture") {
      await repairCaptureSetup();
    } else {
      throw new Error("Unknown settings action.");
    }
    return settingsJson(await currentSettingsState());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return settingsJson({ error: message }, 500);
  }
}

/** The panel's only outbound action: leave the glance for the whole ledger. */
async function handlePanelRequest(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return settingsJson({ error: "Method not allowed" }, 405);
  }
  try {
    const body = await request.json() as { action?: string };
    if (body.action !== "open-dashboard") {
      return settingsJson({ error: "Unknown panel action." }, 400);
    }
    statusArea.hide();
    openDashboard();
    return settingsJson({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return settingsJson({ error: message }, 500);
  }
}

function settingsJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function showOperationError(title: string, error: unknown): Promise<void> {
  await notifyWithDialog({
    tone: "error",
    title,
    message: title,
    detail: error instanceof Error ? error.message : String(error),
  });
}

/** Delivers a setup message over the dashboard, which has no surface for one. */
const notifyWithDialog: SetupNotifier = async (notice) => {
  await showMessageBox({
    type: notice.tone,
    title: notice.title,
    message: notice.message,
    detail: notice.detail,
  });
};

function showMessageBox(
  options: Electron.MessageBoxOptions,
): Promise<Electron.MessageBoxReturnValue> {
  return mainWindow
    ? dialog.showMessageBox(mainWindow, options)
    : dialog.showMessageBox(options);
}

/**
 * Reports setup trouble through whichever surface is in front. A null notifier
 * means no one is watching, so an unconfigured helper raises instead.
 */
async function ensureDesktopSetup(
  notify: SetupNotifier | null,
): Promise<boolean> {
  const setup = await helperRuntime.ensureSetup();
  if (!setup.configured) {
    if (!notify) throw new Error(setup.detail || "Desktop setup failed.");
    await notify({
      tone: "warning",
      title: "Agent Usage Stat Setup",
      message: "The application opened, but agent capture could not be connected.",
      detail: setup.detail || "Agent capture could not be connected.",
    });
    return false;
  }

  if (notify && setup.codexNeedsTrust) {
    await notify({
      tone: "info",
      title: "Trust the Codex hook",
      message: "Codex needs one security confirmation.",
      detail: "Open /hooks in Codex and trust the Agent Usage Stat hook.",
    });
  }
  return true;
}

function failStartup(error: unknown): void {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`${message}\n`);
  app.exit(1);
}

function handleSquirrelEvent(): boolean {
  const event = squirrelLifecycleEvent(process.platform, process.argv);
  if (!event) return false;

  void performSquirrelEvent(event)
    .catch(() => undefined)
    .finally(() => app.quit());
  return true;
}

async function performSquirrelEvent(event: string): Promise<void> {
  const updateExecutable = resolve(dirname(process.execPath), "..", "Update.exe");
  const target = process.execPath.split(/[\\/]/).pop() || "Agent Usage Stat.exe";
  const programs = startMenuProgramsDir(process.env);
  const shortcut = startMenuShortcutName(target);

  if (event === "--squirrel-install" || event === "--squirrel-updated") {
    await spawnAndWait(updateExecutable, [`--createShortcut=${target}`]);
    await promoteStartMenuShortcut(programs, shortcut);
    return;
  }
  if (event === "--squirrel-uninstall") {
    const helper = installedHelperPath();
    if (existsSync(helper)) {
      await spawnAndWait(helper, ["setup", "--uninstall"]).catch(() => undefined);
    }
    await Promise.all([
      rm(join(helper, ".."), { recursive: true, force: true }),
      rm(desktopSetupStatePath(), { force: true }),
    ]);
    await spawnAndWait(updateExecutable, [`--removeShortcut=${target}`])
      .catch(() => undefined);
    await removeStartMenuShortcut(programs, shortcut);
  }
}

function spawnAndWait(command: string, args: string[]): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

function traceStartup(message: string): void {
  const path = process.env.AGENT_USAGE_STAT_STARTUP_TRACE;
  if (!path) return;
  try {
    appendFileSync(path, `${new Date().toISOString()} ${message}\n`, "utf8");
  } catch {
    // Diagnostic tracing must never affect startup.
  }
}
