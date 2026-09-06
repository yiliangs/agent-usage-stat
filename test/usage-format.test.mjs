import assert from "node:assert/strict";
import test from "node:test";

import {
  SLOT_BUDGET,
  compact,
  folioIndex,
  machineField,
  machineFieldLabel,
  pct,
  periodDelta,
  tally,
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

test("counts print every digit while the slot holds them, and compact once it does not", () => {
  const { longest } = widest("tally", MAGNITUDES, tally);
  assert.ok(
    longest.length <= SLOT_BUDGET.metricValue,
    `widest count ${JSON.stringify(longest)} is ${longest.length} characters, budget ${SLOT_BUDGET.metricValue}`,
  );
  // A count is read exactly for as long as there is room to print it exactly.
  assert.equal(tally(0), "0");
  assert.equal(tally(96), "96");
  assert.equal(tally(12_345), "12,345");
  assert.equal(tally(999_999), "999,999");
  // The reported case: the first count with no room for every digit. Nine
  // characters in a slot measured to hold seven is what used to be cut off
  // against the magnitude meter.
  assert.equal((1e6).toLocaleString("en-US").length, 9);
  assert.equal(tally(1e6), "1.00M");
  assert.equal(tally(4.2e9), "4.20B");
  assert.equal(tally(Number.MAX_SAFE_INTEGER), "9e+15");
});

test("the session index stays inside the report plate", () => {
  let longest = "";
  for (const current of MAGNITUDES) {
    for (const total of MAGNITUDES) {
      const text = folioIndex(current, total);
      if (text.length > longest.length) longest = text;
    }
  }
  assert.ok(
    longest.length <= SLOT_BUDGET.folioIndex,
    `widest session index ${JSON.stringify(longest)} is ${longest.length} characters, budget ${SLOT_BUDGET.folioIndex}`,
  );
  // The plate's own typography survives the bound: a small ledger still reads
  // as two padded digits, and only a single digit is padded.
  assert.equal(folioIndex(1, 5), "01 / 05");
  assert.equal(folioIndex(96, 96), "96 / 96");
  assert.equal(folioIndex(7, 128), "07 / 128");
  assert.equal(folioIndex(30, 1e6), "30 / 1.00M");
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

test("the header names one machine and counts several", () => {
  // The reported case (#138): a shared Drive ledger written by a laptop and a
  // desktop printed the busiest machine's name under a singular label, so the
  // reader was told the other half of their sessions did not exist.
  assert.equal(machineField(["CHI-W11-01"]), "CHI-W11-01");
  assert.equal(machineFieldLabel(["CHI-W11-01"]), "Machine");
  assert.equal(machineField(["CHI-W11-01", "CHI-W11-01"]), "CHI-W11-01");
  assert.equal(machineFieldLabel(["CHI-W11-01", "CHI-W11-01"]), "Machine");

  assert.equal(machineField(["laptop-02", "CHI-W11-01", "MAC-STUDIO"]), "3 MACHINES");
  assert.equal(machineFieldLabel(["laptop-02", "CHI-W11-01", "MAC-STUDIO"]), "Machines");
  // The busiest machine is still first in the list the header hands over, and
  // it is still not the answer.
  assert.equal(machineField(["CHI-W11-01", "LAPTOP-02"]), "2 MACHINES");

  // Case is the header's, not the ledger's, so two spellings of one hostname
  // are one machine.
  assert.equal(machineField(["chi-w11-01", "CHI-W11-01"]), "CHI-W11-01");
  assert.equal(machineField([]), "UNKNOWN");
  assert.equal(machineField([null, undefined, ""]), "UNKNOWN");
  assert.equal(machineFieldLabel([]), "Machine");
});

test("the machine field stays inside the header slot for any ledger", () => {
  // Ledgers a reader can actually assemble, measured through the formatter.
  for (const size of [2, 3, 9, 42, 999, 5000]) {
    const text = machineField(Array.from({ length: size }, (_, index) => `MACHINE-${index}`));
    assert.ok(
      text.length <= SLOT_BUDGET.machineField,
      `machine field for ${size} machines ${JSON.stringify(text)} is ${text.length} characters`,
    );
  }

  // The count form is what sets the budget, so its ceiling is checked at
  // magnitudes no ledger reaches rather than only at the ones a reader has.
  let longest = "";
  for (const count of [1e6, 9.87e6, 1e9, 1e12, 9.9e14, 1e15, Number.MAX_SAFE_INTEGER]) {
    const text = `${tally(count)} MACHINES`;
    if (text.length > longest.length) longest = text;
  }
  assert.ok(
    longest.length <= SLOT_BUDGET.machineField,
    `widest machine count ${JSON.stringify(longest)} is ${longest.length} characters, budget ${SLOT_BUDGET.machineField}`,
  );

  // A hostname the ledger chose can be any length; the slot cannot.
  const long = machineField(["a-very-long-workstation-hostname"]);
  assert.equal(long.length, SLOT_BUDGET.machineField);
  assert.ok(long.endsWith("…"), `a clipped hostname should say so: ${JSON.stringify(long)}`);
});
