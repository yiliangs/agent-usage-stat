#!/usr/bin/env node
/**
 * Renders the built portal in headless Chrome and reports every numeric slot
 * whose text wraps to a second line or is clipped by an ancestor.
 *
 * Panel overflow is a layout fact, so it cannot be checked by reading CSS: the
 * same declaration fits at one window width and clips at another. The browser
 * plumbing lives in `portal-probe-runner.mjs`; this file owns the numeric-slot
 * probe and the finding shape it produces.
 */

import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { SUPPORTED_WIDTHS, findChrome, runPortalProbe } from "./portal-probe-runner.mjs";

export { SUPPORTED_WIDTHS, findChrome };

/**
 * Render the portal at each width and return every overflowing numeric slot.
 * `data` supplies `sessions.json` and `meta.json` exactly as the desktop build
 * writes them.
 */
export async function measurePortalLayout({ portalDir, data, widths = SUPPORTED_WIDTHS, height = 960 }) {
  const results = await runPortalProbe({
    portalDir,
    data,
    probe: new URL("portal-layout-probe.js", import.meta.url),
    widths,
    height,
  });
  return results.flatMap((result) => result.findings.map((finding) => ({ width: result.width, ...finding })));
}

if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { buildLayoutFixture } = await import("../test/helpers/portal-layout-fixture.mjs");
  const findings = await measurePortalLayout({
    portalDir: join(process.cwd(), "dist", "portal"),
    data: buildLayoutFixture(),
  });
  for (const finding of findings) {
    console.log(
      `${String(finding.width).padStart(4)}  ${finding.view.padEnd(9)} ${finding.reason.padEnd(5)} ` +
        `${finding.selector}  ${JSON.stringify(finding.text)}  lines=${finding.lines} clip=${finding.clippedPx}px`,
    );
  }
  console.log(`${findings.length} overflowing numeric slots`);
}
