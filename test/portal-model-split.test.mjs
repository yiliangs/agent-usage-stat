import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { findChrome, runPortalProbe } from "../scripts/portal-probe-runner.mjs";
import {
  EXPECTED_FAMILIES,
  PERIOD_COST,
  buildModelSplitFixture,
} from "./helpers/portal-model-split-fixture.mjs";

/**
 * Rendered guard for issue #89.
 *
 * Every model composition on the page is computed at render time from the
 * loaded ledger, so what a session was charged to is a fact of the running page
 * rather than of the source. A session that routed to two models was billed
 * whole to the first one named: the ring drew a single slice, the topology
 * footer put a hundred percent under one family, and neither said so.
 *
 * The shares are read back through the same probe the denominator guard uses,
 * because both guards ask the same rendered surfaces the same question and a
 * second probe reporting the same fields would be a second answer to it.
 */

const chrome = findChrome();
const skip = chrome ? false : "no Chrome binary found; set AGENT_USAGE_STAT_CHROME to run this guard";

/** A share is arithmetic over the ledger rather than geometry, so it reads the
 *  same at every window width the shell can present. */
const PROBE_WIDTH = 1440;

async function probeSplit() {
  const [result] = await runPortalProbe({
    portalDir: join(process.cwd(), "dist", "portal"),
    data: buildModelSplitFixture(),
    probe: new URL("../scripts/portal-share-probe.js", import.meta.url),
    widths: [PROBE_WIDTH],
  });
  return result;
}

/** The percentage integers behind strings such as "70%". */
function percents(values) {
  return values.map((value) => Number(String(value).replace("%", "")));
}

test("the model ring draws a session across every family it routed to", { skip }, async () => {
  const result = await probeSplit();

  assert.equal(
    result.hero,
    `$${PERIOD_COST.toFixed(2)}`,
    "the fixture period is not the one the guard computes its shares against",
  );

  assert.deepEqual(
    result.modelRows.map((row) => `${row.key} ${row.share}`),
    EXPECTED_FAMILIES.map((entry) => `${entry.family.toUpperCase()} ${entry.percent}%`),
    "the ring charged the whole session to one model family",
  );
  // The costliest family leads the key and names the caption, and it is not the
  // family of the model the shard happens to list first.
  assert.equal(result.modelCaption, `${EXPECTED_FAMILIES[0].percent}%`);
  assert.equal(result.ringEnd, 100, "the conic gradient left part of the donut unpainted");
});

test("the topology model shares divide the period the same way the ring does", { skip }, async () => {
  const result = await probeSplit();

  assert.deepEqual(
    percents(result.topologyShares),
    EXPECTED_FAMILIES.map((entry) => entry.percent),
    "the project by model grid charged the whole session to one family",
  );
  // The grid still totals the period, so the split moved spend between columns
  // rather than adding any.
  assert.equal(result.topologyTotal, `$${PERIOD_COST.toFixed(2)}`);
});
