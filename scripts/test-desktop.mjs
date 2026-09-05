#!/usr/bin/env node

import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { PANEL_SIZE } from "../dist/desktop/status-area-policy.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outRelative = `dist/desktop-smoke-${process.pid}`;
const out = join(root, outRelative);
const forgeCli = join(
  root,
  "node_modules",
  "@electron-forge",
  "cli",
  "dist",
  "electron-forge.js",
);

await run(process.execPath, [forgeCli, "package"], {
  ...process.env,
  AGENT_USAGE_STAT_FORGE_OUT: outRelative,
});

const packageDir = join(
  out,
  `Agent Usage Stat-${process.platform}-${process.arch}`,
);
const executable = process.platform === "win32"
  ? join(packageDir, "Agent Usage Stat.exe")
  : join(packageDir, "Agent Usage Stat.app", "Contents", "MacOS", "Agent Usage Stat");
assert.equal(existsSync(executable), true, `Missing packaged executable: ${executable}`);

if (process.platform === "darwin") {
  // The hardened runtime enforces library validation, and an ad-hoc signature
  // carries no team identity to satisfy it, so dyld refuses to map Electron
  // Framework and the application dies at launch. 3.0.0 and 3.0.1 both shipped
  // that way: the option that turns it off is read per file through
  // `optionsForFile`, so setting it at the top level did nothing and said
  // nothing. Launching here would not have caught it either, because
  // enforcement differs by macOS version. Read the signature instead.
  const appPath = join(packageDir, "Agent Usage Stat.app");
  const { stderr } = await run("codesign", ["-d", "-vv", appPath], process.env);
  const flags = /^CodeDirectory\b.*?\bflags=(\S+)/m.exec(stderr)?.[1];
  assert.ok(flags, `codesign reported no CodeDirectory flags:\n${stderr}`);
  if (flags.includes("adhoc")) {
    assert.ok(
      !flags.includes("runtime"),
      `Ad-hoc signed build carries the hardened runtime (flags=${flags}). It cannot launch.`,
    );
  }
}

const home = await mkdtemp(join(tmpdir(), "agent-usage-stat-desktop-"));
const usageRoot = join(home, "usage");
const claudeHome = join(home, ".claude");
const codexHome = join(home, ".codex");
const copilotHome = join(home, ".copilot");
// opencode splits its two directories, so the fixture has to place both.
const opencodeData = join(home, "xdg-data");
const opencodeConfig = join(home, "xdg-config");
const opencodeHome = join(opencodeData, "opencode");
// The stable installed helper: the one executable every host hook has to
// spawn, and the only one that survives the update which deletes the versioned
// application directory the packaged app itself runs from.
const installedHelper = join(
  home,
  ".agent-usage-stat",
  "bin",
  process.platform === "win32"
    ? "agent-usage-stat-helper.exe"
    : "agent-usage-stat-helper",
);
const smokeOutput = join(home, "desktop-smoke.json");
const startupTrace = join(home, "desktop-startup.log");
const cachedStartupTrace = join(home, "desktop-cached-startup.log");

try {
  await Promise.all([
    mkdir(join(usageRoot, "logbook.d"), { recursive: true }),
    mkdir(claudeHome, { recursive: true }),
    mkdir(codexHome, { recursive: true }),
    mkdir(copilotHome, { recursive: true }),
    mkdir(opencodeHome, { recursive: true }),
  ]);
  await writeFile(
    join(home, ".agent-usage-stat.config.json"),
    JSON.stringify({ version: "3.0.0", dataRoot: usageRoot }),
    "utf8",
  );

  const desktopEnvironment = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: claudeHome,
    CODEX_HOME: codexHome,
    COPILOT_HOME: copilotHome,
    XDG_DATA_HOME: opencodeData,
    XDG_CONFIG_HOME: opencodeConfig,
  };
  const launch = await run(
    executable,
    [`--user-data-dir=${home}`, "--desktop-smoke-test", smokeOutput],
    {
      ...desktopEnvironment,
      AGENT_USAGE_STAT_STARTUP_TRACE: startupTrace,
    },
    // Windows passes a hidden-window flag from the spawn down to the process
    // it starts, and the first window shown then stays hidden however often it
    // is asked to appear. The status-area panel opening is part of what this
    // run checks, so the flag has to be off; the dashboard window the smoke
    // creates is not shown either way.
    { windowsHide: false },
  );

  const trace = await readFile(startupTrace, "utf8").catch(() => "no startup trace");
  const smokeJson = await readFile(smokeOutput, "utf8").catch(() => "");
  assert.ok(
    smokeJson.trim(),
    `Packaged app produced an empty smoke result.\n${launch.stdout}\n${launch.stderr}\n${trace}`,
  );
  const smoke = JSON.parse(smokeJson);
  assert.equal(smoke.packaged, true);
  assert.equal(smoke.assets, true);
  assert.equal(smoke.runtimeIcon, true);
  assert.equal(smoke.helper.runtime, "standalone");
  assert.equal(smoke.setup, true);
  assert.equal(smoke.renderer.title, "Agent Usage Stat");
  assert.equal(smoke.renderer.hasTimeline, true);
  assert.equal(smoke.renderer.logoLoaded, true);
  assert.match(smoke.renderer.favicon, /^aus:\/\/app\/assets\/logo-.*\.svg$/);
  assert.equal(smoke.renderer.protocol, "aus:");
  assert.equal(smoke.refresh.sessions, 0);
  assert.equal(smoke.settings.api, true);
  assert.equal(smoke.settings.visible, true);
  assert.equal(smoke.settings.commonRows, 3);
  assert.equal(smoke.settings.captureChannels, 4);
  assert.equal(smoke.settings.captureStatus, "WARNING");
  assert.equal(smoke.settings.advanced, true);
  assert.equal(smoke.settings.providerRows, 4);
  assert.deepEqual(smoke.settings.providers, [
    "claude",
    "codex",
    "copilot",
    "opencode",
  ]);
  assert.deepEqual(smoke.settings.providerMonitorStatuses, [
    "warning",
    "warning",
    "warning",
    "warning",
  ]);

  assert.equal(smoke.home.view, "overview");
  assert.equal(smoke.home.markSelectable, false);

  // The status area is wired on Windows only; the macOS menu bar is issue #47.
  if (process.platform === "win32") {
    assert.equal(smoke.statusArea.installed, true);
    assert.equal(smoke.statusArea.opened, true, JSON.stringify(smoke.statusArea));
    assert.equal(smoke.statusArea.dismissed, true);
    // Written after the dashboard window was destroyed: the application is
    // held open by the status area rather than quitting with its window.
    assert.equal(smoke.statusArea.residentAfterClose, true);
    // The panel draws its own hairline frame at the very edge of its content,
    // and Windows paints its window border over the outermost point of the
    // window rect. A window rect larger than the content rect therefore hides
    // that frame on whichever edges the content is flush with, which is how
    // the panel came to show one stray rule down its left side (#139). The
    // window and its content have to be the same rectangle, and it has to be
    // the size the placement policy clamps against.
    assert.deepEqual(
      smoke.statusArea.frame.window,
      smoke.statusArea.frame.content,
      `panel window rect differs from its content rect: ${JSON.stringify(smoke.statusArea.frame)}`,
    );
    assert.equal(smoke.statusArea.frame.content.width, PANEL_SIZE.width);
    assert.equal(smoke.statusArea.frame.content.height, PANEL_SIZE.height);
    assert.equal(smoke.statusArea.glance.surface, "panel");
    assert.equal(smoke.statusArea.glance.ready, true);
    // The fixture ledger is empty, and the panel says so in each band rather
    // than printing a figure it does not have. The charts are still drawn:
    // a day has twenty-four hours and a half year has 182 days whether or not
    // anything happened in them.
    assert.equal(smoke.statusArea.glance.todayTokens, "0");
    assert.equal(smoke.statusArea.glance.todayCost, "$0.00");
    assert.equal(smoke.statusArea.glance.todayNote, "No sessions");
    assert.equal(smoke.statusArea.glance.todayDelta, "No prior baseline");
    assert.equal(smoke.statusArea.glance.weekMeta, "0 · $0.00");
    assert.equal(smoke.statusArea.glance.bars, 24);
    assert.ok(smoke.statusArea.glance.cells >= 182, `heatmap cells: ${smoke.statusArea.glance.cells}`);
    assert.equal(smoke.statusArea.glance.models, 0);
    assert.equal(smoke.statusArea.glance.modelsEmpty, true);
  } else {
    assert.equal(smoke.statusArea.installed, false);
  }

  assert.equal(existsSync(installedHelper), true);
  const setupState = JSON.parse(await readFile(
    join(home, ".agent-usage-stat", "desktop-setup.json"),
    "utf8",
  ));
  assert.deepEqual(setupState.capturePolicy, { default: "continuous" });
  assert.deepEqual(Object.keys(setupState.providerDataRoots).sort(), [
    "claude",
    "codex",
    "copilot",
    "opencode",
  ]);

  const claudeSettings = await readFile(
    join(claudeHome, "settings.json"),
    "utf8",
  );
  const codexHooks = await readFile(join(codexHome, "hooks.json"), "utf8");
  const copilotHooks = await readFile(
    join(copilotHome, "hooks", "agent-usage-stat.json"),
    "utf8",
  );
  // The opencode plugin lands in the configuration directory, not the data
  // directory the other three use for both purposes.
  const opencodePlugin = await readFile(
    join(opencodeConfig, "opencode", "plugin", "agent-usage-stat.js"),
    "utf8",
  );
  assertHookTargetsInstalledHelper("Claude settings.json", claudeSettings);
  assertHookTargetsInstalledHelper("Codex hooks.json", codexHooks);
  assertHookTargetsInstalledHelper("Copilot agent-usage-stat.json", copilotHooks);
  assertHookTargetsInstalledHelper("opencode agent-usage-stat.js", opencodePlugin);
  const claudeHookConfig = JSON.parse(claudeSettings);
  assert.equal(claudeHookConfig.hooks.Stop.length, 1);
  assert.equal(claudeHookConfig.hooks.SessionEnd.length, 1);
  assert.doesNotMatch(codexHooks, /node .*agent-usage-stat-helper/);
  assert.doesNotMatch(copilotHooks, /node .*agent-usage-stat-helper/);
  assert.doesNotMatch(opencodePlugin, /"node"/);

  const cachedTrace = await launchUntilTrace(
    executable,
    [`--user-data-dir=${home}`],
    {
      ...desktopEnvironment,
      AGENT_USAGE_STAT_STARTUP_TRACE: cachedStartupTrace,
    },
    cachedStartupTrace,
    "cached-window-ready",
  );
  assert.doesNotMatch(cachedTrace, /startup-window-ready/);
  const moduleLoadedAt = traceTime(cachedTrace, "module-loaded");
  const cachedWindowAt = traceTime(cachedTrace, "cached-window-ready");
  assert.ok(
    cachedWindowAt - moduleLoadedAt < 2000,
    `Cached dashboard took ${cachedWindowAt - moduleLoadedAt} ms to open.\n${cachedTrace}`,
  );

  process.stdout.write(
    `desktop smoke ok: ${process.platform}/${process.arch} -> ${outRelative}\n`,
  );
} finally {
  // Windows holds the image of a process for a moment after it exits, so
  // deleting the application this smoke test just launched can fail with
  // EPERM even though every assertion above passed. Retry rather than turn a
  // successful run into a failed one.
  const discard = { recursive: true, force: true, maxRetries: 20, retryDelay: 150 };
  await Promise.all([
    rm(home, discard),
    rm(out, discard),
  ]);
}

function launchUntilTrace(
  command,
  args,
  environment,
  tracePath,
  expected,
  timeoutMs = 10_000,
) {
  return new Promise((resolveLaunch, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    let settled = false;
    let poll;
    let timeout;
    child.stderr.on("data", (chunk) => (stderr += chunk));

    const finish = async (error, trace = "") => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timeout);
      if (child.exitCode === null) {
        child.kill();
        await new Promise((resolveExit) => {
          child.once("exit", resolveExit);
          setTimeout(resolveExit, 1000);
        });
      }
      if (error) reject(error);
      else resolveLaunch(trace);
    };
    poll = setInterval(async () => {
      const trace = await readFile(tracePath, "utf8").catch(() => "");
      if (trace.includes(expected)) {
        void finish(null, trace);
      }
    }, 25);
    timeout = setTimeout(() => {
      void finish(new Error(
        `Packaged app did not reach ${expected} within ${timeoutMs} ms.\n${stderr}`,
      ));
    }, timeoutMs);
    child.once("error", (error) => void finish(error));
    child.once("exit", (code) => {
      if (!settled) {
        void finish(new Error(
          `Packaged app exited with code ${code} before ${expected}.\n${stderr}`,
        ));
      }
    });
  });
}

/**
 * A host hook has to spawn the installed helper by its stable path. Pointing
 * it into the packaged application instead, which is what `process.resourcesPath`
 * and any hook written from the Electron main process rather than the spawned
 * helper resolve to, still reads as `agent-usage-stat-helper` and still works
 * on the machine that wrote it. It breaks on the next update, when the old
 * `app-<version>` directory is deleted and capture stops silently, so a
 * substring match on the helper's name is not enough (#117).
 */
function assertHookTargetsInstalledHelper(label, content) {
  // Every writer renders the path through JSON.stringify: the three JSON hook
  // files serialize the command string, and the opencode plugin embeds
  // `const COMMAND`. On Windows that doubles each backslash, so the escaped
  // form is what lands on disk. macOS resolves the helper's own execPath
  // through /private, which names the same file as the fixture's /var path.
  const written = [...new Set([installedHelper, realpathSync(installedHelper)])]
    .map((path) => JSON.stringify(path).slice(1, -1));
  assert.ok(
    written.some((path) => content.includes(path)),
    `${label} does not spawn the installed helper ${installedHelper}:\n${content}`,
  );
  assert.doesNotMatch(
    content,
    /app-\d/,
    `${label} spawns a versioned application directory`,
  );
  assert.doesNotMatch(
    content,
    /[\\/]resources[\\/]/i,
    `${label} spawns a path inside a packaged resources directory`,
  );
}

function traceTime(trace, event) {
  const line = trace.split(/\r?\n/).find((entry) => entry.endsWith(` ${event}`));
  assert.ok(line, `Missing startup trace event: ${event}`);
  return Date.parse(line.slice(0, line.indexOf(" ")));
}

function run(command, args, environment, { windowsHide = true } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolveRun({ stdout, stderr });
        return;
      }
      reject(new Error(
        `${command} exited with code ${code}\n${stdout}\n${stderr}`,
      ));
    });
  });
}
