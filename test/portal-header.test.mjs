import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { SLOT_BUDGET, machineField, sessionsUpdated, tally } from "../portal/usage-format.js";
import { findChrome, runPortalProbe } from "../scripts/portal-probe-runner.mjs";
import {
  EXPECTED_VALUES,
  MACHINES,
  TOPOLOGY_LIMIT,
  buildHeaderFixture,
} from "./helpers/portal-header-fixture.mjs";

/**
 * Rendered guards for what the page asserts about the ledger behind it.
 *
 * Each subject here is a fact of the renderer rather than of the source: what
 * the header says when the ledger is plural (#138), whether a column adds up
 * to the total printed under it (#134), whether the refresh control stays put
 * when it is clicked (#36), and whether a description fits on one line in the
 * space the page gives it (#24). All four are invisible to a source assertion,
 * so they are measured in the renderer the shipped app uses.
 */

/** The width the header defects were reported at, and the width the desktop
 *  shell opens on. Panel geometry that varies with width is guarded in
 *  `portal-numeric-layout.test.mjs`; what varies here is what the page says. */
const PROBE_WIDTH = 1440;

const chrome = findChrome();
const skip = chrome ? false : "no Chrome binary found; set AGENT_USAGE_STAT_CHROME to run this guard";

/** Strings the machine field can emit, widest first, for the slot check. The
 *  count form is the one that sets the budget and the one no fixture reaches. */
const MACHINE_SLOT = [
  machineField(Array.from({ length: 3 }, (_, index) => `MACHINE-${index}`)),
  `${tally(9.9e14)} MACHINES`,
  "M".repeat(SLOT_BUDGET.machineField),
];

/** Every state the refresh button can print, including the report of a first
 *  synchronization, which no fixture the probe can serve produces. The label
 *  is set in a proportional face, so the candidates are the strings the
 *  formatters actually emit rather than a row of the widest glyph. */
const SYNC_SLOT = [
  "REFRESH DATA",
  "SYNCING",
  "UP TO DATE",
  "SYNC FAILED",
  ...[1, 12, 99, 999, 1247, 999_999, 9.9e14].map(sessionsUpdated),
];

async function probeHeader() {
  const [result] = await runPortalProbe({
    portalDir: join(process.cwd(), "dist", "portal"),
    data: buildHeaderFixture(),
    probe: new URL("../scripts/portal-header-probe.js", import.meta.url),
    widths: [PROBE_WIDTH],
    input: { machineSlot: MACHINE_SLOT, syncSlot: SYNC_SLOT },
  });
  return result;
}

test("the header reports every machine that wrote the ledger", { skip }, async () => {
  const result = await probeHeader();

  // The fixture is written by two machines. Naming the busier one under a
  // singular label is the defect: it reads as the only machine there is.
  assert.equal(
    result.header.machine,
    `${MACHINES.length} MACHINES`,
    `the header named one machine on a ${MACHINES.length}-machine ledger`,
  );
  assert.equal(result.header.label, "Machines");
  assert.equal(result.header.lines, 1, "the machine field wrapped to a second line");
  assert.equal(result.header.clippedPx, 0, "the machine field was cut off by its panel");
});

test("the machine field's budget is a fact about the header slot", { skip }, async () => {
  const result = await probeHeader();

  for (const slot of result.machineSlot) {
    assert.ok(!slot.missing, "the header has no machine field to measure");
    assert.equal(slot.lines, 1, `the machine field wrapped on ${JSON.stringify(slot.text)}`);
    assert.equal(slot.clippedPx, 0, `the machine field clipped ${JSON.stringify(slot.text)}`);
  }
});

/** Dollars back out of a rendered `$1,234.56`, so the guard adds the column
 *  the way a reader would: from what is on screen. */
const dollars = (money) => Number(String(money).replace(/[^0-9.-]/g, ""));

test("the topology Value column adds up to the total printed under it", { skip }, async () => {
  const result = await probeHeader();
  const { rows, footer } = result.topology;

  assert.equal(rows.length, TOPOLOGY_LIMIT, "the table drew a different number of rows");
  const column = rows.map((row) => dollars(row.value));
  assert.equal(
    column.reduce((total, value) => total + value, 0),
    dollars(footer),
    `the Value column reads ${column.join(" + ")} under a footer of ${footer}`,
  );
  assert.equal(dollars(footer), EXPECTED_VALUES.total);

  // The rows the table has room for are still the costliest projects, named.
  assert.deepEqual(column.slice(0, -1), EXPECTED_VALUES.kept);
  assert.ok(
    rows.slice(0, -1).every((row) => row.project !== "Other"),
    "the table folded a row before it had run out of room",
  );
});

test("the folded topology row says what it stands for and offers no filter", { skip }, async () => {
  const result = await probeHeader();
  const folded = result.topology.rows[result.topology.rows.length - 1];

  assert.equal(folded.project, "Other");
  assert.equal(dollars(folded.value), EXPECTED_VALUES.folded);
  assert.equal(folded.caption, `${EXPECTED_VALUES.foldedProjects} projects`);
  // There is no one project behind the row, so nothing in it opens a project.
  assert.equal(folded.filters, 0, "the folded row offered a per-project filter");
  assert.ok(
    folded.cells.some((cell) => cell.startsWith("$")),
    `the folded row printed no values: ${JSON.stringify(folded.cells)}`,
  );
});

test("the refresh control stays where it was clicked while it syncs", { skip }, async () => {
  const result = await probeHeader();
  const { resting, syncing, settled } = result.refresh;

  // The reported defect (#36): a separate message appeared beside the button
  // and pushed it left, out from under the pointer that had just clicked it.
  assert.equal(syncing.label, "SYNCING", "the button did not take the syncing state itself");
  assert.deepEqual(syncing.box, resting.box, "the button moved or resized while syncing");

  // The probe's server has no refresh endpoint, so the request fails and the
  // button reports it. That state has to hold the same box as the other two.
  assert.equal(settled.label, "SYNC FAILED");
  assert.deepEqual(settled.box, resting.box, "the button moved when the sync settled");
});

test("the refresh button's label slot holds every state it can print", { skip }, async () => {
  const result = await probeHeader();

  for (const slot of result.refresh.slot) {
    assert.ok(!slot.missing, "the refresh button has no label slot to measure");
    assert.equal(slot.lines, 1, `the refresh label wrapped on ${JSON.stringify(slot.text)}`);
    assert.equal(slot.clippedPx, 0, `the refresh label clipped ${JSON.stringify(slot.text)}`);
  }
});

test("the session timeline description uses the column it was given", { skip }, async () => {
  const result = await probeHeader();
  const { text: sentence, lines, width, columnWidth } = result.description;

  // The reported defect (#24): the final word sat alone on a second line while
  // the column it wrapped inside still had room to spare, because the
  // paragraph carried a ceiling narrower than its own column.
  assert.ok(sentence?.length > 0, "the timeline description rendered nothing");
  assert.equal(
    lines,
    1,
    `the description wrapped to ${lines} lines in ${width}px of a ${columnWidth}px column`,
  );
});
