#!/usr/bin/env node

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import pngToIco from "png-to-ico";
import sharp from "sharp";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const logoSource = join(root, "portal", "logo.svg");
const output = join(root, "dist", "icons");
const work = join(output, "work");
const windowsSizes = [16, 24, 32, 48, 64, 128, 256];
const logoSvg = await readFile(logoSource, "utf8");
const lightLogoSource = themedLogoSource(logoSvg, "light");
const darkLogoSource = themedLogoSource(logoSvg, "dark");

await rm(output, { recursive: true, force: true });
await mkdir(work, { recursive: true });

const lightIcon = await sharp(lightLogoSource).resize(1024, 1024).png().toBuffer();
await Promise.all([
  writeFile(join(output, "icon-light.png"), lightIcon),
  sharp(darkLogoSource).resize(1024, 1024).png().toFile(join(output, "icon-dark.png")),
]);
const windowsPngs = await Promise.all(
  windowsSizes.map(async (size) => {
    const path = join(work, `icon-${size}.png`);
    await sharp(lightLogoSource).resize(size, size).png().toFile(path);
    return path;
  }),
);
await writeFile(join(output, "icon.ico"), await pngToIco(windowsPngs));
await buildInstallerAnimation(join(output, "install-loading.gif"));

if (process.platform === "darwin") {
  const iconset = join(work, "icon.iconset");
  await mkdir(iconset, { recursive: true });
  for (const size of [16, 32, 128, 256, 512]) {
    await sharp(lightLogoSource)
      .resize(size, size)
      .png()
      .toFile(join(iconset, `icon_${size}x${size}.png`));
    await sharp(lightLogoSource)
      .resize(size * 2, size * 2)
      .png()
      .toFile(join(iconset, `icon_${size}x${size}@2x.png`));
  }
  await run("iconutil", ["-c", "icns", iconset, "-o", join(output, "icon.icns")]);
}

await rm(work, { recursive: true, force: true });
process.stdout.write(`icons built in ${output}\n`);

function themedLogoSource(source, theme) {
  const themed = source.replace("<svg ", `<svg data-render-theme="${theme}" `);
  if (themed === source) throw new Error("Logo source is missing its root SVG element");
  return Buffer.from(themed);
}

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

async function buildInstallerAnimation(output) {
  const width = 420;
  const height = 220;
  const frames = 12;
  const brandIcon = await sharp(lightLogoSource).resize(132, 132).png().toBuffer();
  const images = await Promise.all(
    Array.from({ length: frames }, async (_, frame) => {
      const progress = 178 + Math.round((frame / (frames - 1)) * 204);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
        <rect width="${width}" height="${height}" fill="#f3f0e7"/>
        <text x="178" y="65" fill="#ba5d37" font-family="Segoe UI,Arial,sans-serif" font-size="11" font-weight="700" letter-spacing="2">AGENT USAGE STAT</text>
        <text x="178" y="96" fill="#171817" font-family="Segoe UI,Arial,sans-serif" font-size="22" font-weight="600">Installing application</text>
        <text x="178" y="121" fill="#686761" font-family="Segoe UI,Arial,sans-serif" font-size="13">Preparing files and shortcuts</text>
        <rect x="178" y="148" width="204" height="3" fill="#c8c4ba"/>
        <rect x="178" y="148" width="${progress - 178}" height="3" fill="#ba5d37"/>
      </svg>`;
      return sharp(Buffer.from(svg))
        .composite([{ input: brandIcon, left: 20, top: 44 }])
        .png()
        .toBuffer();
    }),
  );

  await sharp({
    create: {
      width,
      height: height * frames,
      channels: 4,
      background: "#f3f0e7",
      pageHeight: height,
    },
  })
    .composite(images.map((input, index) => ({ input, top: index * height, left: 0 })))
    .gif({ loop: 0, delay: Array(frames).fill(125), pageHeight: height, effort: 7 })
    .toFile(output);
}
