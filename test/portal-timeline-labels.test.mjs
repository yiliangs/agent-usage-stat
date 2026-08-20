import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { SUPPORTED_WIDTHS, findChrome, runPortalProbe } from "../scripts/portal-probe-runner.mjs";
import { TIMELINE_PROJECTS, buildTimelineFixture } from "./helpers/portal-timeline-fixture.mjs";

/**
 * Block-naming guard for issue #65.
 *
 * Concurrent sessions divide a day column into lanes, so a busy day draws every
 * block too narrow for horizontal text and the timeline turns into a wall of
 * anonymous bars. Which blocks keep their name is decided by container queries
 * against the drawn box, so only a rendered page can answer it.
 *
 * The design declines to name a block with no room for one in either
 * direction. Every session in the fixture is long enough that the block is well
 * past that point on its long axis, so an unnamed block here is a defect.
 */

/** A block the design commits to naming: at least 42px of content on its long
 *  axis, which is the same room the horizontal label asks for. */
const NAMEABLE_HEIGHT_PX = 56;

const chrome = findChrome();

test(
  "every session block with room for its name shows it, however dense the day",
  { skip: chrome ? false : "no Chrome binary found; set AGENT_USAGE_STAT_CHROME to run this guard" },
  async () => {
    const results = await runPortalProbe({
      portalDir: join(process.cwd(), "dist", "portal"),
      data: buildTimelineFixture(),
      probe: new URL("../scripts/portal-timeline-probe.js", import.meta.url),
      widths: SUPPORTED_WIDTHS,
    });

    const expected = [...TIMELINE_PROJECTS, "overnight-mission"];
    const failures = [];
    for (const result of results) {
      const nameable = result.blocks.filter((block) => block.height >= NAMEABLE_HEIGHT_PX);
      assert.ok(nameable.length > 0, `${result.width}px rendered no timeline blocks to check`);
      // A wrapped name contributes no separator of its own, so the drawn text
      // spells the project exactly when the label is whole.
      const shown = new Set(nameable.map((block) => block.name).filter(Boolean));
      for (const project of expected) {
        if (shown.has(project)) continue;
        const anonymous = nameable
          .filter((block) => !block.name)
          .map((block) => `${block.width}x${block.height}px "${block.tip.split(" | ")[0]}"`);
        failures.push(
          `${result.width}px: no block names ${project}; ` +
            `${anonymous.length} of ${nameable.length} blocks are anonymous ` +
            `[${anonymous.slice(0, 6).join(", ")}]; named [${[...shown].join(", ")}]`,
        );
        break;
      }
    }

    assert.deepEqual(failures, [], `session blocks lost their names:\n${failures.join("\n")}`);
  },
);
