import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { findChrome, runPortalProbe } from "../scripts/portal-probe-runner.mjs";
import {
  ROLLING_COST_TEXT,
  WINDOW_COST_TEXT,
  buildPeriodWindowFixture,
} from "./helpers/portal-period-window-fixture.mjs";

/**
 * Window guard for issue #92.
 *
 * The hero total and the heatmap's "Current 30D" panel sit a finger's width
 * apart and are both labelled as the selected period's spend, but each was
 * computed over its own window: the hero over a rolling span of milliseconds,
 * the heatmap over the calendar dates it can draw cells for. Which sessions
 * each one admits is a fact of the rendered page, so the guard reads both
 * figures off it.
 *
 * One width is enough; nothing here varies with geometry.
 */

const PROBE_WIDTH = 1440;

const chrome = findChrome();
const skip = chrome ? false : "no Chrome binary found; set AGENT_USAGE_STAT_CHROME to run this guard";

test("the hero total and the heatmap current window count the same calendar days", { skip }, async () => {
  const [result] = await runPortalProbe({
    portalDir: join(process.cwd(), "dist", "portal"),
    data: buildPeriodWindowFixture(),
    probe: new URL("../scripts/portal-period-figures-probe.js", import.meta.url),
    widths: [PROBE_WIDTH],
  });

  const current = result.heatmapPanels.find((panel) => panel.label === "Current 30D");
  assert.ok(current, `the heatmap drew no Current 30D panel; drew [${result.heatmapPanels.map((panel) => panel.label).join(", ")}]`);

  assert.notEqual(
    result.hero,
    ROLLING_COST_TEXT,
    "the hero still counts the evening before the window opens, which the heatmap has no cell for",
  );
  assert.equal(result.hero, WINDOW_COST_TEXT);
  assert.equal(current.value, WINDOW_COST_TEXT);
  assert.equal(result.hero, current.value, "the two panels report different windows");
  assert.equal(result.spendTotal, WINDOW_COST_TEXT, "the Spend view totals a third window again");
});
