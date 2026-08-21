import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { squirrelLifecycleEvent } from "../dist/desktop/squirrel-events.js";
import {
  firstRunPortalUrl,
  startupIconFilename,
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

test("the settings control names its destination and uses a Lucide icon", async () => {
  const html = await readFile(join(process.cwd(), "portal", "index.html"), "utf8");
  const script = await readFile(join(process.cwd(), "portal", "portal.js"), "utf8");

  assert.match(
    html,
    /<button class="capture-monitor-link[^>]*data-capture-monitor-link[^>]*aria-label="Open Settings: Checking"[^>]*>.*?<i[^>]*data-lucide="settings"[^>]*><\/i>\s*<span class="capture-monitor-label">Settings<\/span>.*?<\/button>/s,
  );
  assert.match(html, /\.capture-monitor-link\s*\{[^}]*border:\s*1px solid/s);
  assert.match(script, /import \{ createIcons, Settings \} from 'lucide'/);
});

test("the settings control distinguishes hover from the active page", async () => {
  const html = await readFile(join(process.cwd(), "portal", "index.html"), "utf8");
  const script = await readFile(join(process.cwd(), "portal", "portal.js"), "utf8");

  assert.match(
    html,
    /\.capture-monitor-link:hover\s*\{[^}]*background:\s*rgba\(var\(--ink-rgb\),\s*\.06\);[^}]*color:\s*var\(--ink\);/s,
  );
  assert.match(
    html,
    /\.capture-monitor-link\.active\s*\{[^}]*background:\s*var\(--ink\);[^}]*color:\s*var\(--paper-hi\);/s,
  );
  assert.doesNotMatch(html, /\.capture-monitor-link:hover,\s*\.capture-monitor-link\.active/);
  assert.match(script, /settingsLink\.classList\.toggle\('active', settingsActive\)/);
  assert.match(script, /settingsLink\.setAttribute\('aria-current', 'page'\)/);
  assert.match(script, /link\.dataset\.captureStatus = aggregate\.status/);
  assert.doesNotMatch(script, /link\.className = `capture-monitor-link/);
});

test("the capture settings button uses a geometrically centered attention mark", async () => {
  const html = await readFile(join(process.cwd(), "portal", "index.html"), "utf8");
  const script = await readFile(join(process.cwd(), "portal", "portal.js"), "utf8");

  assert.match(html, /<span class="capture-monitor-attention" aria-hidden="true"><\/span>/);
  assert.match(
    html,
    /\.capture-monitor-attention\s*\{[^}]*display:\s*none;[^}]*width:\s*16px;[^}]*height:\s*16px;[^}]*border-radius:\s*50%;[^}]*color:\s*var\(--status-error-ink\);/s,
  );
  assert.match(
    html,
    /\.capture-monitor-attention::before,\s*\.capture-monitor-attention::after\s*\{[^}]*left:\s*50%;[^}]*background:\s*currentColor;[^}]*transform:\s*translateX\(-50%\);/s,
  );
  assert.match(
    html,
    /\.capture-monitor-link\[data-capture-status="needs_attention"\] \.capture-monitor-attention\s*\{[^}]*display:\s*block;[^}]*background:\s*var\(--status-error\);/s,
  );
  assert.match(script, /link\.ariaLabel = `Open Settings: Capture \$\{aggregate\.label\}`/);
});

test("the dashboard uses the theme-aware logo for both its header and favicon", async () => {
  const html = await readFile(join(process.cwd(), "portal", "index.html"), "utf8");
  const logo = await readFile(join(process.cwd(), "portal", "logo.svg"), "utf8");

  assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="\.\/logo\.svg">/);
  assert.match(html, /class="mark"[^>]*>\s*<img src="\.\/logo\.svg"/);
  assert.match(logo, /@media \(prefers-color-scheme: dark\)/);
  assert.match(logo, /data-render-theme="dark"/);
  assert.match(logo, /\.bg \{ fill: #1c1c1a; \}/);
  assert.match(logo, /\.fill \{ fill: #f2efe7; \}/);
});

test("window icons follow the OS theme selected at startup", () => {
  assert.equal(startupIconFilename(false), "icon-light.png");
  assert.equal(startupIconFilename(true), "icon-dark.png");
});

test("settings separate common controls from advanced agent locations", async () => {
  const html = await readFile(join(process.cwd(), "portal", "index.html"), "utf8");
  const script = await readFile(join(process.cwd(), "portal", "portal.js"), "utf8");

  assert.match(html, /data-portal-view="settings"/);
  assert.match(html, /Usage ledger folder/);
  assert.match(html, /Capture policy/);
  assert.match(html, /Capture monitor/);
  assert.match(html, /id="captureMonitorSummary"/);
  assert.match(html, /data-capture-monitor-link/);
  assert.match(html, />Continuous</);
  assert.match(html, />Batch sync</);
  assert.match(html, /<details[^>]*class="settings-advanced"/);
  assert.match(html, /Per-agent capture and locations/);
  assert.match(script, /\/api\/settings/);
  assert.match(script, /Best-effort hook/);
  assert.match(script, /Hook observed/);
  assert.match(script, /Needs attention/);
  assert.match(script, /Waiting for first checkpoint/);
  assert.doesNotMatch(script, /provider\.captureHealth/);
  assert.match(script, /data-settings-action="capture-policy"/);
  assert.match(script, /Use default/);
});

test("an agent that needs attention states its cause and its remedy", async () => {
  const html = await readFile(join(process.cwd(), "portal", "index.html"), "utf8");
  const script = await readFile(join(process.cwd(), "portal", "portal.js"), "utf8");

  // The summary tile is the first surface a user meets, and it sits outside the
  // collapsed advanced section. A bare status word there is the reported defect.
  const renderer = script.slice(script.indexOf("function renderCaptureMonitor"));
  const tile = renderer.slice(0, renderer.indexOf("\nfunction "));
  assert.match(tile, /class="capture-channel /);
  assert.match(tile, /presentation\.title/);
  assert.match(tile, /presentation\.detail/);
  assert.match(tile, /presentation\.remedy/);
  assert.match(tile, /capture-channel-remedy/);

  // Every needs_attention reason owes the user either the Repair control or a
  // concrete manual instruction; the ambiguous middle ground is the reported
  // defect. Repairability itself is the backend's verdict (monitor.repairable),
  // never re-derived in the portal.
  const presentation = script.slice(script.indexOf("function captureMonitorPresentation"));
  for (const reason of [
    "hook_missing",
    "hooks_disabled",
    "settings_invalid",
    "last_attempt_failed",
  ]) {
    const branch = presentation.slice(presentation.indexOf(`'${reason}'`));
    const body = branch.slice(0, branch.indexOf("\n  }"));
    assert.match(body, /remedy:/, `${reason} carries no remedy`);
  }
  assert.doesNotMatch(presentation, /repairable: (true|false)/,
    "the portal must render the backend's repairable verdict, not declare its own");

  // Manual fixes name the exact file and edit; the self-clearing state says
  // that no action is needed instead of hinting at one.
  assert.match(script, /Delete "disableAllHooks": true from \$\{configPath\}/);
  assert.match(script, /Fix the JSON in that file/);
  assert.match(script, /Choose Repair setup to rewrite it\./);
  assert.match(script, /No action needed: this clears itself on the next successful checkpoint/);

  // The control is gated on the backend verdict, not on the aggregate status.
  assert.match(script, /hidden = !repairableProviders\(providers\)\.length/);
  assert.match(script, /provider\.captureMonitor\.repairable/);
  assert.doesNotMatch(script, /hidden = aggregate\.status !== 'needs_attention'/);

  // The message after an action is derived from the state the action produced.
  assert.match(script, /setSettingsStatus\(captureOutcomeMessage\(action, result\.providers\)\)/);
  assert.match(script, /function captureOutcomeMessage/);
  assert.match(script, /Repair ran\. Still needs attention/);

  // A helper run costs seconds, so the button that started it shows progress.
  assert.match(html, /id="captureMonitorRepair"[^>]*data-busy-label="Repairing…"/);
  assert.match(script, /trigger\.textContent = trigger\.dataset\.busyLabel/);

  // Prose wraps; the nowrap ellipsis rule governs the label and status slots only.
  // The selectors stay scoped through .capture-channel so they outrank
  // `.settings-row p`, which otherwise recolors and resizes every row paragraph.
  assert.match(
    html,
    /\.capture-channel \.capture-channel-detail,\s*\n\s*\.capture-channel \.capture-channel-remedy \{/,
  );
  assert.match(html, /\.capture-channel \.capture-channel-remedy \{[^}]*color: var\(--ink\)/);
  // The status slot truncates directly; the label slot carries a provider mark,
  // so the name beside it is what gives way while the mark keeps its size.
  const status = html.match(/\.capture-channel strong \{[^}]*\}/s);
  assert.ok(status, "capture-channel status slot rule was not found");
  assert.match(status[0], /text-overflow: ellipsis;[^}]*white-space: nowrap;/s);
  assert.doesNotMatch(status[0], /capture-channel-detail/);
  const name = html.match(/\.capture-channel-name \{[^}]*\}/s);
  assert.ok(name, "capture-channel label slot rule was not found");
  assert.match(name[0], /text-overflow: ellipsis;[^}]*white-space: nowrap;/s);
  assert.match(html, /\.capture-channel \.provider-mark \{[^}]*width: 11px/s);
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

  assert.equal(typeof config.hooks.postMake, "function");
  assert.equal(squirrel.config.name, "AgentUsageStat");
  assert.equal(squirrel.config.exe, "Agent Usage Stat.exe");
  assert.equal(existsSync(squirrel.config.loadingGif), true);
  assert.equal(existsSync(squirrel.config.setupIcon), true);
  assert.equal(config.packagerConfig.ignore("/portal"), true);
  assert.equal(config.packagerConfig.ignore("/dist/desktop/main.js"), false);
  assert.equal(config.packagerConfig.ignore("/dist/icons"), true);
  assert.equal(config.packagerConfig.ignore("/dist/helper"), true);
  assert.equal(config.packagerConfig.ignore("/dist/forge"), true);
  assert.equal(existsSync(join(process.cwd(), "portal", "icon-source.svg")), false);
  assert.equal(existsSync(join(process.cwd(), "portal", "logo.svg")), true);
  assert.equal(existsSync(join(process.cwd(), "dist", "icons", "icon-light.png")), true);
  assert.equal(existsSync(join(process.cwd(), "dist", "icons", "icon-dark.png")), true);
  assert.equal(existsSync(join(process.cwd(), "portal", "mark-source.svg")), false);
  assert.equal(existsSync(join(process.cwd(), "portal", "logo.png")), false);
  assert.equal(existsSync(join(process.cwd(), "portal", "icon-source.png")), false);
  assert.equal(zip.platforms.includes("win32"), true);
  assert.equal(
    squirrel.config.loadingGif,
    join(process.cwd(), "dist", "icons", "install-loading.gif"),
  );
});
