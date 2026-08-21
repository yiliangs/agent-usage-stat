import assert from "node:assert/strict";
import test from "node:test";

import { SLOT_BUDGET } from "../portal/usage-format.js";
import { buildGlance, glanceFigures } from "../portal/glance-model.js";

/**
 * The status-area panel's figures, for issue #76.
 *
 * The panel answers one question in one glance: how much has been spent and
 * consumed right now. "Right now" is two different clocks. Today is a calendar
 * day in the reader's own time zone, because that is the day they are living
 * in; the seven-day figure is a rolling window ending at this instant, because
 * a comparison against the previous seven days is only fair if both windows are
 * the same length. Mixing the two is how a panel opened at 00:30 reports a
 * near-empty week.
 *
 * Every expected total below is written out by hand rather than recomputed from
 * the fixture, so the test fails when the selection rule changes rather than
 * agreeing with whatever the code now sums.
 */

const HOUR = 3_600_000;
const DAY = 86_400_000;
// 2026-08-21T14:00 in America/Chicago, which is a summer date, so the offset
// is -05:00. The zone is fixed here so the calendar-day rule is asserted
// against a known day rather than against the machine running the test.
const NOW = Date.parse("2026-08-21T19:00:00.000Z");
const ZONE = "America/Chicago";

function session(fields) {
  return {
    slug: "0000",
    sid: fields.sid,
    project: fields.project ?? "ledger",
    branch: "",
    cwd: "",
    machine: "desk",
    start: new Date(Date.parse(fields.end) - HOUR).toISOString(),
    end: fields.end,
    durSec: 3600,
    durHuman: "1h",
    input: 0,
    output: 0,
    cacheCreate: 0,
    cacheRead: 0,
    totalTokens: fields.tokens,
    cost: fields.cost,
    models: fields.models ?? ["claude-opus-5"],
    turns: [],
    provider: fields.provider ?? "claude",
    byVendor: {},
  };
}

// One session per band the panel distinguishes, plus a second one today so the
// today figure is a sum rather than a single record read back.
const LEDGER = [
  session({ sid: "today-morning", end: "2026-08-21T13:40:00.000Z", tokens: 1_200_000, cost: 3.5, project: "agent-usage-stat" }),
  session({ sid: "today-midday", end: "2026-08-21T18:30:00.000Z", tokens: 800_000, cost: 1.25, project: "portal", models: ["gpt-5.6-sol"], provider: "codex" }),
  session({ sid: "yesterday", end: "2026-08-20T20:00:00.000Z", tokens: 500_000, cost: 0.75 }),
  session({ sid: "six-days-back", end: "2026-08-15T20:00:00.000Z", tokens: 300_000, cost: 0.5 }),
  session({ sid: "nine-days-back", end: "2026-08-12T20:00:00.000Z", tokens: 2_000_000, cost: 4 }),
  session({ sid: "long-past", end: "2026-08-01T20:00:00.000Z", tokens: 9_999, cost: 9.99 }),
];

test("the glance separates the reader's calendar day from the rolling week", () => {
  const glance = buildGlance(LEDGER, {
    now: NOW,
    timeZone: ZONE,
    generatedAt: "2026-08-21T18:59:00.000Z",
  });

  // 13:40Z and 18:30Z are 08:40 and 13:30 in Chicago: the same local day.
  assert.deepEqual(glance.today, {
    sessions: 2,
    tokens: 2_000_000,
    cost: 4.75,
  });
  // Everything from 2026-08-14T19:00Z onward: both of today's, yesterday's,
  // and the one six days back. The nine-day-old session is outside it.
  assert.deepEqual(glance.week, {
    sessions: 4,
    tokens: 2_800_000,
    cost: 6,
  });
  // The seven days before that window, which holds only the nine-day-old one.
  assert.deepEqual(glance.priorWeek, {
    sessions: 1,
    tokens: 2_000_000,
    cost: 4,
  });
  assert.equal(glance.ledger.sessions, 6);
  assert.equal(glance.ledger.updatedAt, "2026-08-21T18:59:00.000Z");
});

test("the two windows are adjacent, so no session is counted in both", () => {
  const edge = [
    session({ sid: "on-the-seam", end: new Date(NOW - 7 * DAY).toISOString(), tokens: 10, cost: 1 }),
  ];
  const glance = buildGlance(edge, { now: NOW, timeZone: ZONE });

  assert.equal(glance.week.sessions + glance.priorWeek.sessions, 1);
  assert.deepEqual(glance.week, { sessions: 1, tokens: 10, cost: 1 });
  assert.deepEqual(glance.priorWeek, { sessions: 0, tokens: 0, cost: 0 });
});

test("the latest session is named by the work it belongs to, not by its id", () => {
  const glance = buildGlance(LEDGER, { now: NOW, timeZone: ZONE });

  assert.deepEqual(glance.latest, {
    project: "portal",
    provider: "codex",
    family: "Sol",
    model: "gpt-5.6-sol",
    tokens: 800_000,
    cost: 1.25,
    at: "2026-08-21T18:30:00.000Z",
  });
});

test("an empty ledger reports zeros rather than a broken panel", () => {
  const glance = buildGlance([], { now: NOW, timeZone: ZONE });

  assert.deepEqual(glance.today, { sessions: 0, tokens: 0, cost: 0 });
  assert.deepEqual(glance.week, { sessions: 0, tokens: 0, cost: 0 });
  assert.deepEqual(glance.priorWeek, { sessions: 0, tokens: 0, cost: 0 });
  assert.equal(glance.latest, null);
  assert.equal(glance.ledger.sessions, 0);
});

test("a session still running counts on the day it started", () => {
  // A capture checkpoint writes no end time until the session closes. The
  // portal's normalization falls back to the start, and the glance has to read
  // the same fact, or an open session is missing from today's figure entirely.
  const open = [{
    ...session({ sid: "open", end: "2026-08-21T17:00:00.000Z", tokens: 40, cost: 2 }),
    end: null,
  }];
  const glance = buildGlance(open, { now: NOW, timeZone: ZONE });

  assert.deepEqual(glance.today, { sessions: 1, tokens: 40, cost: 2 });
  assert.equal(glance.latest.at, "2026-08-21T16:00:00.000Z");
});

test("the panel prints the figures a reader can take in at a glance", () => {
  const figures = glanceFigures(
    buildGlance(LEDGER, {
      now: NOW,
      timeZone: ZONE,
      generatedAt: "2026-08-21T18:59:00.000Z",
    }),
    { now: NOW, timeZone: ZONE },
  );

  assert.deepEqual(figures.today, {
    tokens: "2.00M",
    cost: "$4.75",
    note: "2 sessions",
  });
  assert.deepEqual(figures.week, {
    tokens: "2.80M",
    cost: "$6.00",
    note: "+50% vs prior",
  });
  assert.deepEqual(figures.latest, {
    project: "portal",
    detail: "Sol · 800.0K · $1.25",
    when: "13:30",
  });
  assert.equal(figures.updated, "13:59");
});

test("a single session is counted in the singular", () => {
  const figures = glanceFigures(
    buildGlance([LEDGER[0]], { now: NOW, timeZone: ZONE }),
    { now: NOW, timeZone: ZONE },
  );

  assert.equal(figures.today.note, "1 session");
});

test("an empty ledger reads as empty rather than as zero dollars spent", () => {
  const figures = glanceFigures(
    buildGlance([], { now: NOW, timeZone: ZONE }),
    { now: NOW, timeZone: ZONE },
  );

  assert.deepEqual(figures.today, { tokens: "0", cost: "$0.00", note: "No sessions" });
  assert.equal(figures.week.note, "No prior baseline");
  assert.deepEqual(figures.latest, null);
  assert.equal(figures.updated, "never");
});

test("a session from another day is stamped with its date, not a bare clock", () => {
  const figures = glanceFigures(
    buildGlance([LEDGER[3]], { now: NOW, timeZone: ZONE }),
    { now: NOW, timeZone: ZONE },
  );

  // 2026-08-15T20:00Z is 15:00 in Chicago. A clock alone would read as today.
  assert.equal(figures.latest.when, "Aug 15");
});

test("every panel string stays inside the slot the panel reserves for it", () => {
  // The panel is 320px wide and sized once, so a figure that outgrows its slot
  // wraps onto the row below it (issue #26). The widest string each slot can
  // ever hold is bounded by the formatters behind it, and the bound is
  // declared in SLOT_BUDGET beside the dashboard's own slots.
  const worst = glanceFigures(
    buildGlance(
      [
        session({ sid: "vast", end: "2026-08-21T18:30:00.000Z", tokens: 9.9e14, cost: 9.9e14, project: "a-very-long-project-name-that-never-ends", models: ["claude-sonnet-5"] }),
        session({ sid: "tiny-prior", end: "2026-08-12T20:00:00.000Z", tokens: 1, cost: 0.01 }),
      ],
      { now: NOW, timeZone: ZONE },
    ),
    { now: NOW, timeZone: ZONE },
  );

  for (const band of [worst.today, worst.week]) {
    assert.ok(band.tokens.length <= SLOT_BUDGET.glanceValue, `tokens ${JSON.stringify(band.tokens)}`);
    assert.ok(band.cost.length <= SLOT_BUDGET.glanceValue, `cost ${JSON.stringify(band.cost)}`);
    assert.ok(band.note.length <= SLOT_BUDGET.glanceNote, `note ${JSON.stringify(band.note)}`);
  }
  assert.ok(
    worst.latest.detail.length <= SLOT_BUDGET.glanceDetail,
    `latest detail ${JSON.stringify(worst.latest.detail)} is ${worst.latest.detail.length} characters`,
  );
});
