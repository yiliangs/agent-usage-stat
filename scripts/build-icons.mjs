#!/usr/bin/env node

import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import pngToIco from "png-to-ico";
import sharp from "sharp";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assets = join(root, "assets");
const source = join(assets, "icon.svg");
const work = join(root, "build", "icons");
const windowsSizes = [16, 24, 32, 48, 64, 128, 256];

await rm(work, { recursive: true, force: true });
await mkdir(work, { recursive: true });

await sharp(source).resize(1024, 1024).png().toFile(join(assets, "icon.png"));
const windowsPngs = await Promise.all(
  windowsSizes.map(async (size) => {
    const path = join(work, `icon-${size}.png`);
    await sharp(source).resize(size, size).png().toFile(path);
    return path;
  }),
);
await writeFile(join(assets, "icon.ico"), await pngToIco(windowsPngs));

if (process.platform === "darwin") {
  const iconset = join(work, "icon.iconset");
  await mkdir(iconset, { recursive: true });
  for (const size of [16, 32, 128, 256, 512]) {
    await sharp(source)
      .resize(size, size)
      .png()
      .toFile(join(iconset, `icon_${size}x${size}.png`));
    await sharp(source)
      .resize(size * 2, size * 2)
      .png()
      .toFile(join(iconset, `icon_${size}x${size}@2x.png`));
  }
  await run("iconutil", ["-c", "icns", iconset, "-o", join(assets, "icon.icns")]);
}

process.stdout.write(`icons built in ${assets}\n`);

function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}
