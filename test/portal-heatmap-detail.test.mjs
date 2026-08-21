import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { findChrome, runPortalProbe } from "../scripts/portal-probe-runner.mjs";
import { buildHeatmapFixture, heatmapExpectations } from "./helpers/portal-heatmap-fixture.mjs";

/**
 * Day-detail guard for issue #69.
 *
 * Every heatmap day is drawn as a button with a pointer cursor, so the page
 * tells the reader the mark is interactive. Whether clicking it opens anything
 * is a fact of the rendered page rather than of the markup, so this drives a
 * real click in the renderer the shipped app uses.
 *
 * One width is enough: the behaviour under test is what a click does, and the
 * panel geometry that does vary by width is already guarded elsewhere.
 */

const PROBE_WIDTH = 1440;

const chrome = findChrome();
const skip = chrome ? false : "no Chrome binary found; set AGENT_USAGE_STAT_CHROME to run this guard";

async function probeHeatmap(now) {
  const [result] = await runPortalProbe({
    portalDir: join(process.cwd(), "dist", "portal"),
    data: buildHeatmapFixture(now),
    probe: new URL("../scripts/portal-heatmap-probe.js", import.meta.url),
    widths: [PROBE_WIDTH],
  });
  assert.ok(result.heatmapVisible, "the heatmap view did not render");
  assert.ok(result.cellCount > 0, "the heatmap rendered no day cells");
  return result;
}

function dayIn(result, label) {
  const day = result.days.find((entry) => entry.day === label);
  assert.ok(day, `no heatmap cell was drawn for ${label}; drew [${result.days.map((entry) => entry.day).join(", ")}]`);
  return day;
}

function sectionOf(drawer, title) {
  const section = drawer.sections.find((entry) => entry.title === title);
  assert.ok(section, `the drawer has no ${title} section; it has [${drawer.sections.map((entry) => entry.title).join(", ")}]`);
  return section;
}

test("clicking a heatmap day opens that day's detail", { skip }, async () => {
  const now = Date.now();
  const expected = heatmapExpectations(now);
  const result = await probeHeatmap(now);

  const busy = dayIn(result, expected.busy.label);
  assert.ok(busy.drawer, `clicking ${expected.busy.label} opened no detail view`);
  assert.equal(busy.drawer.eyebrow, "Day detail");
  assert.equal(busy.drawer.title, expected.busy.label);
  assert.deepEqual(busy.drawer.stats, [
    { label: "Day value", value: expected.busy.value },
    { label: "Sessions", value: expected.busy.sessions },
    { label: "Tokens", value: expected.busy.tokens },
    { label: "Cache read", value: expected.busy.cacheRead },
  ]);
  assert.deepEqual(sectionOf(busy.drawer, "Projects").rows, expected.busy.projects);
  assert.deepEqual(sectionOf(busy.drawer, "Model composition").rows, expected.busy.models);
  assert.equal(
    sectionOf(busy.drawer, "Sessions").rows.length,
    Number(expected.busy.sessions),
    "the drawer did not list every session recorded on the day",
  );
});

test("a heatmap day outside the selected range opens its own detail", { skip }, async () => {
  const now = Date.now();
  const expected = heatmapExpectations(now);
  const result = await probeHeatmap(now);

  // The heatmap covers the whole ledger while the range chips select a window
  // inside it, so most cells on the field are days the reader can see but has
  // not selected. Each one still stands for a day that happened.
  const distant = dayIn(result, expected.distant.label);
  assert.ok(distant.drawer, `clicking ${expected.distant.label} opened no detail view`);
  assert.equal(distant.drawer.title, expected.distant.label);
  assert.deepEqual(distant.drawer.stats, [
    { label: "Day value", value: expected.distant.value },
    { label: "Sessions", value: expected.distant.sessions },
    { label: "Tokens", value: expected.distant.tokens },
    { label: "Cache read", value: expected.distant.cacheRead },
  ]);
  assert.deepEqual(sectionOf(distant.drawer, "Projects").rows, expected.distant.projects);
  assert.deepEqual(sectionOf(distant.drawer, "Model composition").rows, expected.distant.models);
});

test("a heatmap day with nothing recorded on it opens nothing", { skip }, async () => {
  const now = Date.now();
  const expected = heatmapExpectations(now);
  const result = await probeHeatmap(now);

  const quiet = dayIn(result, expected.empty.label);
  assert.equal(quiet.sessions, 0, "the fixture's quiet day recorded sessions after all");
  assert.equal(quiet.drawer, null, `clicking ${expected.empty.label} opened an empty detail view`);
});
