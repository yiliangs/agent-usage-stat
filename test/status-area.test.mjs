import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  PANEL_SIZE,
  closesToStatusArea,
  hasStatusArea,
  panelPlacement,
} from "../dist/desktop/status-area-policy.js";

/**
 * The status-area icon and its glance panel, for issue #76.
 *
 * Placement is the part that has to be right without a screen to look at. The
 * panel is anchored to an icon the shell positions, on a taskbar that can sit
 * on any edge, on a display whose work area is what is left once that taskbar
 * is subtracted. Every arrangement below is a real one, and each expected
 * corner is worked out from the rectangles rather than from the formula in the
 * code.
 */

const PANEL = PANEL_SIZE;
const MARGIN = 8;

test("the panel is one fixed size, whatever screen it opens on", () => {
  assert.deepEqual(PANEL_SIZE, { width: 360, height: 636 });
});

test("the panel opens above an icon on a taskbar along the bottom edge", () => {
  // 1920x1080 with a 48px taskbar. The icon sits on the taskbar, which is
  // outside the work area, so the panel rises to the work area's own edge.
  const placement = panelPlacement(
    { x: 1720, y: 1040, width: 24, height: 24 },
    { x: 0, y: 0, width: 1920, height: 1032 },
    PANEL,
  );

  // Centred on the icon: 1720 + 12 - 180 = 1552, which is inside the work
  // area, so the centre is kept. 1032 - 636 - 8 = 388 puts its lower edge one
  // margin above the taskbar.
  assert.deepEqual(placement, { x: 1552, y: 388 });
});

test("the panel opens below an icon on a taskbar along the top edge", () => {
  const placement = panelPlacement(
    { x: 900, y: 4, width: 24, height: 24 },
    { x: 0, y: 40, width: 1920, height: 1040 },
    PANEL,
  );

  // 900 + 12 - 180 = 732, and 40 + 8 clears the taskbar the icon sits on.
  assert.deepEqual(placement, { x: 732, y: 48 });
});

test("a panel anchored near a screen edge stays inside the work area", () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 1032 };

  const right = panelPlacement({ x: 1900, y: 1040, width: 16, height: 16 }, workArea, PANEL);
  assert.equal(right.x, 1920 - PANEL.width - MARGIN);

  const left = panelPlacement({ x: 2, y: 1040, width: 16, height: 16 }, workArea, PANEL);
  assert.equal(left.x, MARGIN);
});

test("a display offset from the origin keeps the panel on that display", () => {
  // A second monitor to the right of the primary one, with its own taskbar.
  const placement = panelPlacement(
    { x: 3800, y: 1040, width: 24, height: 24 },
    { x: 1920, y: 0, width: 1920, height: 1032 },
    PANEL,
  );

  assert.deepEqual(placement, { x: 3840 - PANEL.width - MARGIN, y: 388 });
});

test("an icon the shell reports no position for anchors to the work area corner", () => {
  // Windows reports an empty rectangle for an icon it has not placed, which is
  // what the hidden-icons overflow and a session without a taskbar both look
  // like. Anchoring to that would put the panel in the top-left of the screen;
  // the corner the status area lives in is the honest fallback.
  const placement = panelPlacement(
    { x: 0, y: 0, width: 0, height: 0 },
    { x: 0, y: 0, width: 1920, height: 1032 },
    PANEL,
  );

  assert.deepEqual(placement, { x: 1552, y: 388 });
});

test("a work area smaller than the panel still shows the panel's own corner", () => {
  const placement = panelPlacement(
    { x: 100, y: 260, width: 24, height: 24 },
    { x: 0, y: 0, width: 300, height: 300 },
    PANEL,
  );

  assert.deepEqual(placement, { x: MARGIN, y: MARGIN });
});

test("the status area is wired on Windows, and the menu bar remains issue #47", () => {
  assert.equal(hasStatusArea("win32"), true);
  assert.equal(hasStatusArea("darwin"), false);
  assert.equal(hasStatusArea("linux"), false);

  // Closing the dashboard is what makes the icon worth having: the application
  // stays resident behind it rather than quitting.
  assert.equal(closesToStatusArea("win32"), true);
  assert.equal(closesToStatusArea("darwin"), false);
});

test("the panel is a portal document, not a second visual system", () => {
  const root = process.cwd();

  assert.equal(existsSync(join(root, "portal", "panel.html")), true);
  assert.equal(existsSync(join(root, "portal", "panel.js")), true);
  // Built by the one portal build, beside the dashboard it belongs to.
  assert.equal(existsSync(join(root, "dist", "portal", "panel.html")), true);
});

test("the panel takes every figure from the shared model and formatters", async () => {
  const root = process.cwd();
  const script = await readFile(join(root, "portal", "panel.js"), "utf8");
  const model = await readFile(join(root, "portal", "glance-model.js"), "utf8");

  assert.match(script, /import \{ buildGlance, glanceFigures \} from '\.\/glance-model\.js'/);
  // Traffic bins and calendar buckets belong to the modules the dashboard
  // draws its own charts from.
  assert.match(model, /from '\.\/token-traffic\.js'/);
  assert.match(model, /from '\.\/timeline-colors\.js'/);
  assert.match(model, /from '\.\/usage-model\.js'/);
  assert.match(model, /from '\.\/usage-format\.js'/);
  // Summing and calendar bucketing belong to usage-model.js, which the
  // dashboard uses for the same purposes. A second implementation here is how
  // the two surfaces start disagreeing about the same ledger.
  assert.doesNotMatch(model, /function (summarizeUsage|familyOf|normalizeSession)/);
  // Formatting is bounded in usage-format.js; a raw number written straight
  // into a slot has no ceiling and eventually wraps (#26).
  assert.doesNotMatch(script, /toLocaleString|toFixed/);
});

test("the panel reads the same generated snapshot as the dashboard", async () => {
  const root = process.cwd();
  const script = await readFile(join(root, "portal", "panel.js"), "utf8");
  const html = await readFile(join(root, "portal", "panel.html"), "utf8");

  assert.match(script, /'\.\/data\/sessions\.json'/);
  assert.match(script, /'\.\/data\/meta\.json'/);
  assert.match(script, /fetch\('\.\/api\/panel'/);
  // The shell reopens this window rather than rebuilding it, so it has to be
  // able to say "read the ledger again" to a window that is already loaded.
  assert.match(script, /window\.agentUsageStatRefreshPanel = refresh/);
  // Both the layout guard and the shell wait on this before reading the panel.
  assert.match(script, /document\.body\.dataset\.glanceReady = 'true'/);
  assert.match(html, /<body data-surface="panel">/);
});

test("the shell installs the icon, reopens the dashboard, and can be quit", async () => {
  const main = await readFile(join(process.cwd(), "src", "desktop", "main.ts"), "utf8");

  assert.match(main, /statusArea\.install\(\)/);
  assert.match(main, /hasStatusArea\(process\.platform\)/);
  // The panel window is a window, so the all-closed event usually never fires
  // once the status area holds the application open. The guard states the rule
  // for the case where it does: a platform, or a session, without one.
  assert.match(main, /window-all-closed[\s\S]*?statusArea\.isActive\(\)/);
  assert.match(main, /new StatusArea\(\{[\s\S]*?openDashboard,[\s\S]*?\}\)/);
  // A hidden window must never outlive the quit that was asked for.
  assert.match(main, /before-quit[\s\S]*?statusArea\.destroy\(\)/);
});
