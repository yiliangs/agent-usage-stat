import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { findChrome, runPortalProbe } from "../scripts/portal-probe-runner.mjs";
import { buildHeatmapFixture } from "./helpers/portal-heatmap-fixture.mjs";

/**
 * Calendar-label guard for issue #91.
 *
 * A calendar bucket is keyed by the reader's local date and stamped at noon
 * UTC. Noon survives a twelve-hour offset in either direction, so on this
 * machine the two agree and no local run can tell them apart. Past UTC+12 they
 * do not: noon UTC on a key is already the next calendar day where the reader
 * is standing, and every label formatted from that instant names the day after
 * the one whose spend it holds.
 *
 * Kiritimati is UTC+14, the furthest zone there is, and the renderer is the
 * only place this can be observed, since the defect is in what a formatter
 * prints rather than in what the model computes. The guard asserts the page
 * against itself: whatever day a cell holds, that is the day its accessible
 * name and the drawer it opens must both say. No expectation here is derived
 * from the zone this test process happens to run in.
 */

const PROBE_WIDTH = 1440;
const VIEWER_ZONE = "Pacific/Kiritimati";

const chrome = findChrome();
const skip = chrome ? false : "no Chrome binary found; set AGENT_USAGE_STAT_CHROME to run this guard";

/** The day a date key names, read back in UTC as the portal stamps it. */
function labelForKey(key) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric" })
    .format(new Date(`${key}T12:00:00Z`))
    .toUpperCase();
}

test("heatmap days are labelled with the day they hold, east of UTC+12", { skip }, async () => {
  const [result] = await runPortalProbe({
    portalDir: join(process.cwd(), "dist", "portal"),
    data: buildHeatmapFixture(Date.now()),
    probe: new URL("../scripts/portal-heatmap-probe.js", import.meta.url),
    widths: [PROBE_WIDTH],
    timeZone: VIEWER_ZONE,
  });

  assert.equal(result.timeZone, VIEWER_ZONE, "the renderer did not adopt the viewer's time zone");
  assert.ok(result.heatmapVisible, "the heatmap view did not render");

  const held = result.days.filter((entry) => entry.key);
  assert.ok(held.length > 0, "no heatmap cell reported the day it holds");

  for (const entry of held) {
    assert.equal(
      entry.day,
      labelForKey(entry.key),
      `the cell holding ${entry.key} is named ${entry.day}`,
    );
    assert.ok(entry.drawer, `clicking ${entry.key} opened no detail view`);
    assert.equal(
      entry.drawer.title,
      labelForKey(entry.key),
      `the drawer for ${entry.key} is titled ${entry.drawer.title}`,
    );
  }
});
