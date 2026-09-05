import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { findChrome, runPortalProbe } from "../scripts/portal-probe-runner.mjs";
import {
  NO_PRIOR_TEXT,
  PLACEHOLDER_FIGURES,
  ZERO_COST_TEXT,
  ZERO_COUNT_TEXT,
  ZERO_FOLIO_TEXT,
  buildEmptyLedgerFixture,
} from "./helpers/portal-empty-ledger-fixture.mjs";

/**
 * Empty-ledger guard for issue #90.
 *
 * ALL starts its window on the oldest session in the ledger. With no session
 * in it, that instant was `Math.min()` of nothing, the header formatted an
 * invalid date, and the render threw at its first call. The chip still went
 * active, so the reader was left looking at the sample figures index.html
 * ships as if they were their own spend.
 *
 * Whether a render finishes is a fact of the rendered page, not of the module:
 * the throw happens inside a click listener, where it never reaches the
 * caller. So this drives a real click in the renderer the shipped app uses and
 * watches the page for the exception it reports.
 */

const PROBE_WIDTH = 1440;

/** Both ends of the window, as the header prints them: `dateYear` twice, with
 *  the line break between them contributing no text. This is the slot the
 *  invalid date threw in, so it is read for a date rather than for zero. */
const PERIOD_RANGE = /^[A-Z]{3} \d{2}, \d{4}[A-Z]{3} \d{2}, \d{4}$/;

const chrome = findChrome();
const skip = chrome ? false : "no Chrome binary found; set AGENT_USAGE_STAT_CHROME to run this guard";

async function probeRanges() {
  const [result] = await runPortalProbe({
    portalDir: join(process.cwd(), "dist", "portal"),
    data: buildEmptyLedgerFixture(),
    probe: new URL("../scripts/portal-empty-ledger-probe.js", import.meta.url),
    widths: [PROBE_WIDTH],
  });
  return result.ranges;
}

function rangeIn(ranges, label) {
  const range = ranges[label];
  assert.ok(range, `the header has no ${label} range chip to select`);
  assert.ok(range.active, `clicking the ${label} chip did not select it`);
  return range;
}

/** Every assertion that says "this range drew its own zero rather than
 *  stopping on the shipped sample". Both ranges owe the reader the same page,
 *  since neither has anything to report. */
function assertDrawsZero(range, label) {
  assert.deepEqual(range.errors, [], `selecting ${label} on an empty ledger threw`);
  assert.equal(range.hero, ZERO_COST_TEXT, `the ${label} hero does not read zero`);
  assert.equal(range.heroDelta, NO_PRIOR_TEXT, `the ${label} hero compares against a period it does not have`);
  assert.equal(range.folio, ZERO_FOLIO_TEXT, `the ${label} folio does not count zero of zero`);
  assert.match(range.periodRange, PERIOD_RANGE, `the ${label} window does not print two real dates`);
  assert.equal(range.sessions?.value, ZERO_COUNT_TEXT, `the ${label} Sessions metric does not read zero`);
  assert.equal(range.tokens?.value, ZERO_COUNT_TEXT, `the ${label} Tokens metric does not read zero`);
  assert.equal(range.avgCost?.value, ZERO_COST_TEXT, `the ${label} Avg / session metric does not read zero`);
  for (const figure of PLACEHOLDER_FIGURES) {
    assert.ok(
      !range.bodyText.includes(figure),
      `${label} left the shipped sample figure ${figure} on the page, so the render did not finish`,
    );
  }
}

test("ALL on a ledger with nothing in it renders zeros rather than throwing", { skip }, async () => {
  const ranges = await probeRanges();
  assertDrawsZero(rangeIn(ranges, "ALL"), "ALL");
});

test("a fixed range on the same empty ledger renders the same zeros", { skip }, async () => {
  const ranges = await probeRanges();
  assertDrawsZero(rangeIn(ranges, "30D"), "30D");
});
