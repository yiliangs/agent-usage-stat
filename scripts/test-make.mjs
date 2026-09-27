#!/usr/bin/env node

// Runs every maker in forge.config.cjs into a scratch output directory and
// asserts the installers a release uploads were written. `test:desktop` only
// packages, so without this the makers array and the postMake prune are first
// exercised when a version tag has already been pushed (#118).

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactRoot = join(root, "dist");
// forge.config.cjs accepts only one directory directly under dist/.
const outRelative = `dist/make-smoke-${process.pid}`;
const out = join(root, outRelative);
const forgeCli = join(
  root,
  "node_modules",
  "@electron-forge",
  "cli",
  "dist",
  "electron-forge.js",
);

// The same artifacts desktop-release.yml uploads, per platform. Each entry is
// a directory under make/ and a filename test; each must match at least once.
const expected = process.platform === "win32"
  ? [
    ["squirrel.windows/x64", (name) => name === "Agent-Usage-Stat-Setup.exe"],
    ["squirrel.windows/x64", (name) => name === "RELEASES"],
    ["squirrel.windows/x64", (name) => name.endsWith("-full.nupkg")],
    [`zip/win32/${process.arch}`, (name) => name.endsWith(".zip")],
  ]
  : process.platform === "darwin"
    ? [
      [".", (name) => name.endsWith(".dmg")],
      [`zip/darwin/${process.arch}`, (name) => name.endsWith(".zip")],
    ]
    : null;
assert.ok(expected, `No installer expectations for ${process.platform}`);

try {
  await run(process.execPath, [forgeCli, "make"], {
    ...process.env,
    AGENT_USAGE_STAT_FORGE_OUT: outRelative,
  });

  const make = join(out, "make");
  for (const [directory, matches] of expected) {
    const dir = join(make, directory);
    const names = existsSync(dir) ? await readdir(dir) : [];
    assert.ok(
      names.some(matches),
      `No expected installer artifact in ${relative(root, dir)}. Found: ${names.join(", ") || "nothing"}\n${await listing(make)}`,
    );
  }

  // postMake keeps the installers and discards everything else: the forge
  // output holds only make/, and dist/ holds only the forge output. A prune
  // that removes the wrong directory fails here rather than on a release.
  assert.deepEqual(await readdir(out), ["make"], "postMake left more than make/ in the forge output");
  assert.deepEqual(
    (await readdir(artifactRoot)).filter((name) => !name.startsWith("make-smoke-")),
    [],
    "postMake left build output beside the forge output in dist/",
  );

  process.stdout.write(
    `make smoke ok: ${process.platform}/${process.arch} -> ${outRelative}\n${await listing(make)}`,
  );
} finally {
  await rm(out, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
}

async function listing(dir) {
  if (!existsSync(dir)) return `(${relative(root, dir)} does not exist)\n`;
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => `  ${relative(dir, join(entry.parentPath ?? entry.path, entry.name)).split(sep).join("/")}\n`)
    .join("");
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
      reject(new Error(`${command} exited with code ${code}\n${stdout}\n${stderr}`));
    });
  });
}
