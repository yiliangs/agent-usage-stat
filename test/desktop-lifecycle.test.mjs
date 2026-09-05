import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { squirrelLifecycleEvent } from "../dist/desktop/squirrel-events.js";
import {
  promoteStartMenuShortcut,
  removeStartMenuShortcut,
  startMenuProgramsDir,
  startMenuShortcutName,
} from "../dist/desktop/start-menu-shortcut.js";
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
import {
  setupAnswerAt,
  setupQuestionDetail,
} from "../dist/desktop/setup-question.js";
import {
  FIRST_RUN_STEPS,
  STARTUP_URL,
} from "../dist/desktop/startup-screen.js";

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
      facts: [{
        label: "On this computer",
        value: "C:\\Users\\Alex\\AppData\\Local\\Agent Usage Stat\\ledger",
      }],
      detail: [
        "Using multiple computers? Choose a folder in Google Drive, OneDrive, Dropbox, or another synchronized drive, then select that same synchronized folder on each computer. Paths may differ by machine.",
        "The ledger contains usage totals, model names, project names, branches, and local project paths. It does not contain prompt or response text.",
      ],
      options: [
        { value: "keep", label: "Use Local Storage" },
        { value: "choose", label: "Choose Another Folder..." },
      ],
    },
  );
});

test("changing folders offers migration and preserves the original by default", () => {
  const question = ledgerMigrationPrompt("C:\\old-ledger", "D:\\new-ledger");

  assert.deepEqual(question, {
    message: "Migrate existing usage history?",
    facts: [
      { label: "From", value: "C:\\old-ledger" },
      { label: "To", value: "D:\\new-ledger" },
    ],
    detail: [
      "Existing history will be merged into the new ledger without replacing newer records.",
    ],
    options: [
      { value: "migrate", label: "Continue" },
      { value: "cancel", label: "Cancel" },
    ],
    toggle: { label: "Keep the original ledger as a backup", checked: true },
  });

  // The native dialog still takes one detail string and a button index, so the
  // adapters between the shared question and that surface are covered here.
  assert.equal(
    setupQuestionDetail(question),
    "From:\nC:\\old-ledger\n\n" +
    "To:\nD:\\new-ledger\n\n" +
    "Existing history will be merged into the new ledger without replacing newer records.",
  );
  assert.deepEqual(
    setupAnswerAt(question, 0, true),
    { value: "migrate", toggled: true },
  );
  assert.deepEqual(
    setupAnswerAt(question, 1, false),
    { value: "cancel", toggled: false },
  );
  assert.equal(setupAnswerAt(question, 2, false), null);
});

test("first-run capture choice treats hooks as best effort and explains recovery", () => {
  assert.deepEqual(capturePolicyPrompt(), {
    message: "How should usage be captured?",
    facts: [],
    detail: [
      "Continuous capture (recommended) uses agent hooks to checkpoint usage while you work. Hooks are best effort, so Agent Usage Stat also reconciles transcripts whenever the application opens and when you choose Sync now.",
      "Batch sync installs no hooks. Sessions deleted by an agent before the next application sync cannot be recovered.",
    ],
    options: [
      { value: "continuous", label: "Use Continuous Capture" },
      { value: "batch", label: "Use Batch Sync" },
    ],
  });
});

test("the first-run window asks its own questions instead of raising dialogs", async () => {
  const main = await readFile(join(process.cwd(), "src", "desktop", "main.ts"), "utf8");
  const firstRun = main.slice(
    main.indexOf("async function openFirstRunWindow"),
    main.indexOf("async function synchronizeCachedWindow"),
  );

  // showOpenDialog is the OS folder picker, which has no in-window equivalent.
  // Every question and notice the first run raises belongs to the window.
  assert.doesNotMatch(firstRun, /showMessageBox/);
  assert.match(firstRun, /askOnStartupScreen\(window, ledgerLocationPrompt\(resolved\)\)/);
  assert.match(firstRun, /askOnStartupScreen\(window, capturePolicyPrompt\(\)\)/);
  assert.match(firstRun, /noticeOnStartupScreen\(window, notice\)/);
  assert.match(firstRun, /failStartupScreen\(window, detail\)/);
});

test("the dashboard window opens nothing and navigates nowhere but the portal", async () => {
  const main = await readFile(join(process.cwd(), "src", "desktop", "main.ts"), "utf8");
  const createWindow = main.slice(
    main.indexOf("async function createWindow"),
    main.indexOf("function installApplicationMenu"),
  );

  // The renderer draws transcript-derived strings, so its two ways out of the
  // page are what bound a renderer-side defect. Both are pinned here; the
  // sandbox itself is pinned for every window in architecture-invariants.
  const preferences = createWindow.match(/webPreferences: \{[\s\S]*?\}/);
  assert.ok(preferences, "createWindow declares no webPreferences");
  assert.match(preferences[0], /contextIsolation: true/);
  assert.match(preferences[0], /nodeIntegration: false/);
  assert.match(preferences[0], /sandbox: true/);

  // Every window the page asks for is refused. http(s) leaves for the OS
  // browser instead of opening in a window this handler never sees again, so
  // a second return value is how "allow" gets back in.
  const opening = createWindow.slice(
    createWindow.indexOf("setWindowOpenHandler"),
    createWindow.indexOf('on("will-navigate"'),
  );
  assert.deepEqual(
    opening.match(/return \{ action: "[a-z]+" \}/g),
    ['return { action: "deny" }'],
  );

  // will-navigate is the renderer's own navigation, and the portal origin is
  // the whole allowance: a `data:` URL carries its own CSP in place of the
  // portal's, on an origin the window-open handler never sees (#122).
  const navigating = createWindow.slice(
    createWindow.indexOf('on("will-navigate"'),
    createWindow.indexOf("if (show)"),
  );
  assert.match(
    navigating,
    /if \(url\.startsWith\(`\$\{PORTAL_ORIGIN\}\/`\)\) return;/,
  );
  assert.match(navigating, /event\.preventDefault\(\);/);
  assert.doesNotMatch(navigating, /\|\|/);
  assert.doesNotMatch(navigating, /data:/);
});

test("the setup screen renders questions in the dashboard's visual system", () => {
  // The setup window is the first thing a user sees, so it carries the same
  // typography roles, tokens, and dark mode as the dashboard it opens into.
  assert.match(STARTUP_URL, /^data:text\/html;charset=UTF-8,/);
  const html = decodeURIComponent(STARTUP_URL.slice(STARTUP_URL.indexOf(",") + 1));

  assert.match(html, /--serif: "Libre Baskerville", Georgia, serif;/);
  assert.match(html, /--mono: "Geist Mono", "Cascadia Mono", Consolas, monospace;/);
  assert.match(html, /--sans: "IBM Plex Sans", Aptos, "Segoe UI", sans-serif;/);
  assert.match(html, /h1 \{[^}]*font-family: var\(--serif\)/s);
  assert.match(html, /\.facts dd \{[^}]*font-family: var\(--mono\)/s);
  assert.match(html, /@media \(prefers-color-scheme: dark\)/);
  assert.doesNotMatch(html, /Segoe UI Variable/);

  // The question surface itself: facts, prose, an optional toggle, and buttons.
  assert.match(html, /window\.agentUsageStatAsk = \(question, eyebrow, tag\)/);
  assert.match(html, /id="facts"/);
  assert.match(html, /id="toggleInput"/);
  assert.match(html, /id="actions"/);
});

test("the setup spine and the step copy come from one list", () => {
  assert.deepEqual(
    FIRST_RUN_STEPS.map((step) => step.id),
    ["helper", "storage", "capture", "agents", "sessions"],
  );
  for (const step of FIRST_RUN_STEPS) {
    assert.ok(step.label.length > 0, `${step.id} has no spine label`);
    assert.ok(step.headline.length > 0, `${step.id} has no headline`);
    assert.ok(step.detail.length > 0, `${step.id} has no detail`);
  }
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
  // The control is the only way into Settings, so it carries the view trigger
  // itself and takes its active state from the one navigation loop rather than
  // from a second code path written just for it.
  assert.match(html, /data-capture-monitor-link[^>]*data-portal-view="settings"/);
  assert.doesNotMatch(script, /settingsLink/);
  assert.match(
    script,
    /\$\$\('\[data-portal-view\]'\)\.forEach\(\(trigger\) => \{[^}]*trigger\.classList\.toggle\('active', active\)/s,
  );
  assert.match(script, /trigger\.setAttribute\('aria-current', 'page'\)/);
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

  // Four agents across one row, or two even rows. Three across strands the
  // fourth alone, which is what auto-fit does on its own at this width.
  const narrow = html.match(/@media \(max-width: 1279px\) \{.*?\n    \}/s);
  assert.ok(narrow, "the 1279px band was not found");
  assert.match(narrow[0], /\.capture-monitor-summary \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);

  // Each fact carries its verdict as a glyph and its time as a keyword, so the
  // four channels stop reading as the same sentence four times over.
  assert.match(script, /function captureFacts/);
  assert.match(script, /function keywordTime/);
  assert.match(script, /return 'just now'/);
  assert.match(script, /min ago/);
  assert.match(script, /\{ label: 'Checkpoint', value: keywordTime\(observation\?\.lastSuccessAt\), state: 'ok' \}/);
  assert.match(html, /\.capture-fact\.ok \.capture-fact-mark \{ stroke: var\(--status-good\); \}/);
  assert.match(html, /\.capture-fact\.bad \.capture-fact-mark \{ stroke: var\(--status-error\); \}/);
  // The fallback note is stated once for the section, not once per channel.
  assert.equal((html.match(/App sync remains the fallback/g) || []).length, 1);
  assert.doesNotMatch(script, /App sync remains the fallback/);
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

/**
 * Windows lists a `.lnk` sitting directly under `Programs` as an application
 * and a subdirectory as a folder to expand. Squirrel 2.0.1 only knows how to
 * write into a subdirectory named after the nuspec authors, and that same
 * field is the uninstall entry's Publisher, so placement is corrected here
 * rather than by renaming the author (#72).
 */
async function startMenuFixture() {
  const programs = await mkdtemp(join(tmpdir(), "aus-start-menu-"));
  const authorFolder = join(programs, "Yiliang Shao");
  await mkdir(authorFolder, { recursive: true });
  await writeFile(join(authorFolder, "Agent Usage Stat.lnk"), "shortcut");
  return programs;
}

test("the Start Menu lists the application itself, not a folder named after its author", async () => {
  const programs = await startMenuFixture();

  await promoteStartMenuShortcut(programs, "Agent Usage Stat.lnk");

  assert.deepEqual(await readdir(programs), ["Agent Usage Stat.lnk"]);
  await rm(programs, { recursive: true, force: true });
});

test("promoting the Start Menu entry twice leaves the same single entry", async () => {
  const programs = await startMenuFixture();

  await promoteStartMenuShortcut(programs, "Agent Usage Stat.lnk");
  await promoteStartMenuShortcut(programs, "Agent Usage Stat.lnk");

  assert.deepEqual(await readdir(programs), ["Agent Usage Stat.lnk"]);
  await rm(programs, { recursive: true, force: true });
});

test("uninstalling clears both the promoted entry and anything Squirrel left behind", async () => {
  const programs = await startMenuFixture();
  await writeFile(join(programs, "Agent Usage Stat.lnk"), "shortcut");

  await removeStartMenuShortcut(programs, "Agent Usage Stat.lnk");

  assert.deepEqual(await readdir(programs), []);
  await rm(programs, { recursive: true, force: true });
});

test("the Start Menu entry is named for the installed executable", () => {
  assert.equal(startMenuShortcutName("Agent Usage Stat.exe"), "Agent Usage Stat.lnk");
  assert.equal(
    startMenuProgramsDir({ APPDATA: join("C:", "Users", "person", "AppData", "Roaming") }),
    join("C:", "Users", "person", "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs"),
  );
});

test("every Squirrel lifecycle event that touches shortcuts corrects their placement", async () => {
  const main = await readFile(join(process.cwd(), "src", "desktop", "main.ts"), "utf8");
  const install = main.slice(main.indexOf("async function performSquirrelEvent"));

  assert.match(install, /--squirrel-install" \|\| event === "--squirrel-updated"[\s\S]*?promoteStartMenuShortcut\(/);
  assert.match(install, /--squirrel-uninstall"[\s\S]*?removeStartMenuShortcut\(/);
});

test("the Squirrel maker leaves the nuspec author alone", () => {
  // Renaming `authors` would move the Start Menu folder, and would also
  // rewrite the uninstall entry's Publisher, which reads that same field.
  const config = require("../forge.config.cjs");
  const squirrel = config.makers.find((maker) => maker.name.includes("squirrel"));

  assert.equal("authors" in squirrel.config, false);
  assert.equal("owners" in squirrel.config, false);
});
