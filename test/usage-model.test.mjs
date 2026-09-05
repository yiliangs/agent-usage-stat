import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createCalendarProjection,
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

test("interval projection preserves whole-session primary-model attribution", () => {
  const start = Date.parse("2026-07-02T04:00:00.000Z");
  const end = Date.parse("2026-07-02T08:00:00.000Z");
  const buckets = makeIntervalBuckets(sessions.slice(0, 3), start, end, 2);

  assert.deepEqual(buckets.map(({ cost, sessions, tokens, families }) => ({ cost, sessions, tokens, families })), [
    { cost: 7, sessions: 3, tokens: 350, families: { Sonnet: 2, Sol: 3, Opus: 2 } },
    { cost: 0, sessions: 0, tokens: 0, families: {} },
  ]);
});
