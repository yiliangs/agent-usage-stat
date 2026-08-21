import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

test("the repository exposes one dependency manifest and one build entry point", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const alternateBuilds = Object.keys(manifest.scripts)
    .filter((name) => name.startsWith("build:"));

  assert.equal(existsSync(join(root, "portal", "package.json")), false);
  assert.equal(existsSync(join(root, "portal", "package-lock.json")), false);
  assert.deepEqual(alternateBuilds, []);
  assert.equal(manifest.scripts.build, "node scripts/build-app.mjs");
});

test("the source tree contains no generated build products", () => {
  assert.equal(existsSync(join(root, "portal", "node_modules")), false);
  assert.equal(existsSync(join(root, "portal", "public")), false);
});

test("the brand source is the portal's own asset", () => {
  // The header mark, the favicon, and every OS icon come from this one file.
  // It has to sit inside the Vite root, because a reference that leaves the
  // root resolves during the build and 404s in the development server (#57).
  assert.equal(existsSync(join(root, "portal", "logo.svg")), true);
  assert.equal(existsSync(join(root, "assets")), false);
});

test("the repository root contains no disposable preview artifacts", () => {
  const disposable = readdirSync(root)
    .filter((name) =>
      /^readme-preview(?:\.|$)/i.test(name) ||
      /^screenshot(?:[-.]|$)/i.test(name) ||
      /\.(?:tgz|tmp|bak)$/i.test(name)
    )
    .sort();

  assert.deepEqual(disposable, []);
});

test("the canonical build writes every application artifact under dist", () => {
  const helperName = process.platform === "win32"
    ? "agent-usage-stat-helper.exe"
    : "agent-usage-stat-helper";
  const expected = [
    join("dist", "desktop", "main.js"),
    join("dist", "helper.js"),
    join("dist", "portal", "index.html"),
    join("dist", "portal", "panel.html"),
    join("dist", "helper", helperName),
    join("dist", "icons", "icon-light.png"),
    join("dist", "icons", "icon-dark.png"),
  ];

  for (const relativePath of expected) {
    assert.equal(existsSync(join(root, relativePath)), true, relativePath);
  }
  assert.equal(existsSync(join(root, "build")), false);
  assert.equal(existsSync(join(root, "out")), false);
});

test("the canonical artifact tree contains no intermediate build stages", () => {
  const helperName = process.platform === "win32"
    ? "agent-usage-stat-helper.exe"
    : "agent-usage-stat-helper";
  const helperFiles = readdirSync(join(root, "dist", "helper")).sort();

  assert.deepEqual(helperFiles, [helperName]);
  assert.equal(existsSync(join(root, "dist", "icons", "work")), false);
  assert.equal(existsSync(join(root, "dist", "desktop", "main.d.ts")), false);
});

test("every local README image resolves to a file in the repository", () => {
  // The visual tour was lost once when a build-path cleanup removed the loose
  // root screenshots and stripped the README references with them. Product
  // images live under readme-assets/, outside the root-artifact rule above.
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const markdown = [...readme.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)];
  const html = [...readme.matchAll(/<img\s[^>]*src=["']([^"']+)["']/gi)];
  const referenced = [...new Set([...markdown, ...html].map(([, path]) => path))]
    .filter((path) => !/^[a-z][a-z0-9+.-]*:/i.test(path));

  assert.ok(referenced.length > 0, "README must keep its product images");
  assert.deepEqual(
    referenced.filter((path) => !existsSync(join(root, path))),
    [],
  );
});
