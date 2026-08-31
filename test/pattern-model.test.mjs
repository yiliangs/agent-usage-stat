import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  SLOTS_IN_WEEK,
  TERRITORIES,
  buildUsagePattern,
  territoryOf,
  weekKeyOf,
  weekdayOfKey,
} from "../portal/pattern-model.js";
import { createCalendarProjection, normalizeSession } from "../portal/usage-model.js";

const utc = createCalendarProjection("UTC");

/** A session with no turn detail, so it folds at its own completion time. */
function session(end, tokens, project = "Alpha", extra = {}) {
  return normalizeSession(
    { start: end, end, project, machine: "box", provider: "claude", models: ["claude-opus-5"], totalTokens: tokens, ...extra },
    0,
  );
}

/** A session whose turns account for its total, so the fold has to read them
 *  rather than the session window. */
function turnedSession(start, end, turns, project = "Alpha") {
  const totalTokens = turns.reduce((carried, turn) => carried + turn.totalTokens, 0);
  return normalizeSession(
    {
      start,
      end,
      project,
      machine: "box",
      provider: "claude",
      models: ["claude-opus-5"],
      totalTokens,
      input: 0,
      output: 0,
      cacheCreate: 0,
      cacheRead: 0,
      turns: turns.map((turn) => ({ input: 0, output: 0, cacheCreate: 0, cacheRead: 0, ...turn })),
    },
    0,
  );
}

test("the fold reads the Monday-first weekday and the calendar week of a projected day", () => {
  assert.deepEqual(
    ["2026-08-03", "2026-08-08", "2026-08-09", "2026-08-10"].map(weekdayOfKey),
    [0, 5, 6, 0],
  );
  assert.deepEqual(
    ["2026-08-03", "2026-08-08", "2026-08-09", "2026-08-10"].map(weekKeyOf),
    ["2026-08-03", "2026-08-03", "2026-08-03", "2026-08-10"],
  );
});

test("a session with an accounted turn breakdown folds at its turns, not its window", () => {
  const pattern = buildUsagePattern(
    [
      turnedSession("2026-08-03T09:00:00.000Z", "2026-08-03T21:30:00.000Z", [
        { end: "2026-08-03T09:30:00.000Z", totalTokens: 100 },
        { end: "2026-08-03T21:30:00.000Z", totalTokens: 300 },
      ]),
    ],
    utc,
  );

  assert.equal(pattern.tokens, 400);
  assert.equal(pattern.matrix[0][9], 100, "the first turn belongs to 09:00, not to the session end");
  assert.equal(pattern.matrix[0][21], 300);
  assert.equal(pattern.hourTotals.reduce((carried, value) => carried + value, 0), 400);
  assert.deepEqual(pattern.days.map((day) => day.key), ["2026-08-03"]);
  assert.equal(pattern.days[0].hours[9], 100);
});

test("a turn list that does not account for its session folds at the session instead", () => {
  const partial = turnedSession("2026-08-03T09:00:00.000Z", "2026-08-03T21:00:00.000Z", [
    { end: "2026-08-03T09:30:00.000Z", totalTokens: 100 },
  ]);
  partial.totalTokens = 400;

  const pattern = buildUsagePattern([partial], utc);

  assert.equal(pattern.tokens, 400);
  assert.equal(pattern.matrix[0][9], 0, "a partial turn list must not place the session's volume");
  assert.equal(pattern.matrix[0][21], 400);
});

test("recorded days carry a recency ramp and empty days never enter it", () => {
  const pattern = buildUsagePattern(
    [
      session("2026-08-03T10:00:00.000Z", 100),
      session("2026-08-05T10:00:00.000Z", 100),
      session("2026-08-10T10:00:00.000Z", 100),
    ],
    utc,
  );

  assert.deepEqual(pattern.days.map((day) => day.key), ["2026-08-03", "2026-08-05", "2026-08-10"]);
  assert.deepEqual(pattern.days.map((day) => day.recency), [0, 0.5, 1]);
  assert.deepEqual(pattern.weeks.map((week) => [week.key, week.days.length]), [
    ["2026-08-03", 2],
    ["2026-08-10", 1],
  ]);
});

test("a single recorded day sits at the recent end rather than dividing by zero", () => {
  const pattern = buildUsagePattern([session("2026-08-03T10:00:00.000Z", 100)], utc);

  assert.deepEqual(pattern.days.map((day) => day.recency), [1]);
});

test("the quiet stretch is the longest run under 12 percent of the busiest hour, across midnight", () => {
  const busy = [8, 9, 10, 11, 20, 21, 22, 23].map((hour) =>
    session(`2026-08-03T${String(hour).padStart(2, "0")}:00:00.000Z`, 1000),
  );
  const trickle = [4, 5].map((hour) =>
    session(`2026-08-03T${String(hour).padStart(2, "0")}:00:00.000Z`, 500),
  );
  const pattern = buildUsagePattern([...busy, ...trickle], utc);

  assert.deepEqual(
    { start: pattern.quietStretch.start, length: pattern.quietStretch.length, end: pattern.quietStretch.end },
    { start: 12, length: 8, end: 20 },
  );

  const wrapping = buildUsagePattern(
    [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18].map((hour) =>
      session(`2026-08-03T${String(hour).padStart(2, "0")}:00:00.000Z`, 1000),
    ),
    utc,
  );
  assert.deepEqual(
    { start: wrapping.quietStretch.start, length: wrapping.quietStretch.length, end: wrapping.quietStretch.end },
    { start: 19, length: 11, end: 6 },
    "a stretch straddling midnight is one run, not two",
  );
});

test("an empty period reports no quiet stretch and no half-volume footprint", () => {
  const pattern = buildUsagePattern([], utc);

  assert.equal(pattern.quietStretch, null);
  assert.equal(pattern.halfVolumeSlots, 0);
  assert.equal(pattern.tokens, 0);
  assert.deepEqual(pattern.days, []);
  assert.deepEqual(pattern.projects, []);
  assert.deepEqual(pattern.territories.map((territory) => territory.share), [0, 0, 0, 0]);
});

test("the half-volume footprint counts the heaviest slots it takes to reach half the volume", () => {
  const pattern = buildUsagePattern(
    [
      session("2026-08-03T10:00:00.000Z", 500),
      session("2026-08-04T10:00:00.000Z", 300),
      session("2026-08-05T10:00:00.000Z", 100),
      session("2026-08-06T10:00:00.000Z", 100),
    ],
    utc,
  );

  assert.equal(pattern.tokens, 1000);
  assert.equal(pattern.halfVolumeSlots, 1, "one 500-token slot already holds half of 1000");
  assert.deepEqual(pattern.peakSlot, { weekday: 0, hour: 10, tokens: 500 });
  assert.deepEqual(pattern.peakDay, { index: 0, tokens: 500 });
  assert.deepEqual(pattern.leastDay, { index: 4, tokens: 0 });
});

test("the territories partition the folded week and their hour budgets close on 168", () => {
  assert.equal(TERRITORIES.reduce((carried, territory) => carried + territory.hours, 0), SLOTS_IN_WEEK);

  const counted = new Map(TERRITORIES.map((territory) => [territory.key, 0]));
  for (let weekday = 0; weekday < 7; weekday += 1) {
    for (let hour = 0; hour < 24; hour += 1) counted.set(territoryOf(weekday, hour), counted.get(territoryOf(weekday, hour)) + 1);
  }
  assert.deepEqual(
    TERRITORIES.map((territory) => counted.get(territory.key)),
    TERRITORIES.map((territory) => territory.hours),
    "the hour budgets are the count of slots each territory actually holds",
  );

  const pattern = buildUsagePattern(
    [
      session("2026-08-03T10:00:00.000Z", 400),
      session("2026-08-03T20:00:00.000Z", 300),
      session("2026-08-04T03:00:00.000Z", 200),
      session("2026-08-08T14:00:00.000Z", 100),
    ],
    utc,
  );

  assert.deepEqual(
    pattern.territories.map((territory) => [territory.key, territory.tokens, territory.share]),
    [
      ["work", 400, 0.4],
      ["evening", 300, 0.3],
      ["early", 200, 0.2],
      ["weekend", 100, 0.1],
    ],
  );
  assert.deepEqual(
    pattern.territories.map((territory) => territory.timeShare),
    [45 / 168, 30 / 168, 45 / 168, 48 / 168],
  );
});

test("the daypart lead is the largest six-hour block of the clock", () => {
  const pattern = buildUsagePattern(
    [
      session("2026-08-03T02:00:00.000Z", 100),
      session("2026-08-03T09:00:00.000Z", 200),
      session("2026-08-03T13:00:00.000Z", 150),
      session("2026-08-03T19:00:00.000Z", 550),
    ],
    utc,
  );

  assert.deepEqual(
    { range: pattern.dayparts.lead.range, share: pattern.dayparts.lead.share },
    { range: "18–24H", share: 0.55 },
  );
  assert.deepEqual(pattern.dayparts.all.map((part) => part.tokens), [100, 200, 150, 550]);
});

test("a project peak window is circular and stops widening at eight hours", () => {
  const late = [22, 23, 0, 1].map((hour) =>
    session(`2026-08-0${hour >= 22 ? 3 : 4}T${String(hour).padStart(2, "0")}:00:00.000Z`, 1000, "Nightshift"),
  );
  const flat = Array.from({ length: 24 }, (_, hour) =>
    session(`2026-08-05T${String(hour).padStart(2, "0")}:00:00.000Z`, 10, "Always"),
  );
  const pattern = buildUsagePattern([...late, ...flat], utc);

  const nightshift = pattern.projects.find((row) => row.project === "Nightshift");
  assert.deepEqual(
    { start: nightshift.windowStart, end: nightshift.windowEnd },
    { start: 22, end: 2 },
    "a window running past midnight reports one range",
  );

  const always = pattern.projects.find((row) => row.project === "Always");
  assert.equal((always.windowEnd - always.windowStart + 24) % 24, 8, "a flat project is capped, not given the whole clock");
});

test("projects past the limit fold into one row that conserves the hour totals", () => {
  const sessions = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"].map((project, index) =>
    session("2026-08-03T10:00:00.000Z", 600 - index * 100, project),
  );
  const pattern = buildUsagePattern(sessions, utc, { projectLimit: 4 });

  assert.deepEqual(
    pattern.projects.map((row) => [row.project, row.tokens]),
    [
      ["Alpha", 600],
      ["Beta", 500],
      ["Gamma", 400],
      ["Delta", 300],
      ["Other projects", 300],
    ],
  );
  assert.deepEqual(pattern.projects.map((row) => row.other), [false, false, false, false, true]);
  assert.equal(
    pattern.projects.reduce((carried, row) => carried + row.hours[10], 0),
    pattern.hourTotals[10],
    "the stacked segments have to add up to the hour they are drawn in",
  );
  assert.equal(
    pattern.projects.reduce((carried, row) => carried + row.share, 0).toFixed(6),
    "1.000000",
  );
});

test("the Pattern view declares every container its renderer writes into", async () => {
  const portalRoot = join(process.cwd(), "portal");
  const [html, script] = await Promise.all([
    readFile(join(portalRoot, "index.html"), "utf8"),
    readFile(join(portalRoot, "portal.js"), "utf8"),
  ]);

  assert.match(html, /data-portal-view="pattern">Pattern</, "expected a Pattern tab in the tab strip");
  assert.match(
    html,
    /<section class="analysis-view portal-view" id="patternView" data-view="pattern" hidden>/,
    "expected the Pattern view to use the shared analysis-view scaffold",
  );

  const targets = [...script.matchAll(/\$\('(#pattern[A-Za-z]+)'\)/g)].map((match) => match[1]);
  assert.ok(targets.length >= 6, `expected the renderer to address the Pattern view, saw ${targets.length} targets`);
  for (const target of new Set(targets)) {
    assert.match(html, new RegExp(`id="${target.slice(1)}"`), `${target} has no element to write into`);
  }

  assert.doesNotMatch(
    html.slice(html.indexOf('id="patternView"'), html.indexOf('id="projectsView"')),
    /#[0-9a-f]{6}/i,
    "the Pattern view has to take its colours from the palette variables, which dark mode redefines",
  );
});

test("the Pattern view names no colour the dark palette cannot redefine", async () => {
  // Dark mode swaps every entry in the palette but leaves a literal alone, so
  // one hard-coded hue survives the switch and lands unreadable. The rules are
  // written against variables; this is what keeps them that way. Only the
  // renderer's own colours are checked here, since the markup carries none.
  const [html, script] = await Promise.all([
    readFile(join(process.cwd(), "portal", "index.html"), "utf8"),
    readFile(join(process.cwd(), "portal", "portal.js"), "utf8"),
  ]);

  const patternRules = [...html.matchAll(/^\s{4}([^{}\n]*\.pattern-[^{}\n]*)\{([^}]*)\}/gm)];
  assert.ok(patternRules.length > 20, `expected the Pattern stylesheet, saw ${patternRules.length} rules`);
  for (const [, selector, body] of patternRules) {
    assert.doesNotMatch(body, /#[0-9a-f]{3,8}\b/i, `${selector.trim()} hard-codes a colour`);
    assert.doesNotMatch(body, /\brgba?\(\s*\d/i, `${selector.trim()} hard-codes a colour`);
  }

  const renderer = script.slice(script.indexOf("function renderPatternAnalysis"), script.indexOf("function formatDuration"));
  assert.ok(renderer.length > 2000, "expected the Pattern renderer");
  assert.doesNotMatch(renderer, /#[0-9a-f]{3,8}\b/i, "the Pattern renderer hard-codes a colour");
  assert.doesNotMatch(renderer, /\brgba?\(\s*\d/i, "the Pattern renderer hard-codes a colour");
});
