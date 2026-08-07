#!/usr/bin/env node

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
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

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outRelative = `out/desktop-smoke-${process.pid}`;
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

const home = await mkdtemp(join(tmpdir(), "agent-usage-stat-desktop-"));
const usageRoot = join(home, "usage");
const claudeHome = join(home, ".claude");
const codexHome = join(home, ".codex");
const copilotHome = join(home, ".copilot");
const smokeOutput = join(home, "desktop-smoke.json");
const startupTrace = join(home, "desktop-startup.log");

try {
  await Promise.all([
    mkdir(join(usageRoot, "logbook.d"), { recursive: true }),
    mkdir(claudeHome, { recursive: true }),
    mkdir(codexHome, { recursive: true }),
    mkdir(copilotHome, { recursive: true }),
  ]);
  await writeFile(
    join(home, ".agent-usage-stat.config.json"),
    JSON.stringify({ version: "3.0.0", dataRoot: usageRoot }),
    "utf8",
  );

  const launch = await run(
    executable,
    [`--user-data-dir=${home}`, "--desktop-smoke-test", smokeOutput],
    {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CLAUDE_CONFIG_DIR: claudeHome,
      CODEX_HOME: codexHome,
      COPILOT_HOME: copilotHome,
      AGENT_USAGE_STAT_STARTUP_TRACE: startupTrace,
    },
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
  assert.equal(smoke.helper.runtime, "standalone");
  assert.equal(smoke.setup, true);
  assert.equal(smoke.renderer.title, "Agent Usage Stat");
  assert.equal(smoke.renderer.hasTimeline, true);
  assert.equal(smoke.renderer.protocol, "aus:");
  assert.equal(smoke.refresh.sessions, 0);

  const installedHelper = process.platform === "win32"
    ? join(home, ".agent-usage-stat", "bin", "agent-usage-stat-helper.exe")
    : join(home, ".agent-usage-stat", "bin", "agent-usage-stat-helper");
  assert.equal(existsSync(installedHelper), true);

  const claudeSettings = await readFile(
    join(claudeHome, "settings.json"),
    "utf8",
  );
  const codexHooks = await readFile(join(codexHome, "hooks.json"), "utf8");
  const copilotHooks = await readFile(
    join(copilotHome, "hooks", "agent-usage-stat.json"),
    "utf8",
  );
  assert.match(claudeSettings, /agent-usage-stat-helper/);
  assert.match(codexHooks, /agent-usage-stat-helper/);
  assert.doesNotMatch(codexHooks, /node .*agent-usage-stat-helper/);
  assert.match(copilotHooks, /agent-usage-stat-helper/);
  assert.doesNotMatch(copilotHooks, /node .*agent-usage-stat-helper/);

  process.stdout.write(
    `desktop smoke ok: ${process.platform}/${process.arch} -> ${outRelative}\n`,
  );
} finally {
  await rm(home, { recursive: true, force: true });
}

function run(command, args, environment) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
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
