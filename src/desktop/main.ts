import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  protocol,
  shell,
  type MenuItemConstructorOptions,
} from "electron";
import { updateElectronApp } from "update-electron-app";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
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
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveUsageRootFromDisk } from "../utils/usage-root.js";
import {
  desktopSetupStatePath,
  installedHelperPath,
  installedHelperStatePath,
} from "../core/application-paths.js";

const APP_SCHEME = "aus";
const APP_HOST = "app";
const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

traceStartup("module-loaded");

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
    },
  },
]);
traceStartup("scheme-registered");

let mainWindow: BrowserWindow | null = null;
let refreshPromise: Promise<PortalRefreshResult> | null = null;

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
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

interface PortalRefreshResult {
  updated: number;
  generatedAt: string;
  sessions: number;
  totalCost: number;
}

interface PortalMeta {
  generatedAt?: string;
  sessions?: number;
  totalCost?: number;
}

async function start(): Promise<void> {
  traceStartup("ready");
  app.setAppUserModelId("com.yiliang.agent-usage-stat");
  if (app.isPackaged && !isSmokeTest) {
    updateElectronApp({ updateInterval: "1 hour", notifyUser: true });
  }
  await syncHelperInstallation();
  await registerApplicationProtocol();
  installApplicationMenu();
  traceStartup("protocol-ready");

  if (await runSmokeTestIfRequested()) {
    traceStartup("smoke-complete");
    app.quit();
    return;
  }

  await ensureDesktopSetup(true);
  await refreshPortalData();
  await createWindow();
}

async function createWindow(show = true): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    title: "Agent Usage Stat",
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
    if (url.startsWith(`${APP_SCHEME}://${APP_HOST}/`)) return;
    event.preventDefault();
  });
  if (show) window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });

  mainWindow = window;
  await window.loadURL(`${APP_SCHEME}://${APP_HOST}/index.html`);
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

async function refreshAndReload(): Promise<void> {
  try {
    await refreshPortalData();
    await mainWindow?.webContents.reload();
  } catch (error) {
    await showOperationError("Refresh failed", error);
  }
}

async function chooseDataFolder(): Promise<void> {
  const options: Electron.OpenDialogOptions = {
    title: "Choose usage data folder",
    defaultPath: resolveUsageRootFromDisk().root,
    properties: ["openDirectory", "createDirectory"],
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  const selected = result.filePaths[0];
  if (result.canceled || !selected) return;

  const configured = await runHelper(["config", "--set", `dataRoot=${selected}`]);
  if (configured.code !== 0) {
    await showOperationError(
      "Data folder was not changed",
      configured.stderr || configured.stdout,
    );
    return;
  }
  await rm(desktopSetupStatePath(), { force: true });
  await ensureDesktopSetup(true);
  await refreshAndReload();
}

async function repairAgentConnections(): Promise<void> {
  try {
    await rm(desktopSetupStatePath(), { force: true });
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

  const removed = await runHelper(["setup", "--uninstall"]);
  if (removed.code !== 0) {
    await showOperationError(
      "Agent connections were not removed",
      removed.stderr || removed.stdout,
    );
    return;
  }
  await rm(desktopSetupStatePath(), { force: true });
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

async function registerApplicationProtocol(): Promise<void> {
  await protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== APP_HOST) return new Response("Not found", { status: 404 });

    if (url.pathname === "/api/refresh") {
      if (request.method !== "POST") {
        return new Response("Method not allowed", {
          status: 405,
          headers: { Allow: "POST" },
        });
      }
      try {
        return jsonResponse(await refreshPortalData());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return jsonResponse({ error: message }, 500);
      }
    }

    const fromData = url.pathname.startsWith("/data/");
    const root = fromData ? portalDataRoot() : portalAssetsRoot();
    const requestedPath = fromData
      ? url.pathname.slice("/data/".length)
      : url.pathname === "/" || url.pathname === "/index.html"
        ? "index.html"
        : url.pathname.slice(1);
    let path = resolve(root, decodeURIComponent(requestedPath));

    if (!isPathInside(root, path)) {
      return new Response("Forbidden", { status: 403 });
    }
    if (!fromData && !(await isFile(path))) {
      path = resolve(root, "index.html");
    }

    try {
      const content = await readFile(path);
      const extension = extname(path).toLowerCase();
      return new Response(content, {
        status: 200,
        headers: {
          "Content-Type": MIME_TYPES[extension] || "application/octet-stream",
          "Cache-Control": fromData || extension === ".html"
            ? "no-store"
            : "public, max-age=3600",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}

function refreshPortalData(): Promise<PortalRefreshResult> {
  if (!refreshPromise) {
    refreshPromise = performRefresh().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

async function performRefresh(): Promise<PortalRefreshResult> {
  const usageRoot = resolveUsageRootFromDisk().root;
  await mkdir(join(usageRoot, "logbook.d"), { recursive: true });
  const helper = await runHelper(["sync", "--quiet"]);
  if (helper.code !== 0) {
    throw new Error(helper.stderr.trim() || "Usage synchronization failed.");
  }

  const builderPath = join(
    app.getAppPath(),
    "portal",
    "scripts",
    "build-data.mjs",
  );
  const builder = await import(pathToFileURL(builderPath).href) as {
    buildPortalData(options: { root: string; outDir: string }): Promise<PortalMeta>;
  };
  const meta = await builder.buildPortalData({
    root: usageRoot,
    outDir: portalDataRoot(),
  });

  return {
    updated: helper.updated,
    generatedAt: meta.generatedAt || new Date().toISOString(),
    sessions: meta.sessions ?? 0,
    totalCost: meta.totalCost ?? 0,
  };
}

async function runHelper(args: string[]): Promise<{
  code: number;
  stdout: string;
  stderr: string;
  updated: number;
}> {
  const executable = helperExecutablePath();
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

function helperExecutablePath(): string {
  return installedHelperPath();
}

function bundledHelperPath(): string {
  const name = process.platform === "win32"
    ? "agent-usage-stat-helper.exe"
    : "agent-usage-stat-helper";
  return app.isPackaged
    ? join(process.resourcesPath, name)
    : join(app.getAppPath(), "build", "helper", name);
}

async function syncHelperInstallation(): Promise<void> {
  const source = bundledHelperPath();
  const destination = helperExecutablePath();
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
    await writeFile(
      versionState,
      JSON.stringify({ version: app.getVersion() }, null, 2),
      "utf8",
    );
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
    await writeFile(
      versionState,
      JSON.stringify({ version: app.getVersion() }, null, 2),
      "utf8",
    );
  } catch (error) {
    await rm(staged, { force: true }).catch(() => undefined);
    if (!existsSync(destination) && existsSync(previous)) {
      await rename(previous, destination).catch(() => undefined);
    }
    throw error;
  }
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

async function ensureDesktopSetup(interactive: boolean): Promise<void> {
  const statePath = desktopSetupStatePath();
  if (existsSync(statePath)) return;

  const usageRoot = resolveUsageRootFromDisk().root;
  const setup = await runHelper([
    "setup",
    "--data-root",
    usageRoot,
    "--skip-terminal-config",
    "--migrate-terminal-wrappers",
  ]);
  if (setup.code !== 0) {
    const detail = setup.stderr.trim() || setup.stdout.trim();
    if (!interactive) throw new Error(detail || "Desktop setup failed.");
    await dialog.showMessageBox({
      type: "warning",
      title: "Agent Usage Stat Setup",
      message: "The application opened, but agent capture could not be connected.",
      detail,
    });
    return;
  }

  await mkdir(join(statePath, ".."), { recursive: true });
  await writeFile(
    statePath,
    JSON.stringify({
      version: app.getVersion(),
      configuredAt: new Date().toISOString(),
      dataRoot: usageRoot,
      helper: helperExecutablePath(),
    }, null, 2),
    "utf8",
  );

  if (
    interactive &&
    (setup.stdout + setup.stderr).includes("one final action")
  ) {
    await dialog.showMessageBox({
      type: "info",
      title: "Trust the Codex hook",
      message: "Codex needs one security confirmation.",
      detail: "Open /hooks in Codex and trust the Agent Usage Stat hook.",
    });
  }
}

function portalAssetsRoot(): string {
  return join(app.getAppPath(), "dist", "portal");
}

function portalDataRoot(): string {
  return join(app.getPath("userData"), "portal-data");
}

function isPathInside(root: string, path: string): boolean {
  const fromRoot = relative(resolve(root), resolve(path));
  return !fromRoot.startsWith("..") && !isAbsolute(fromRoot);
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function runSmokeTestIfRequested(): Promise<boolean> {
  const flag = "--desktop-smoke-test";
  const index = process.argv.indexOf(flag);
  if (index < 0) return false;

  const output = process.argv[index + 1];
  if (!output) throw new Error(`${flag} requires an output path.`);
  traceStartup("smoke-helper-begin");
  const helper = await runHelper(["probe"]);
  if (helper.code !== 0) throw new Error(helper.stderr || "Helper probe failed.");
  traceStartup("smoke-helper-complete");
  await ensureDesktopSetup(false);
  traceStartup("smoke-setup-complete");
  const refresh = await refreshPortalData();
  traceStartup("smoke-refresh-complete");
  const window = await createWindow(false);
  traceStartup("smoke-window-complete");
  const renderer = await window.webContents.executeJavaScript(`({
    title: document.title,
    hasTimeline: !!document.querySelector('[data-portal-view="sessions"]'),
    protocol: location.protocol
  })`) as { title: string; hasTimeline: boolean; protocol: string };
  traceStartup("smoke-renderer-complete");
  const smokeJson = JSON.stringify({
      application: app.getName(),
      version: app.getVersion(),
      packaged: app.isPackaged,
      assets: existsSync(join(portalAssetsRoot(), "index.html")),
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
  if (process.platform !== "win32") return false;
  const event = process.argv[1];
  if (!event?.startsWith("--squirrel-")) return false;

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
