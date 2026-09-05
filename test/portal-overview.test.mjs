import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { findChrome, runPortalProbe } from "../scripts/portal-probe-runner.mjs";
import { compact } from "../portal/usage-format.js";
import {
  TOTAL_TOKENS,
  buildPriorPeriodFixture,
} from "./helpers/portal-prior-period-fixture.mjs";

/**
 * Overview hero guard for issue #125.
 *
 * The hero leads with the token volume the selected period recorded, in the
 * typography the API-value figure beside it uses. Typography is declared, so
 * it is read out of the stylesheet; the figure is written by a renderer, so it
 * is read off the rendered page.
 *
 * This guard used to match the source line that writes the figure, which is
 * neither. It passed on a line inside a function nothing called and failed on
 * a change of quote style, so the hero could stop printing token volume, or
 * print the wrong figure, with the suite green.
 */

const PROBE_WIDTH = 1440;
const portalRoot = join(process.cwd(), "portal");

const chrome = findChrome();
const skip = chrome ? false : "no Chrome binary found; set AGENT_USAGE_STAT_CHROME to run this guard";

test("the overview hero leads with the token volume the period recorded", { skip }, async () => {
  const [result] = await runPortalProbe({
    portalDir: join(process.cwd(), "dist", "portal"),
    data: buildPriorPeriodFixture(),
    probe: new URL("../scripts/portal-overview-probe.js", import.meta.url),
    widths: [PROBE_WIDTH],
  });

  // The whole fixture sits inside the default window, so the period the page
  // opens on is the whole ledger and its token volume is the fixture's own.
  assert.equal(result.range, "30D", "the page did not open on its default range");
  assert.equal(
    result.tokenHero,
    compact(TOTAL_TOKENS),
    "the overview hero does not print the period's token volume",
  );
  assert.equal(
    result.tokensMetric,
    compact(TOTAL_TOKENS),
    "the hero and the Tokens metric disagree about the same quantity",
  );
});

test("the overview hero carries the API-value hero typography", async () => {
  const html = await readFile(join(portalRoot, "index.html"), "utf8");

  assert.match(html, /<span class="micro">Token volume<\/span>/);
  assert.doesNotMatch(html, /<div class="period-range"><strong>30D<\/strong>/);

  const tokenHero = declarations(html, ".period-range strong");
  const valueHero = declarations(html, ".hero-number .value");
  for (const property of ["font-family", "font-size", "line-height", "letter-spacing"]) {
    assert.equal(tokenHero[property], valueHero[property], property);
  }
});

function declarations(html, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `expected styles for ${selector}`);
  return Object.fromEntries(
    [...match[1].matchAll(/([\w-]+):\s*([^;]+);/g)].map((entry) => [
      entry[1],
      entry[2].trim(),
    ]),
  );
}
