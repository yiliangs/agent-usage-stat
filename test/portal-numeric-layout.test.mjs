import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { SUPPORTED_WIDTHS, findChrome, measurePortalLayout } from "../scripts/measure-portal-layout.mjs";
import { buildLayoutFixture } from "./helpers/portal-layout-fixture.mjs";

/**
 * Panel sizing guard for issue #26.
 *
 * A number that wraps to a second line or is cut off by its panel is a layout
 * fact, invisible to a CSS string assertion: the same rule fits at 1440 and
 * clips at 1280. This renders the built portal at every window width the
 * desktop shell can present and fails on any numeric slot that overflows.
 */

const chrome = findChrome();

test(
  "no numeric slot wraps or clips at any supported window width",
  { skip: chrome ? false : "no Chrome binary found; set AGENT_USAGE_STAT_CHROME to run this guard" },
  async () => {
    const findings = await measurePortalLayout({
      portalDir: join(process.cwd(), "dist", "portal"),
      data: buildLayoutFixture(),
      widths: SUPPORTED_WIDTHS,
    });
    const report = findings
      .map((finding) =>
        `${finding.width}px ${finding.view}/${finding.label} (${finding.selector}) ` +
        `${finding.reason}: ${JSON.stringify(finding.text)} lines=${finding.lines} clipped=${finding.clippedPx}px`,
      )
      .join("\n");
    assert.equal(findings.length, 0, `numeric slots overflow their panels:\n${report}`);
  },
);
