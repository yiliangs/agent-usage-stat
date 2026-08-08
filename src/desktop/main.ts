import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  shell,
  type MenuItemConstructorOptions,
} from "electron";
import { updateElectronApp } from "update-electron-app";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import {
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { resolveUsageRootFromDisk } from "../utils/usage-root.js";
import {
  desktopSetupStatePath,
  installedHelperPath,
} from "../core/application-paths.js";
import { HelperRuntime } from "./helper-runtime.js";
import {
  PORTAL_ORIGIN,
  PORTAL_URL,
  PortalRuntime,
  registerPortalScheme,
} from "./portal-runtime.js";
import { squirrelLifecycleEvent } from "./squirrel-events.js";
import { startupMode } from "./startup-policy.js";
import { STARTUP_URL, updateStartupScreen } from "./startup-screen.js";
import {
  ledgerLocationPrompt,
  ledgerMigrationPrompt,
} from "./ledger-onboarding.js";
import {
  mergeUsageLedger,
  removeUsageLedger,
  sameUsageRoot,
  usageLedgerHasRecords,
} from "../core/usage-ledger-migration.js";

const WINDOWS_APP_ID = "com.squirrel.AgentUsageStat.AgentUsageStat";
const WINDOW_ICON = join(app.getAppPath(), "assets", "logo.png");

traceStartup("module-loaded");

registerPortalScheme();
traceStartup("scheme-registered");
if (process.platform === "win32") app.setAppUserModelId(WINDOWS_APP_ID);

let mainWindow: BrowserWindow | null = null;
const helperRuntime = new HelperRuntime();
const portalRuntime = new PortalRuntime(helperRuntime);

const squirrelEvent = handleSquirrelEvent();
const isSmokeTest = process.argv.includes("--desktop-smoke-test");
const hasSingleInstanceLock = !squirrelEvent && (
  isSmokeTest || app.requestSingleInstanceLock()
);
traceStartup(`single-instance:${hasSingleInstanceLock}`);
if (squirrelEvent || !hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(start).catch(failStartup);
}

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void openApplicationWindow().catch(failStartup);
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

async function start(): Promise<void> {
  traceStartup("ready");
  const isSquirrelFirstRun = process.argv.includes("--squirrel-firstrun");
  if (app.isPackaged && !isSmokeTest && !isSquirrelFirstRun) {
    updateElectronApp({ updateInterval: "1 hour", notifyUser: true });
  }
  await portalRuntime.registerProtocol();
  installApplicationMenu();
  traceStartup("protocol-ready");

  if (isSmokeTest) {
    await helperRuntime.syncInstallation();
  }
  if (await runSmokeTestIfRequested()) {
    traceStartup("smoke-complete");
    app.quit();
    return;
  }

  await openApplicationWindow();
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
    await updateStartupScreen(
      window,
      "Connecting the local helper",
      "Preparing the background capture process. This keeps recording sessions even when the window is closed.",
    );
    await helperRuntime.syncInstallation();
    if (helperRuntime.needsSetup()) {
      await updateStartupScreen(
        window,
        "Choosing usage storage",
        "Select where the durable usage ledger should be kept.",
      );
      await helperRuntime.configureDataRoot(
        await chooseFirstRunUsageRoot(window),
      );
    }
    await updateStartupScreen(
      window,
      "Checking agent connections",
      "Connecting Claude Code, Codex, and Copilot CLI where they are installed.",
    );
    await ensureDesktopSetup(true);
    await updateStartupScreen(
      window,
      "Reconciling recent sessions",
      "Building the local dashboard from your usage ledger.",
    );
    await portalRuntime.refresh();
    await window.loadURL(PORTAL_URL);
    traceStartup("first-run-complete");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await updateStartupScreen(
      window,
      "The workspace could not start",
      detail,
      true,
    );
    await showOperationError("Startup failed", error);
  }
}

async function chooseFirstRunUsageRoot(window: BrowserWindow): Promise<string> {
  while (true) {
    const resolved = resolveUsageRootFromDisk();
    const prompt = ledgerLocationPrompt(resolved);
    const choice = await dialog.showMessageBox(window, {
      type: "question",
      title: "Usage History Storage",
      message: prompt.message,
      detail: prompt.detail,
      buttons: prompt.buttons,
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (choice.response === 0) return resolved.root;

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

async function synchronizeCachedWindow(window: BrowserWindow): Promise<void> {
  try {
    await setPortalSyncState(window, "syncing", "SYNCING");
    await helperRuntime.syncInstallation();
    await ensureDesktopSetup(true);
    const result = await portalRuntime.refresh();
    const detail = result.updated > 0
      ? `${result.updated} SESSION${result.updated === 1 ? "" : "S"} UPDATED`
      : "UP TO DATE";
    await setPortalSyncState(window, "complete", detail);
    traceStartup("background-sync-complete");
  } catch (error) {
    await setPortalSyncState(window, "error", "SYNC FAILED").catch(() => undefined);
    traceStartup("background-sync-failed");
    console.error(error);
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
    icon: WINDOW_ICON,
    width: 1440,
    height: 960,
    minWidth: 1040,
    minHeight: 700,
    backgroundColor: "#dfddd6",
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
    if (mainWindow === window) mainWindow = null;
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
      label: "Change Data Folder...",
      click: () => void chooseDataFolder(),
    },
    {
      label: "Repair Agent Connections",
      click: () => void repairAgentConnections(),
    },
    {
      label: "Remove Agent Connections...",
      click: () => void removeAgentConnections(),
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

async function chooseDataFolder(): Promise<void> {
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
  if (result.canceled || !selected) return;
  if (sameUsageRoot(current, selected)) return;

  let keepOriginal = true;
  let hasExistingHistory = false;
  try {
    hasExistingHistory = await usageLedgerHasRecords(current);
    if (hasExistingHistory) {
      const prompt = ledgerMigrationPrompt(current, selected);
      const migration = await showMessageBox({
        type: "question",
        title: "Change Usage Ledger Folder",
        message: prompt.message,
        detail: prompt.detail,
        buttons: prompt.buttons,
        defaultId: 0,
        cancelId: 1,
        noLink: true,
        checkboxLabel: prompt.checkboxLabel,
        checkboxChecked: prompt.checkboxChecked,
      });
      if (migration.response !== 0) return;
      keepOriginal = migration.checkboxChecked;
      await mergeUsageLedger(current, selected);
    }

    await helperRuntime.configureDataRoot(selected);
    await helperRuntime.resetSetup();
    if (!(await ensureDesktopSetup(true))) return;
    if (!(await refreshAndReload())) return;

    if (hasExistingHistory && !keepOriginal) {
      await removeUsageLedger(current);
    }
  } catch (error) {
    await showOperationError("Data folder was not changed", error);
  }
}

async function repairAgentConnections(): Promise<void> {
  try {
    await helperRuntime.resetSetup();
    await ensureDesktopSetup(true);
    await showMessageBox({
      type: "info",
      title: "Agent Usage Stat",
      message: "Agent connections are repaired.",
    });
  } catch (error) {
    await showOperationError("Agent repair failed", error);
  }
}

async function removeAgentConnections(): Promise<void> {
  const confirmation = await showMessageBox({
    type: "warning",
    title: "Remove Agent Connections",
    message: "Stop recording new agent sessions?",
    detail: "Existing usage data will be preserved.",
    buttons: ["Cancel", "Remove Connections"],
    defaultId: 0,
    cancelId: 0,
  });
  if (confirmation.response !== 1) return;

  const removed = await helperRuntime.run(["setup", "--uninstall"]);
  if (removed.code !== 0) {
    await showOperationError(
      "Agent connections were not removed",
      removed.stderr || removed.stdout,
    );
    return;
  }
  await helperRuntime.resetSetup();
}

async function showOperationError(title: string, error: unknown): Promise<void> {
  const detail = error instanceof Error ? error.message : String(error);
  await showMessageBox({
    type: "error",
    title,
    message: title,
    detail,
  });
}

function showMessageBox(
  options: Electron.MessageBoxOptions,
): Promise<Electron.MessageBoxReturnValue> {
  return mainWindow
    ? dialog.showMessageBox(mainWindow, options)
    : dialog.showMessageBox(options);
}

async function ensureDesktopSetup(interactive: boolean): Promise<boolean> {
  const setup = await helperRuntime.ensureSetup();
  if (!setup.configured) {
    if (!interactive) throw new Error(setup.detail || "Desktop setup failed.");
    await dialog.showMessageBox({
      type: "warning",
      title: "Agent Usage Stat Setup",
      message: "The application opened, but agent capture could not be connected.",
      detail: setup.detail,
    });
    return false;
  }

  if (interactive && setup.codexNeedsTrust) {
    await dialog.showMessageBox({
      type: "info",
      title: "Trust the Codex hook",
      message: "Codex needs one security confirmation.",
      detail: "Open /hooks in Codex and trust the Agent Usage Stat hook.",
    });
  }
  return true;
}

async function runSmokeTestIfRequested(): Promise<boolean> {
  const flag = "--desktop-smoke-test";
  const index = process.argv.indexOf(flag);
  if (index < 0) return false;

  const output = process.argv[index + 1];
  if (!output) throw new Error(`${flag} requires an output path.`);
  traceStartup("smoke-helper-begin");
  const helper = await helperRuntime.run(["probe"]);
  if (helper.code !== 0) throw new Error(helper.stderr || "Helper probe failed.");
  traceStartup("smoke-helper-complete");
  await ensureDesktopSetup(false);
  traceStartup("smoke-setup-complete");
  const refresh = await portalRuntime.refresh();
  traceStartup("smoke-refresh-complete");
  const window = await createWindow(PORTAL_URL, false);
  traceStartup("smoke-window-complete");
  const renderer = await window.webContents.executeJavaScript(`({
    title: document.title,
    hasTimeline: !!document.querySelector('[data-portal-view="sessions"]'),
    favicon: document.querySelector('link[rel="icon"]')?.href ?? null,
    logoLoaded: (() => {
      const logo = document.querySelector('.mark img');
      return logo instanceof HTMLImageElement && logo.complete && logo.naturalWidth > 0;
    })(),
    protocol: location.protocol
  })`) as {
    title: string;
    hasTimeline: boolean;
    favicon: string | null;
    logoLoaded: boolean;
    protocol: string;
  };
  traceStartup("smoke-renderer-complete");
  const smokeJson = JSON.stringify({
      application: app.getName(),
      version: app.getVersion(),
      packaged: app.isPackaged,
      assets: existsSync(join(portalRuntime.assetsRoot(), "index.html")),
      runtimeIcon: existsSync(WINDOW_ICON),
      helper: JSON.parse(helper.stdout),
      setup: existsSync(desktopSetupStatePath()),
      refresh,
      renderer,
    }, null, 2);
  const stagedOutput = `${output}.${process.pid}.tmp`;
  await writeFile(stagedOutput, smokeJson, "utf8");
  await rename(stagedOutput, output);
  traceStartup("smoke-output-complete");
  window.destroy();
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

  if (event === "--squirrel-install" || event === "--squirrel-updated") {
    await spawnAndWait(updateExecutable, [`--createShortcut=${target}`]);
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
    await spawnAndWait(updateExecutable, [`--removeShortcut=${target}`]);
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
