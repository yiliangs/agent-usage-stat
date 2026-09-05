import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createCalendarProjection,
  foldProjects,
  makeIntervalBuckets,
  normalizeSession,
  shiftDateKey,
  summarizeProjects,
  summarizeUsage,
} from "../portal/usage-model.js";

const fixture = JSON.parse(
  await readFile(new URL("fixtures/portal-usage-sessions.json", import.meta.url), "utf8"),
);
const sessions = fixture.map(normalizeSession);

test("browser normalization accepts legacy sessions and preserves turn detail", () => {
  assert.deepEqual(sessions[0].turns, []);
  assert.deepEqual(sessions[1].turns, fixture[1].turns);
  assert.equal(sessions[1].primaryModel, "gpt-5.6-sol");
  assert.equal(sessions[1].t, Date.parse(fixture[1].end));
  assert.deepEqual(
    normalizeSession({ start: "2026-07-01T00:00:00.000Z", project: "", machine: "", provider: "", models: [] }, 9),
    {
      start: "2026-07-01T00:00:00.000Z",
      project: "Unassigned",
      machine: "Unknown",
      provider: "claude",
      models: [],
      _i: 9,
      t: Date.parse("2026-07-01T00:00:00.000Z"),
      primaryModel: "unknown",
      turns: [],
    },
  );
});

test("usage totals conserve the compact browser record fields", () => {
  assert.deepEqual(summarizeUsage(sessions), {
    cost: 11,
    sessions: 4,
    tokens: 750,
    cacheRead: 260,
    input: 190,
    output: 160,
    cacheCreate: 140,
    avgCost: 2.75,
    cacheRatio: 260 / 750,
  });
});

test("one project summary preserves insertion ties and dominant-family ties", () => {
  const summary = summarizeProjects(sessions);

  assert.equal(summary.totalCost, 11);
  assert.deepEqual(summary.all.map((project) => project.project), ["Alpha", "Beta", "Gamma"]);
  assert.deepEqual(summary.byCost.map((project) => project.project), ["Alpha", "Gamma", "Beta"]);
  assert.deepEqual(
    summary.all.map(({ project, sessions, cost, tokens, durSec, machineCount, family }) => ({
      project,
      sessions,
      cost,
      tokens,
      durSec,
      machineCount,
      family,
    })),
    [
      { project: "Alpha", sessions: 2, cost: 4, tokens: 150, durSec: 720, machineCount: 2, family: "Sonnet" },
      { project: "Beta", sessions: 1, cost: 3, tokens: 200, durSec: 1800, machineCount: 1, family: "Sol" },
      { project: "Gamma", sessions: 1, cost: 4, tokens: 400, durSec: 3600, machineCount: 1, family: "Haiku" },
    ],
  );
  assert.deepEqual(summary.all[0].families, { Sonnet: 2, Opus: 2 });
});

test("folding a project list keeps its total on the rows that remain", () => {
  // The reported shape (#134): ten projects at ten dollars down to one, under
  // a table that draws seven rows and a footer totalling all ten. Six visible
  // rows carried $45 under a footer reading $55.
  const projects = Array.from({ length: 10 }, (_, index) => ({
    project: `project-${index + 1}`,
    sessions: 2,
    cost: 10 - index,
    tokens: 100 * (10 - index),
    durSec: 60 * (10 - index),
    machineCount: 1,
    avgCost: (10 - index) / 2,
    families: { [index % 2 ? "Sonnet" : "Opus"]: 10 - index },
    family: index % 2 ? "Sonnet" : "Opus",
    last: 1000 + index,
  }));

  const folded = foldProjects(projects, 7);

  assert.equal(folded.length, 7);
  assert.deepEqual(folded.map((project) => project.project), [
    "project-1", "project-2", "project-3", "project-4", "project-5", "project-6", "Other",
  ]);
  assert.deepEqual(folded.map((project) => project.cost), [10, 9, 8, 7, 6, 5, 10]);
  assert.equal(
    folded.reduce((total, project) => total + project.cost, 0),
    projects.reduce((total, project) => total + project.cost, 0),
  );

  const other = folded[6];
  assert.equal(other.synthetic, true);
  assert.equal(other.projects, 4);
  assert.equal(other.sessions, 8);
  assert.equal(other.tokens, 1000);
  assert.equal(other.durSec, 600);
  assert.equal(other.avgCost, 1.25);
  assert.equal(other.last, 1009);
  assert.deepEqual(other.families, { Opus: 6, Sonnet: 4 });
  assert.equal(other.family, "Opus");
  // A count of distinct machines is not a sum, and the sets it came from are
  // gone by this point, so the folded row does not claim one.
  assert.equal("machineCount" in other, false);

  // A list the table can draw whole is handed back untouched, identity and all.
  const short = projects.slice(0, 5);
  assert.equal(foldProjects(short, 7), short);
  const exact = projects.slice(0, 7);
  assert.equal(foldProjects(exact, 7), exact);
});

test("calendar projection assigns the local-midnight boundary exactly", () => {
  const calendar = createCalendarProjection("America/Chicago");
  const end = Date.parse("2026-07-03T17:00:00.000Z");

  assert.equal(calendar.dateKey(new Date("2026-07-02T04:59:59.000Z")), "2026-07-01");
  assert.equal(calendar.dateKey(new Date("2026-07-02T05:00:00.000Z")), "2026-07-02");
  assert.deepEqual(
    calendar.buckets(sessions, end, 3).map(({ key, cost, sessions, tokens, families }) => ({ key, cost, sessions, tokens, families })),
    [
      { key: "2026-07-01", cost: 2, sessions: 1, tokens: 100, families: { Sonnet: 2 } },
      { key: "2026-07-02", cost: 5, sessions: 2, tokens: 250, families: { Sol: 3, Opus: 2 } },
      { key: "2026-07-03", cost: 4, sessions: 1, tokens: 400, families: { Haiku: 4 } },
    ],
  );

  const julySecond = calendar.dailyUsage(sessions, { start: end - 7 * 86_400_000, end })
    .find((row) => row.key === "2026-07-02");
  assert.deepEqual(julySecond, {
    key: "2026-07-02",
    start: Date.parse("2026-07-02T12:00:00.000Z"),
    cost: 5,
    sessions: 2,
    tokens: 250,
    families: { Sol: 3, Opus: 2 },
    input: 60,
    output: 40,
    cacheCreate: 30,
    cacheRead: 120,
  });
});

/**
 * Guard for issue #91.
 *
 * A window that names its end as a date key must not be routed back through a
 * time zone to find that key again. Kiritimati is UTC+14, so the noon-UTC
 * instant a key is stamped at falls on the following local date, and the round
 * trip lands the whole window a day late. The prior window is the same defect
 * one step further on: subtracting a day from that instant and reading it back
 * in +14 returns the day the current window opens on, so the two windows
 * overlap and the day between them is counted twice.
 */
test("calendar windows keyed by date survive a zone past UTC+12", () => {
  const calendar = createCalendarProjection("Pacific/Kiritimati");
  const end = Date.parse("2026-07-03T00:00:00.000Z");
  const endKey = calendar.dateKey(new Date(end));

  assert.equal(endKey, "2026-07-03", "the fixture instant is not the local date the guard assumes");
  assert.equal(shiftDateKey(endKey, -1), "2026-07-02");
  assert.equal(shiftDateKey("2026-03-01", -1), "2026-02-28", "key arithmetic must cross a month end");

  assert.deepEqual(
    calendar.buckets([], end, 3).map((bucket) => bucket.key),
    ["2026-07-01", "2026-07-02", "2026-07-03"],
  );
  assert.deepEqual(
    calendar.buckets([], endKey, 3).map((bucket) => bucket.key),
    ["2026-07-01", "2026-07-02", "2026-07-03"],
    "a window ending on a date key must hold that key",
  );

  const prior = calendar.buckets([], shiftDateKey(endKey, -3), 3).map((bucket) => bucket.key);
  assert.deepEqual(prior, ["2026-06-28", "2026-06-29", "2026-06-30"]);
  assert.equal(
    prior.filter((key) => key >= "2026-07-01").length,
    0,
    "the prior window overlaps the current one",
  );
});

/**
 * Guard for issue #92.
 *
 * A range chip names calendar days, and the heatmap can only draw whole ones.
 * The window a fixed range selects therefore has to open at local midnight on
 * the first of those days: a window that opened at the closing instant's own
 * clock time that many days earlier admitted the tail of a day the heatmap had
 * no cell for, so the hero total and the heatmap's "Current 30D" panel counted
 * different sets of sessions and disagreed by whatever fell in that tail.
 */
test("a fixed range opens at local midnight on the first of its calendar days", () => {
  const calendar = createCalendarProjection("America/Chicago");
  // 18:00 local, the reading in the issue: late enough in the day that six
  // hours of the thirtieth day back sat inside the rolling window.
  const end = Date.parse("2026-07-15T23:00:00.000Z");

  const window = calendar.calendarWindow(end, 30);
  assert.equal(window.lastKey, "2026-07-15");
  assert.equal(window.firstKey, "2026-06-16", "thirty calendar days ending on the 15th open on the 16th");
  assert.equal(window.end, end, "the window still closes on the instant it was given");
  assert.equal(
    window.start,
    Date.parse("2026-06-16T05:00:00.000Z"),
    "the window opens at 00:00 local on its first day, not at 18:00 local thirty days back",
  );

  const eveningBefore = Date.parse("2026-06-16T00:30:00.000Z");
  assert.equal(calendar.dateKey(eveningBefore), "2026-06-15");
  assert.ok(eveningBefore < window.start, "19:30 on the day before the window opens is outside it");

  const firstMorning = Date.parse("2026-06-16T05:30:00.000Z");
  assert.equal(calendar.dateKey(firstMorning), "2026-06-16");
  assert.ok(firstMorning >= window.start, "00:30 on the window's first day is inside it");

  assert.deepEqual(
    calendar.buckets([], window.lastKey, 30).map((bucket) => bucket.key).at(0),
    window.firstKey,
    "the heatmap's current-window keys must open on the same day the window does",
  );
});

/**
 * A day boundary is a fact of the zone, not of a fixed offset.
 *
 * The contract holds whatever the rules are: the instant a key opens on reads
 * back as that key, and the millisecond before it reads back as the day
 * before. Both directions are asserted rather than a literal offset, so the
 * guard survives a tzdata release that moves one of these transitions.
 */
test("a date key opens at the first instant that belongs to it, across every zone rule", () => {
  const cases = [
    // Ordinary days, an hour lost in spring and an hour repeated in autumn.
    ["America/Chicago", ["2026-06-16", "2026-03-08", "2026-11-01"]],
    // Half-hour and three-quarter-hour offsets, and one past UTC+12.
    ["Asia/Kolkata", ["2026-06-16"]],
    ["Pacific/Chatham", ["2026-04-05", "2026-09-27"]],
    ["Pacific/Kiritimati", ["2026-07-03"]],
    // Southern-hemisphere transitions, including zones that move at midnight.
    ["America/Santiago", ["2026-04-04", "2026-09-05", "2026-09-06", "2026-09-07"]],
    ["Australia/Lord_Howe", ["2026-04-05", "2026-10-04"]],
  ];

  for (const [zone, keys] of cases) {
    const calendar = createCalendarProjection(zone);
    for (const key of keys) {
      const start = calendar.startOfDay(key);
      assert.equal(calendar.dateKey(start), key, `${zone} ${key} does not open on its own day`);
      assert.equal(
        calendar.dateKey(start - 1),
        shiftDateKey(key, -1),
        `${zone} ${key} does not open where the previous day ends`,
      );
    }
  }
});

test("interval projection preserves whole-session primary-model attribution", () => {
  const start = Date.parse("2026-07-02T04:00:00.000Z");
  const end = Date.parse("2026-07-02T08:00:00.000Z");
  const buckets = makeIntervalBuckets(sessions.slice(0, 3), start, end, 2);

  assert.deepEqual(buckets.map(({ cost, sessions, tokens, families }) => ({ cost, sessions, tokens, families })), [
    { cost: 7, sessions: 3, tokens: 350, families: { Sonnet: 2, Sol: 3, Opus: 2 } },
    { cost: 0, sessions: 0, tokens: 0, families: {} },
  ]);
});
