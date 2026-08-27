import assert from "node:assert/strict";
import test from "node:test";

import {
  SLOT_BUDGET,
  compact,
  pct,
  periodDelta,
  usd,
  usdHeadline,
} from "../portal/usage-format.js";

/**
 * Budget guard for issue #26.
 *
 * The layout guard renders the portal and catches a panel that is too small
 * for the data it happens to be showing. This one catches the other half: a
 * formatter with no ceiling, which overflows only once a user's numbers grow
 * large enough. It runs everywhere and needs no browser, so a formatter cannot
 * regain an unbounded branch unnoticed.
 */

/** Magnitudes that span every branch, including ones no install will reach.
 *  A bound that holds only for plausible data is not a bound. */
const MAGNITUDES = [
  0, 0.004, 0.5, 1, 9.99, 99.99, 999.99, 999.995, 999.9999, 1000, 9999.99,
  12_345.67, 99_999.99, 99_999.995, 100_000, 654_321, 999_999.99, 1e6, 9.87e6,
  1e9, 4.2e9, 1e12, 9.9e14, 1e15, 4.2e21, Number.MAX_SAFE_INTEGER,
];

function widest(label, values, produce) {
  let longest = "";
  for (const value of values) {
    const text = produce(value);
    if (text.length > longest.length) longest = text;
  }
  return { label, longest };
}

test("the headline currency format stays inside every fixed column it feeds", () => {
  const { longest } = widest("usdHeadline", MAGNITUDES, usdHeadline);
  for (const slot of ["heroValue", "concValue"]) {
    assert.ok(
      longest.length <= SLOT_BUDGET[slot],
      `widest headline currency ${JSON.stringify(longest)} is ${longest.length} characters, ${slot} budget ${SLOT_BUDGET[slot]}`,
    );
  }
  // The concentration row that clipped on macOS: ten characters in a column
  // measured to hold nine.
  assert.equal(usd(42_071.75).length, 10);
  assert.equal(usdHeadline(42_071.75), "$42,072");
  assert.equal(usdHeadline(539.8), "$539.80");
  assert.equal(usdHeadline(10_329.3), "$10,329");
  assert.equal(usdHeadline(126_987.25), "$127K");
  assert.equal(usdHeadline(99_999.99), "$100K");
  assert.equal(usdHeadline(4.2e6), "$4.2M");
  // The half-cent band under a comma boundary: the branch is chosen on the
  // raw value, but `usd` rounds to cents, so the sub-thousand branch used to
  // print the thousand it was chosen to avoid.
  assert.equal(usdHeadline(999.994), "$999.99");
  assert.equal(usdHeadline(999.995), "$1,000");
  assert.equal(usdHeadline(999.9999), "$1,000");
});

test("compacted token counts stay inside the metric value budget", () => {
  const { longest } = widest("compact", MAGNITUDES, compact);
  assert.ok(
    longest.length <= SLOT_BUDGET.metricValue,
    `widest compact token count ${JSON.stringify(longest)} is ${longest.length} characters, budget ${SLOT_BUDGET.metricValue}`,
  );
  assert.equal(compact(649), "649");
  assert.equal(compact(11_310_000_000), "11.31B");
  assert.equal(compact(9.9e14), "990.00T");
  assert.equal(compact(999.999e9), "1.00T");
  assert.equal(compact(4.2e21), "4e+21");
});

test("percent shares stay inside the metric value budget", () => {
  const { longest } = widest("pct", [0, 0.005, 0.38, 0.97, 1], pct);
  assert.ok(longest.length <= SLOT_BUDGET.metricValue, `widest percent ${JSON.stringify(longest)}`);
});

test("the period comparison stays on one line for every prior period", () => {
  // The reported case: a period 632x its predecessor produced a 25-character
  // line where the panel holds 17, so "period" fell to a row of its own.
  assert.equal(periodDelta(633, 1), "×633 vs prior");
  assert.ok(periodDelta(633, 1).length <= SLOT_BUDGET.metricNote);

  const priors = [1e-6, 0.01, 1, 42, 1000, 9.9e8];
  const currents = [0, 0.5, 1, 43, 1207, 1e6, 9.9e11];
  let longest = "";
  for (const previous of priors) {
    for (const current of currents) {
      const text = periodDelta(current, previous);
      assert.ok(
        !text.includes("NaN") && !text.includes("Infinity"),
        `periodDelta(${current}, ${previous}) produced ${JSON.stringify(text)}`,
      );
      if (text.length > longest.length) longest = text;
    }
  }
  assert.ok(
    longest.length <= SLOT_BUDGET.metricNote,
    `widest comparison ${JSON.stringify(longest)} is ${longest.length} characters, budget ${SLOT_BUDGET.metricNote}`,
  );
  assert.equal(periodDelta(1, 0), "No prior baseline");
  assert.equal(periodDelta(104, 100), "+4.0% vs prior");
  assert.equal(periodDelta(261, 100), "+161% vs prior");
  assert.equal(periodDelta(96, 100), "−4.0% vs prior");
});

test("exact currency stays available for the panels wide enough to print it", () => {
  assert.equal(usd(126_987.25), "$126,987.25");
  assert.equal(usd(0), "$0.00");
});
