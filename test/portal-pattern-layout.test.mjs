import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { findChrome, runPortalProbe } from "../scripts/portal-probe-runner.mjs";
import { buildLayoutFixture } from "./helpers/portal-layout-fixture.mjs";

/**
 * Layout-stability guard for the Pattern view's captions.
 *
 * A caption states computed numbers, so it runs to one line on some weeks and
 * two on others. Left to size itself it took the whole card with it: paging
 * one week moved the heatmap, both charts below it, and the rest of the page
 * by the height of a line, and the reader lost their place at every click.
 * Each caption box is now reserved for the tallest form it takes, so the
 * sentence inside can change length without anything moving. It is the rule
 * `SLOT_BUDGET` applies to numbers, applied to prose.
 *
 * Only a rendered page answers this. A stylesheet cannot say whether a
 * reservation is large enough for the sentence a real ledger produces, and a
 * caption that happens to fit reads identically in the source to one with room
 * to spare. Paging the fixture is not enough on its own either: a fixture
 * whose weeks all print a short caption passes without the reservation, which
 * is exactly what this guard did before it was given a budget to check.
 *
 * Two widths, because the reservation is one line taller below 1280, where the
 * cards that share a row are at their narrowest.
 */

/**
 * The longest caption each slot may print, in characters.
 *
 * Pinned here as well as in the probe so that widening a budget has to be a
 * deliberate edit in two places, the way `SLOT_BUDGET` records what a numeric
 * slot was measured to hold. Raising one means raising the reserved height in
 * the stylesheet to match, and this guard is what proves the two agree.
 */
const CAPTION_BUDGETS = {
  "#patternHeatCaption": 210,
  "#patternWeekCaption": 140,
  "#patternSplitCaption": 210,
  "#patternProjectCaption": 210,
};

/**
 * The zones the budget guard reads the captions in.
 *
 * A caption states shares of the folded week, and the fold is cut on local
 * hours, so where the reader stands decides how the volume lands across the
 * territories, which segments of the split bar are too narrow to carry their
 * own label, and therefore how much the caption has to say. The machine's own
 * zone is one sample of that, never the worst: the split caption fitted in
 * Chicago at 198 characters while rendering 237 in UTC, which is the zone
 * every release runner reports, and 239 in Tokyo. `null` is the machine's own
 * zone, and the two named ones keep the release gate and the local run reading
 * the same page.
 */
const CAPTION_ZONES = [null, "UTC", "Asia/Tokyo"];

const chrome = findChrome();
const skip = chrome ? false : "no Chrome binary found; set AGENT_USAGE_STAT_CHROME to run this guard";

async function probePattern(width, timeZone = null) {
  const [result] = await runPortalProbe({
    portalDir: join(process.cwd(), "dist", "portal"),
    data: buildLayoutFixture(),
    probe: new URL("../scripts/portal-pattern-probe.js", import.meta.url),
    widths: [width],
    timeZone,
  });
  assert.equal(result.error, undefined, result.error);
  return result;
}

test("a caption filled to its budget does not grow the card it sits in", { skip }, async () => {
  for (const width of [1440, 1120]) {
    const result = await probePattern(width);
    assert.deepEqual(result.budgets, CAPTION_BUDGETS, "the probe and the guard disagree about the budgets");

    for (const reservation of result.reservations) {
      assert.equal(
        reservation.full,
        reservation.short,
        `at ${width}px, ${reservation.selector} grew its card from ${reservation.short}px to ${reservation.full}px when filled to its ${reservation.budget}-character budget`,
      );
    }
  }
});

test("every caption the renderer emits stays inside its budget", { skip }, async () => {
  for (const timeZone of CAPTION_ZONES) {
    const zone = timeZone ?? "the machine's own zone";
    const result = await probePattern(1440, timeZone);

    for (const reservation of result.reservations) {
      assert.ok(
        reservation.rendered <= reservation.budget,
        `in ${zone}, ${reservation.selector} rendered ${reservation.rendered} characters against a budget of ${reservation.budget}`,
      );
    }
    const paged = Math.max(...result.pages.map((page) => page.captionText));
    assert.ok(
      paged <= CAPTION_BUDGETS["#patternHeatCaption"],
      `in ${zone}, paging produced a ${paged}-character caption against a budget of ${CAPTION_BUDGETS["#patternHeatCaption"]}`,
    );
  }
});

test("paging the heatmap through the weeks moves nothing below it", { skip }, async () => {
  for (const width of [1440, 1120]) {
    const { pages } = await probePattern(width);
    assert.ok(pages.length > 2, `expected several week pages to step through, saw ${pages.length}`);

    for (const key of ["captionHeight", "heatTop", "belowTop", "viewHeight"]) {
      const measured = [...new Set(pages.map((page) => page[key]))];
      assert.equal(
        measured.length,
        1,
        `at ${width}px, ${key} changed across weeks: ${pages.map((page) => `${page.week}=${page[key]}`).join(", ")}`,
      );
    }
  }
});
