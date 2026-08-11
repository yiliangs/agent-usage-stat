#!/usr/bin/env node

import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const buildRoot = join(root, "dist", "helper");
const bundlePath = join(buildRoot, "helper.cjs");
const blobPath = join(buildRoot, "helper.blob");
const executableName = process.platform === "win32"
  ? "agent-usage-stat-helper.exe"
  : "agent-usage-stat-helper";
const executablePath = join(buildRoot, executableName);
const configPath = join(buildRoot, "sea-config.json");

await rm(buildRoot, { recursive: true, force: true });
await mkdir(buildRoot, { recursive: true });

await build({
  entryPoints: [join(root, "src", "helper.ts")],
  outfile: bundlePath,
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  sourcemap: false,
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
  },
});

await writeFile(
  configPath,
  JSON.stringify({
    main: bundlePath,
    output: blobPath,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
  }, null, 2),
  "utf8",
);

await run(process.execPath, ["--experimental-sea-config", configPath]);
await copyFile(process.execPath, executablePath);

if (process.platform === "darwin") {
  await run("codesign", ["--remove-signature", executablePath], { allowFailure: true });
}

const postject = join(root, "node_modules", "postject", "dist", "cli.js");
const postjectArgs = [
  postject,
  executablePath,
  "NODE_SEA_BLOB",
  blobPath,
  "--sentinel-fuse",
  "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  "--overwrite",
];
if (process.platform === "darwin") {
  postjectArgs.push("--macho-segment-name", "NODE_SEA");
}
await run(process.execPath, postjectArgs);

if (process.platform === "darwin") {
  await run("codesign", ["--sign", "-", executablePath]);
}

await Promise.all([
  rm(bundlePath, { force: true }),
  rm(blobPath, { force: true }),
  rm(configPath, { force: true }),
]);
process.stdout.write(`${executablePath}\n`);

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0 || options.allowFailure) resolvePromise();
      else reject(new Error(`${basename(command)} exited with code ${code}`));
    });
  });
}
