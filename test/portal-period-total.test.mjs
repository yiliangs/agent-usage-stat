import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { findChrome, runPortalProbe } from "../scripts/portal-probe-runner.mjs";
import {
  LONG_LEDGER_TOTAL_TEXT,
  NINETY_DAY_DAYS,
  NINETY_DAY_RANGE,
  NINETY_DAY_TOKENS_TEXT,
  TRUNCATED_TOTAL_TEXT,
  buildLongLedgerFixture,
  buildNinetyDayFixture,
  ninetyDayFirstLabel,
} from "./helpers/portal-series-fixture.mjs";

/**
 * Period-coverage guards for issues #130 and #131.
 *
 * How much of the selected period a chart actually drew is only visible in the
 * page: the bucket ceiling lives in the renderer, and the figure it corrupts is
 * an annotation the same renderer prints. So these read the rendered marks back
 * and add them up, rather than trusting the model the marks were built from.
 *
 * One width is enough; nothing here varies with geometry.
 */

const PROBE_WIDTH = 1440;

const chrome = findChrome();
const skip = chrome ? false : "no Chrome binary found; set AGENT_USAGE_STAT_CHROME to run this guard";

async function probe(data, range) {
  const [result] = await runPortalProbe({
    portalDir: join(process.cwd(), "dist", "portal"),
    data,
    probe: new URL("../scripts/portal-period-figures-probe.js", import.meta.url),
    widths: [PROBE_WIDTH],
    input: range ? { range } : null,
  });
  return result;
}

/** Every dollar a chart mark's tooltip names, summed. Each mark carries its own
 *  value, so the sum is what the chart as drawn says the period holds. */
function markedDollars(marks) {
  return marks.reduce((total, tip) => {
    const amount = /\$([\d,]+\.\d\d)/.exec(tip || "");
    return total + (amount ? Number(amount[1].replace(/,/g, "")) : 0);
  }, 0);
}

test("PERIOD TOTAL on a ledger past the bucket ceiling is the period's total", { skip }, async () => {
  const result = await probe(buildLongLedgerFixture(), "ALL");

  assert.equal(result.selectedRange, "ALL", "the ALL chip was not selected");
  assert.equal(result.hero, LONG_LEDGER_TOTAL_TEXT, "the fixture is not being read as intended");
  assert.notEqual(
    result.cumulativeAnnotation,
    `PERIOD TOTAL / ${TRUNCATED_TOTAL_TEXT}`,
    "the cumulative chart still totals only the days that fitted under its bucket ceiling",
  );
  assert.equal(result.cumulativeAnnotation, `PERIOD TOTAL / ${LONG_LEDGER_TOTAL_TEXT}`);
  assert.equal(
    markedDollars(result.spendChartMarks).toFixed(2),
    "400.00",
    "the stacked spend chart draws less than the period it says it covers",
  );
  // Four hundred days do not fit as daily marks, so both charts fold to weeks
  // and every label that called them daily has to say so. The heatmap in the
  // same card keeps its day a cell, and keeps saying so.
  assert.equal(result.heatmapFieldUnit, "USD / day");
  assert.equal(result.spendFieldUnit, "USD / week");
  assert.equal(result.spendChartTitle, "Weekly API-equivalent spend stacked by model family");
});

test("a 90-day selection is drawn across all ninety of its days", { skip }, async () => {
  const result = await probe(buildNinetyDayFixture(), NINETY_DAY_RANGE);

  assert.equal(result.selectedRange, NINETY_DAY_RANGE, "the 90D chip was not selected");
  assert.equal(result.tokenTotal, NINETY_DAY_TOKENS_TEXT, "the fixture is not being read as intended");
  assert.equal(
    result.tokenTrendBuckets.length,
    NINETY_DAY_DAYS,
    "the daily token chart covers fewer days than the selection it sits under",
  );
  assert.equal(result.tokenTrendBars, NINETY_DAY_DAYS, "a day of the selection drew no bar");
  assert.equal(
    result.tokenTrendBuckets[0],
    ninetyDayFirstLabel(),
    "the token chart opens on a day other than the one the window opens on",
  );
  assert.equal(
    result.spendTrendPoints,
    NINETY_DAY_DAYS,
    "the spend trend covers fewer days than the selection it sits under",
  );
  assert.equal(
    markedDollars(result.spendChartMarks).toFixed(2),
    "90.00",
    "the stacked spend chart draws less than the period it says it covers",
  );
  // Ninety days is the longest fixed range, and every fixed range stays daily.
  assert.equal(result.spendFieldUnit, "USD / day");
  assert.equal(result.spendTrendMeta, "Daily / USD");
  assert.equal(result.tokenTrendMeta, "Daily bars / all token types");
});
