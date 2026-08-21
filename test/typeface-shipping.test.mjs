import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { findChrome, runPortalProbe } from "../scripts/portal-probe-runner.mjs";
import { STARTUP_URL } from "../dist/desktop/startup-screen.js";
import { buildLayoutFixture } from "./helpers/portal-layout-fixture.mjs";

/**
 * Shipped-typeface guard for issue #73.
 *
 * The interface names IBM Plex Sans, Geist Mono, and Libre Baskerville, and for
 * a long time named them and nothing more. A workstation with those faces
 * installed renders the design correctly and reports nothing wrong, while every
 * machine without them drops to Segoe UI, Consolas, and Georgia. Reading the
 * stylesheet cannot separate the two, so this renders each surface and asks the
 * document itself, through `document.fonts`, which sees only the page's own
 * `@font-face` rules.
 *
 * Two surfaces declare the typography tokens and both are checked here. They
 * carry their faces differently, because the first-run window is a `data:` URL
 * document with no path to resolve a font file against, and a guard that
 * covered only the dashboard would let the other one drift back.
 */

const chrome = findChrome();
const probe = join(process.cwd(), "scripts", "typeface-probe.js");
const skip = chrome
  ? false
  : "no Chrome binary found; set AGENT_USAGE_STAT_CHROME to run this guard";

/** Assert one probe result, naming every face the surface asks for but does
 *  not ship. */
function assertShipsWhatItDraws(surface, result) {
  assert.ok(
    result.designed.length >= 3,
    `${surface}: expected the typography tokens to name designed faces, got ${JSON.stringify(result.designed)}`,
  );
  assert.ok(
    result.demanded.length > 0,
    `${surface}: expected the rendered surface to draw text in its designed faces`,
  );

  const report = result.missing
    .map((entry) =>
      `${entry.family} ${entry.weight} (first seen in ${entry.view}: ${JSON.stringify(entry.sample)}) ` +
      `matched ${entry.matched} @font-face rules`,
    )
    .join("\n");
  assert.equal(
    result.missing.length,
    0,
    `${surface} draws in faces it does not ship, so these fall back to system fonts:\n${report}`,
  );
}

test("the dashboard ships every designed face and weight it draws with", { skip }, async () => {
  const [result] = await runPortalProbe({
    portalDir: join(process.cwd(), "dist", "portal"),
    data: buildLayoutFixture(),
    probe,
    widths: [1440],
  });
  assertShipsWhatItDraws("the dashboard", result);
});

test("the first-run window ships every designed face and weight it draws with", { skip }, async () => {
  // The window loads this document from a `data:` URL, where a relative font
  // path has nothing to resolve against. Serving the same markup from a
  // directory measures what the window renders without pretending it has a
  // origin of its own: the faces have to be carried inside the document.
  const html = decodeURIComponent(STARTUP_URL.slice(STARTUP_URL.indexOf(",") + 1));
  const surfaceDir = await mkdtemp(join(tmpdir(), "aus-startup-"));
  try {
    await writeFile(join(surfaceDir, "index.html"), html, "utf8");
    const [result] = await runPortalProbe({
      portalDir: surfaceDir,
      data: {},
      probe,
      widths: [1040],
    });
    assertShipsWhatItDraws("the first-run window", result);
  } finally {
    await rm(surfaceDir, { recursive: true, force: true });
  }
});
