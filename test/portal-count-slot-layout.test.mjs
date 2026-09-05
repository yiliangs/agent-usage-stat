import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { SUPPORTED_WIDTHS, findChrome, runPortalProbe } from "../scripts/portal-probe-runner.mjs";
import { SLOT_BUDGET, folioIndex, tally } from "../portal/usage-format.js";
import { buildLayoutFixture } from "./helpers/portal-layout-fixture.mjs";

/**
 * Rendered ceiling guard for the two slots that hold a session count (#94).
 *
 * `portal-numeric-layout.test.mjs` renders a fixture and catches a panel too
 * small for the numbers that fixture happens to produce. It cannot reach these
 * two: the metric slot only overflows at a million sessions and the report
 * plate at far more, and no fixture a browser can render carries either. So
 * this guard renders the portal once per window width and writes every string
 * the count formats can emit into the real slots, in the real page.
 *
 * That makes it the pair to the budget test in `usage-format.test.mjs`. That
 * one asserts the formats never exceed their `SLOT_BUDGET` entry; this one
 * asserts the entry is a fact about the slot rather than a number someone
 * typed.
 */

/** Session counts spanning every branch of `tally`, including ones no install
 *  will reach. A ceiling that holds only for plausible data is not a ceiling. */
const COUNTS = [
  0, 1, 5, 9, 42, 96, 999, 1000, 9999, 12_345, 99_999, 654_321, 999_999,
  1e6, 9.87e6, 1e9, 4.2e9, 1e12, 9.9e14, 1e15, Number.MAX_SAFE_INTEGER,
];

const unique = (texts) => [...new Set(texts)];

/** The report plate prints a period count over a ledger count, so it is the
 *  pairs that matter: a small current period inside a very large ledger is the
 *  widest the index gets, and it is also the ordinary case. */
function folioTexts() {
  const largest = COUNTS[COUNTS.length - 1];
  return unique([
    ...COUNTS.map((count) => folioIndex(count, count)),
    ...COUNTS.map((count) => folioIndex(count, largest)),
    ...COUNTS.map((count) => folioIndex(0, count)),
  ]);
}

const CASES = [
  {
    selector: ".metric b",
    label: `session count, budget ${SLOT_BUDGET.metricValue}`,
    texts: unique(COUNTS.map(tally)),
  },
  {
    selector: ".folio .index",
    label: `session index, budget ${SLOT_BUDGET.folioIndex}`,
    // The index and its "Report plate" label shrink together in one flex row,
    // so the label is what breaks first when the index outgrows the column.
    neighbours: [".folio .micro"],
    texts: folioTexts(),
  },
];

const chrome = findChrome();

test(
  "every string the count formats can produce fits its slot at every supported window width",
  { skip: chrome ? false : "no Chrome binary found; set AGENT_USAGE_STAT_CHROME to run this guard" },
  async () => {
    const results = await runPortalProbe({
      portalDir: join(process.cwd(), "dist", "portal"),
      data: buildLayoutFixture(),
      probe: new URL("../scripts/portal-count-slot-probe.js", import.meta.url),
      widths: SUPPORTED_WIDTHS,
      input: { cases: CASES },
    });
    const findings = results.flatMap((result) => result.findings.map((finding) => ({ width: result.width, ...finding })));
    const report = findings
      .map((finding) =>
        `${finding.width}px ${finding.label} (${finding.selector}) ${finding.reason}: ` +
        `${JSON.stringify(finding.text)} lines=${finding.lines} clipped=${finding.clippedPx}px`,
      )
      .join("\n");
    assert.equal(findings.length, 0, `count slots overflow their panels:\n${report}`);
  },
);
