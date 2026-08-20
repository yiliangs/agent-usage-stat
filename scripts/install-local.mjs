#!/usr/bin/env node

/**
 * Refresh the installed desktop application from the current working tree.
 *
 * The machine keeps one installation. The Start Menu shortcut, the Squirrel
 * stub launcher, the uninstall entry, and `~/.agent-usage-stat` all stay
 * exactly where the installer put them; only the application payload behind
 * them is replaced. That is what lets a single install serve both daily use
 * and local iteration: build, run this, launch from the Start Menu.
 *
 * Run `npm run install:local`, which packages first. Running this file alone
 * only copies whatever `dist/forge` already holds.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { cp, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const productName = manifest.productName;
const home = process.env.HOME || process.env.USERPROFILE || "";
const helperVersionState = join(home, ".agent-usage-stat", "bin", "helper-version.json");

const packaged = packagedApplicationPath();
if (!existsSync(packaged)) {
  fail(
    `No packaged application at ${packaged}.\n` +
    "Run `npm run install:local`, which packages before installing.",
  );
}

const installed = await installedApplicationPath();
await closeRunningApplication();

const copied = await copyChanged(packaged, installed);
console.log(`Refreshed ${installed} (${copied} file${copied === 1 ? "" : "s"} copied)`);

// The application skips its helper sync when the recorded version matches the
// one it is running. Local iteration reuses a version, so clear the record and
// let the next launch compare the binaries themselves.
await rm(helperVersionState, { force: true });

await ensureStartMenuShortcut();

// The packaged tree was staging for this copy, and every run repackages from
// scratch, so leaving it behind would keep a second full application on the
// machine that nothing reads. Same reason the make hook prunes dist.
await rm(join(root, "dist", "forge"), { recursive: true, force: true });

function packagedApplicationPath() {
  const directory = join(
    root,
    "dist",
    "forge",
    `${productName}-${process.platform}-${process.arch}`,
  );
  return process.platform === "darwin"
    ? join(directory, `${productName}.app`)
    : directory;
}

/**
 * The installed payload directory. Squirrel keeps one `app-<version>` folder
 * per installed release and its stub launcher resolves the newest, so refresh
 * that one rather than minting a directory Squirrel does not know about.
 */
async function installedApplicationPath() {
  if (process.platform === "darwin") {
    const bundle = `/Applications/${productName}.app`;
    if (!existsSync(bundle)) fail(missingInstallMessage(bundle));
    return bundle;
  }

  const installRoot = join(
    process.env.LOCALAPPDATA || join(home, "AppData", "Local"),
    productName.replace(/\s+/g, ""),
  );
  if (!existsSync(installRoot)) fail(missingInstallMessage(installRoot));

  const versions = (await readdir(installRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("app-"))
    .map((entry) => entry.name)
    .sort(compareVersionDirectories);
  const newest = versions.at(-1);
  if (!newest) fail(missingInstallMessage(installRoot));
  return join(installRoot, newest);
}

function missingInstallMessage(location) {
  return (
    `No installed application at ${location}.\n` +
    "Install once with `npm run make` and the installer it writes to " +
    "dist/forge/make, then use this command for every build after that."
  );
}

function compareVersionDirectories(left, right) {
  const parse = (name) => name.slice(4).split(".").map(Number);
  const leftParts = parse(left);
  const rightParts = parse(right);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference) return difference;
  }
  return 0;
}

/** Copy every file whose size or timestamp differs, leaving extras in place. */
async function copyChanged(source, destination) {
  let copied = 0;
  await cp(source, destination, {
    recursive: true,
    force: true,
    filter(from, to) {
      const current = statSync(from);
      if (current.isDirectory()) return true;
      let existing;
      try {
        existing = statSync(to);
      } catch {
        copied += 1;
        return true;
      }
      const changed =
        existing.size !== current.size || existing.mtimeMs < current.mtimeMs;
      if (changed) copied += 1;
      return changed;
    },
  });
  return copied;
}

/**
 * A running instance holds its own executable open on Windows, and the kill
 * command returns before the process tree has actually gone, so wait for the
 * handles to drop rather than racing the copy against them.
 */
async function closeRunningApplication() {
  const closed = process.platform === "win32"
    ? await run("taskkill", ["/F", "/T", "/IM", `${productName}.exe`])
    : await run("pkill", ["-f", `${productName}.app`]);
  if (!closed) return;

  console.log(`Closed the running ${productName} instance`);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (!(await applicationIsRunning())) {
      await delay(250);
      return;
    }
    await delay(500);
  }
  fail(`${productName} is still running. Quit it and run this command again.`);
}

function applicationIsRunning() {
  return process.platform === "win32"
    ? run("tasklist", ["/FI", `IMAGENAME eq ${productName}.exe`, "/NH", "/FO", "CSV"], true)
      .then((output) => output.includes(`${productName}.exe`))
    : run("pgrep", ["-f", `${productName}.app`]);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

/**
 * The Squirrel installer creates the shortcut during `--squirrel-install`, and
 * that step can be interrupted. Restore it from the same Squirrel command
 * rather than hand-writing a shortcut file.
 */
async function ensureStartMenuShortcut() {
  if (process.platform !== "win32") return;
  const shortcut = join(
    process.env.APPDATA || join(home, "AppData", "Roaming"),
    "Microsoft", "Windows", "Start Menu", "Programs",
    manifest.author,
    `${productName}.lnk`,
  );
  if (existsSync(shortcut)) return;

  const updater = join(installed, "..", "Update.exe");
  if (!existsSync(updater)) return;
  await run(updater, [`--createShortcut=${productName}.exe`]);
  console.log(`Recreated the Start Menu shortcut at ${shortcut}`);
}

function run(command, args, captureOutput = false) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, {
      stdio: captureOutput ? ["ignore", "pipe", "ignore"] : "ignore",
      windowsHide: true,
    });
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += chunk;
    });
    child.once("error", () => resolveRun(captureOutput ? "" : false));
    child.once("exit", (code) => resolveRun(captureOutput ? output : code === 0));
  });
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
