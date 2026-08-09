import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { squirrelLifecycleEvent } from "../dist/desktop/squirrel-events.js";
import {
  firstRunPortalUrl,
  startupMode,
} from "../dist/desktop/startup-policy.js";
import {
  ledgerLocationPrompt,
  ledgerMigrationPrompt,
} from "../dist/desktop/ledger-onboarding.js";
import { capturePolicyPrompt } from "../dist/desktop/capture-policy.js";

const require = createRequire(import.meta.url);

test("cached launches show the dashboard while first launches block on setup", () => {
  assert.equal(startupMode(true), "cached");
  assert.equal(startupMode(false), "first-run");
});

test("failed first-run agent detection opens advanced settings", () => {
  assert.equal(firstRunPortalUrl("aus://app/index.html", true), "aus://app/index.html");
  assert.equal(
    firstRunPortalUrl("aus://app/index.html", false),
    "aus://app/index.html#settings",
  );
});

test("first-run storage choice explains the local default and shared ledgers", () => {
  assert.deepEqual(
    ledgerLocationPrompt({
      root: "C:\\Users\\Alex\\AppData\\Local\\Agent Usage Stat\\ledger",
      source: "default",
    }),
    {
      message: "Where should usage history be stored?",
      detail:
        "On this computer:\n" +
        "C:\\Users\\Alex\\AppData\\Local\\Agent Usage Stat\\ledger\n\n" +
        "Using multiple computers? Choose a folder in Google Drive, OneDrive, Dropbox, or another synchronized drive, then select that same synchronized folder on each computer. Paths may differ by machine.\n\n" +
        "The ledger contains usage totals, model names, project names, branches, and local project paths. It does not contain prompt or response text.",
      buttons: ["Use Local Storage", "Choose Another Folder..."],
    },
  );
});

test("changing folders offers migration and preserves the original by default", () => {
  assert.deepEqual(
    ledgerMigrationPrompt("C:\\old-ledger", "D:\\new-ledger"),
    {
      message: "Migrate existing usage history?",
      detail:
        "Existing history will be merged into the new ledger without replacing newer records.\n\n" +
        "From: C:\\old-ledger\n" +
        "To: D:\\new-ledger",
      buttons: ["Continue", "Cancel"],
      checkboxLabel: "Keep the original ledger as a backup",
      checkboxChecked: true,
    },
  );
});

test("first-run capture choice treats hooks as best effort and explains recovery", () => {
  assert.deepEqual(capturePolicyPrompt(), {
    message: "How should usage be captured?",
    detail:
      "Continuous capture (recommended) uses agent hooks to checkpoint usage while you work. Hooks are best effort, so Agent Usage Stat also reconciles transcripts whenever the application opens and when you choose Sync now.\n\n" +
      "Batch sync installs no hooks. Sessions deleted by an agent before the next application sync cannot be recovered.",
    buttons: ["Use Continuous Capture", "Use Batch Sync"],
  });
});

test("the dashboard exposes a corner status for background synchronization", async () => {
  const script = await readFile(join(process.cwd(), "portal", "portal.js"), "utf8");

  assert.match(script, /window\.agentUsageStatSetSyncState\s*=/);
  assert.match(script, /SYNCING/);
  assert.match(script, /SYNC FAILED/);
});

test("the dashboard uses the adaptive application mark with a PNG favicon fallback", async () => {
  const html = await readFile(join(process.cwd(), "portal", "index.html"), "utf8");

  assert.match(html, /<link rel="icon" type="image\/png" href="\.\.\/assets\/logo\.png\?v=mark-7b-adaptive">/);
  assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="\.\.\/assets\/logo\.svg\?v=mark-7b-adaptive">/);
  assert.match(html, /<img src="\.\.\/assets\/logo\.svg\?v=mark-7b-adaptive" alt="">/);
});

test("settings separate common controls from advanced agent locations", async () => {
  const html = await readFile(join(process.cwd(), "portal", "index.html"), "utf8");
  const script = await readFile(join(process.cwd(), "portal", "portal.js"), "utf8");

  assert.match(html, /data-portal-view="settings"/);
  assert.match(html, /Usage ledger folder/);
  assert.match(html, /Capture policy/);
  assert.match(html, />Continuous</);
  assert.match(html, />Batch sync</);
  assert.match(html, /<details[^>]*class="settings-advanced"/);
  assert.match(html, /Per-agent capture and locations/);
  assert.match(script, /\/api\/settings/);
  assert.match(script, /Best-effort hook/);
  assert.match(script, /Last hook attempt/);
  assert.match(script, /Last successful checkpoint/);
  assert.match(script, /data-settings-action="capture-policy"/);
  assert.match(script, /Use default/);
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
  assert.equal(config.packagerConfig.ignore("/assets/logo.svg"), false);
  assert.equal(config.packagerConfig.ignore("/assets/icon-source.png"), true);
  assert.equal(config.packagerConfig.ignore("/assets/icon-rounded-source.png"), true);
  assert.equal(zip.platforms.includes("win32"), true);
  assert.equal(
    squirrel.config.loadingGif,
    join(process.cwd(), "assets", "install-loading.gif"),
  );
});
