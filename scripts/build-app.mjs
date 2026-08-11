#!/usr/bin/env node

import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const nodeModules = join(root, "node_modules");

await rm(dist, { recursive: true, force: true });
await run(process.execPath, [
  join(nodeModules, "typescript", "bin", "tsc"),
  "--noEmit",
  "-p",
  join(root, "tsconfig.json"),
]);
await run(process.execPath, [
  join(nodeModules, "typescript", "bin", "tsc"),
  "-p",
  join(root, "tsconfig.build.json"),
]);
await run(process.execPath, [
  join(nodeModules, "vite", "bin", "vite.js"),
  "build",
  "--config",
  join(root, "portal", "vite.config.ts"),
]);
await run(process.execPath, [join(root, "scripts", "build-icons.mjs")]);
await run(process.execPath, [join(root, "scripts", "build-helper.mjs")]);

function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}
