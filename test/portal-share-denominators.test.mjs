import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { findChrome, runPortalProbe } from "../scripts/portal-probe-runner.mjs";
import { EXPECTED_SHARES, buildShareFixture } from "./helpers/portal-share-fixture.mjs";

/**
 * Composition share guard for issue #132.
 *
 * Shares were divided by `Math.max(1, total)`, a divide-by-zero guard that
 * also rescales every share whenever the period total is below a dollar. A
 * sixty-cent week rendered "OPUS 30%, SONNET 20%, HAIKU 10%", the model ring
 * left forty percent of the donut unpainted, and the concentration ring beside
 * it disagreed because it divided correctly. Shares are computed at render
 * time, so only a rendered page can answer what the reader was shown.
 */

const chrome = findChrome();

/** One width is enough: a share is arithmetic over the ledger, not geometry,
 *  so it reads the same at every window size the shell can present. */
const PROBE_WIDTH = 1440;

async function probeShares() {
  const [result] = await runPortalProbe({
    portalDir: join(process.cwd(), "dist", "portal"),
    data: buildShareFixture(),
    probe: new URL("../scripts/portal-share-probe.js", import.meta.url),
    widths: [PROBE_WIDTH],
  });
  return result;
}

/** The percentage integers behind strings such as "33%". */
function percents(values) {
  return values.map((value) => Number(String(value).replace("%", "")));
}

test(
  "every share in a sub-dollar period divides by the period total, not by one dollar",
  { skip: chrome ? false : "no Chrome binary found; set AGENT_USAGE_STAT_CHROME to run this guard" },
  async () => {
    const result = await probeShares();

    assert.equal(result.hero, "$0.60", "the fixture period has to stay below a dollar to be the reported case");

    const modelShares = result.modelRows.map((row) => `${row.key} ${row.share}`);
    assert.deepEqual(
      modelShares,
      EXPECTED_SHARES.map((entry) => `${entry.family.toUpperCase()} ${entry.percent}%`),
      "the model ring key rescaled its shares against a one-dollar floor",
    );
    assert.equal(result.modelCaption, `${EXPECTED_SHARES[0].percent}%`, "largest-share caption");
    assert.equal(result.ringEnd, 100, "the conic gradient left part of the donut unpainted");

    assert.deepEqual(
      result.machineRows.map((row) => `${row.key} ${row.share}`),
      EXPECTED_SHARES.map((entry) => `${entry.machine} ${entry.percent}%`),
      "the machine composition rescaled its shares against a one-dollar floor",
    );

    assert.deepEqual(
      percents(result.topologyShares),
      EXPECTED_SHARES.map((entry) => entry.percent),
      "the topology model-share footer rescaled its shares against a one-dollar floor",
    );
  },
);

test(
  "each composition accounts for the whole period once rounding is allowed for",
  { skip: chrome ? false : "no Chrome binary found; set AGENT_USAGE_STAT_CHROME to run this guard" },
  async () => {
    const result = await probeShares();

    // Every row of each composition is on screen in this fixture, so the
    // printed shares are the whole period and have to add up to it. One
    // percentage point of slack per row covers `fmt.pct` rounding.
    const compositions = [
      ["model ring", result.modelRows.map((row) => row.share)],
      ["machine composition", result.machineRows.map((row) => row.share)],
      ["topology footer", result.topologyShares],
      // Token shares divide by an integer count, so they never reach the
      // sub-dollar case. They are the control: correct before and after.
      ["token composition", result.tokenRows.map((row) => row.share)],
    ];
    for (const [name, shares] of compositions) {
      const values = percents(shares);
      assert.ok(values.length > 0, `${name} rendered no rows`);
      const total = values.reduce((sum, value) => sum + value, 0);
      assert.ok(
        Math.abs(total - 100) <= values.length,
        `${name} sums to ${total}% across [${shares.join(", ")}]`,
      );
    }

    // The hero meter divides the period by itself plus the prior one. With no
    // prior activity the period is the whole bar, whatever it cost.
    assert.equal(result.heroMeter, "100%", "the hero meter rescaled against a one-dollar floor");
  },
);
