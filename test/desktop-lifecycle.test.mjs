import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { squirrelLifecycleEvent } from "../dist/desktop/squirrel-events.js";
import { startupMode } from "../dist/desktop/startup-policy.js";

const require = createRequire(import.meta.url);

test("cached launches show the dashboard while first launches block on setup", () => {
  assert.equal(startupMode(true), "cached");
  assert.equal(startupMode(false), "first-run");
});

test("the dashboard exposes a corner status for background synchronization", async () => {
  const script = await readFile(join(process.cwd(), "portal", "portal.js"), "utf8");

  assert.match(script, /window\.agentUsageStatSetSyncState\s*=/);
  assert.match(script, /SYNCING/);
  assert.match(script, /SYNC FAILED/);
});

test("the dashboard uses the canonical application favicon", async () => {
  const html = await readFile(join(process.cwd(), "portal", "index.html"), "utf8");

  assert.match(html, /<link rel="icon" type="image\/png" href="\.\.\/assets\/logo\.png">/);
  assert.match(html, /<img src="\.\.\/assets\/logo\.png" alt="">/);
});

test("Squirrel first run enters the application instead of quitting", () => {
  assert.equal(
    squirrelLifecycleEvent("win32", ["Agent Usage Stat.exe", "--squirrel-firstrun"]),
    null,
  );
});

test("only Squirrel lifecycle events are intercepted", () => {
  for (const event of [
    "--squirrel-install",
    "--squirrel-updated",
    "--squirrel-uninstall",
    "--squirrel-obsolete",
  ]) {
    assert.equal(
      squirrelLifecycleEvent("win32", ["Agent Usage Stat.exe", event]),
      event,
    );
  }
  assert.equal(
    squirrelLifecycleEvent("darwin", ["Agent Usage Stat", "--squirrel-install"]),
    null,
  );
});

test("Windows packaging includes branded installation and a portable archive", () => {
  const config = require("../forge.config.cjs");
  const squirrel = config.makers.find((maker) => maker.name.includes("squirrel"));
  const zip = config.makers.find((maker) => maker.name.includes("maker-zip"));

  assert.equal(squirrel.config.name, "AgentUsageStat");
  assert.equal(squirrel.config.exe, "Agent Usage Stat.exe");
  assert.equal(existsSync(squirrel.config.loadingGif), true);
  assert.equal(existsSync(squirrel.config.setupIcon), true);
  assert.equal(config.packagerConfig.ignore("/assets"), false);
  assert.equal(config.packagerConfig.ignore("/assets/logo.png"), false);
  assert.equal(config.packagerConfig.ignore("/assets/icon-source.png"), true);
  assert.equal(zip.platforms.includes("win32"), true);
  assert.equal(
    squirrel.config.loadingGif,
    join(process.cwd(), "assets", "install-loading.gif"),
  );
});
