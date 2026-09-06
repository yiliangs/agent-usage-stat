import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { findChrome, runPortalProbe } from "../scripts/portal-probe-runner.mjs";
import {
  ACTIVE_SESSIONS_TEXT,
  DOUBLE_COUNTED_TOKENS_TEXT,
  FIRST_DATE_TOKENS_TEXT,
  SECOND_DATE_TOKENS_TEXT,
  buildOvernightFixture,
  overnightRowLabels,
} from "./helpers/portal-rhythm-fixture.mjs";

/**
 * Rhythm-table guard for issue #93.
 *
 * A session running across midnight is drawn on both dates, and the table
 * summing whole-session totals off those segments reported its entire volume
 * on each. The columns are built in the renderer from the segments it drew, so
 * what they count is only readable off the page.
 *
 * One width is enough; nothing here varies with geometry.
 */

const PROBE_WIDTH = 1440;

const chrome = findChrome();
const skip = chrome ? false : "no Chrome binary found; set AGENT_USAGE_STAT_CHROME to run this guard";

test("an overnight session's tokens are counted once and its activity twice", { skip }, async () => {
  const [result] = await runPortalProbe({
    portalDir: join(process.cwd(), "dist", "portal"),
    data: buildOvernightFixture(),
    probe: new URL("../scripts/portal-rhythm-table-probe.js", import.meta.url),
    widths: [PROBE_WIDTH],
  });

  const [firstLabel, secondLabel] = overnightRowLabels();
  const rowFor = (label) => {
    const row = result.rows.find((entry) => entry.date === label);
    assert.ok(row, `the table has no ${label} row; drew [${result.rows.map((entry) => entry.date).join(", ")}]`);
    return row;
  };

  const first = rowFor(firstLabel);
  const second = rowFor(secondLabel);

  assert.notEqual(
    first.cells[2],
    DOUBLE_COUNTED_TOKENS_TEXT,
    "the date the session started on still carries its whole volume, which the date it finished on carries too",
  );
  assert.equal(first.cells[2], FIRST_DATE_TOKENS_TEXT);
  assert.equal(second.cells[2], SECOND_DATE_TOKENS_TEXT);

  // The session was running on both dates, so both count it as active. That is
  // the column the activity window beside it belongs to, and it is why the
  // header says active rather than plain sessions.
  assert.equal(first.cells[1], ACTIVE_SESSIONS_TEXT);
  assert.equal(second.cells[1], ACTIVE_SESSIONS_TEXT);

  assert.deepEqual(result.headers, ["Date", "Activity window", "Active sessions", "Recorded tokens"]);

  assert.ok(result.caption, "the table states no rule for the two ways its columns count");
  assert.match(result.caption, /Recorded tokens/);
  assert.match(result.caption, /Active sessions/);
});
