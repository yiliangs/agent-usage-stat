import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { findChrome, runPortalProbe } from "../scripts/portal-probe-runner.mjs";
import {
  NO_PRIOR_TEXT,
  OVERLAP_DELTA_TEXT,
  TOTAL_COST_TEXT,
  buildPriorPeriodFixture,
} from "./helpers/portal-prior-period-fixture.mjs";

/**
 * Prior-period guard for issue #133.
 *
 * ALL starts the window on the oldest session in the ledger, so there is
 * nothing before it to compare against. The page reported one anyway: the
 * window filter admitted the oldest session at both ends, the prior period
 * came back holding that one session, and the whole ledger was reported as a
 * multiple of its own first day.
 *
 * Which range is selected and what each comparison then reads are facts of the
 * rendered page: the chips are wired in the renderer and every comparison is
 * redrawn from the click, so this drives a real click in the renderer the
 * shipped app uses. One width is enough; nothing here varies with geometry.
 */

const PROBE_WIDTH = 1440;

/** The comparisons fed by the prior period, and the label each is drawn under.
 *  The fourth metric prints a cache figure rather than a comparison, so it is
 *  not one of these. */
const METRIC_COMPARISONS = ["Sessions", "Tokens", "Avg / session"];

const chrome = findChrome();
const skip = chrome ? false : "no Chrome binary found; set AGENT_USAGE_STAT_CHROME to run this guard";

async function probeRanges() {
  const [result] = await runPortalProbe({
    portalDir: join(process.cwd(), "dist", "portal"),
    data: buildPriorPeriodFixture(),
    probe: new URL("../scripts/portal-prior-period-probe.js", import.meta.url),
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

function noteOf(range, label) {
  const metric = range.metricDeltas.find((entry) => entry.label === label);
  assert.ok(metric, `no metric is drawn under ${label}; drew [${range.metricDeltas.map((entry) => entry.label).join(", ")}]`);
  return metric.note;
}

test("ALL reports no prior period rather than one built from its own oldest session", { skip }, async () => {
  const ranges = await probeRanges();
  const all = rangeIn(ranges, "ALL");

  assert.equal(
    all.hero,
    TOTAL_COST_TEXT,
    "ALL did not total the whole ledger, so the fixture is not being read as intended",
  );
  assert.notEqual(
    all.heroDelta,
    OVERLAP_DELTA_TEXT,
    "the hero compares the whole ledger against the one session the prior period borrowed from it",
  );
  assert.equal(all.heroDelta, NO_PRIOR_TEXT);
  assert.equal(all.spendNote, NO_PRIOR_TEXT, "the Spend headline reports a prior period ALL does not have");
  assert.equal(all.tokenNote, NO_PRIOR_TEXT, "the Tokens headline reports a prior period ALL does not have");
  for (const label of METRIC_COMPARISONS) {
    assert.equal(noteOf(all, label), NO_PRIOR_TEXT, `the ${label} metric reports a prior period ALL does not have`);
  }
});

test("a fixed range over the same ledger reports no prior period either", { skip }, async () => {
  const ranges = await probeRanges();
  const fixed = rangeIn(ranges, "30D");

  // The whole ledger fits inside thirty days, so 30D holds exactly what ALL
  // holds and the thirty days before it hold nothing. This is the reading ALL
  // owed the reader all along.
  assert.equal(fixed.hero, TOTAL_COST_TEXT);
  assert.equal(fixed.heroDelta, NO_PRIOR_TEXT);
  assert.equal(fixed.spendNote, NO_PRIOR_TEXT);
  assert.equal(fixed.tokenNote, NO_PRIOR_TEXT);
});
