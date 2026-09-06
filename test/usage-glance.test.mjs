import assert from "node:assert/strict";
import test from "node:test";

import { SLOT_BUDGET } from "../portal/usage-format.js";
import { buildGlance, glanceFigures } from "../portal/glance-model.js";

/**
 * The status-area panel's figures, for issue #76.
 *
 * The panel answers where today stands, when the work happened, and what it
 * went on. "Today" is a calendar day in the reader's own time zone, because
 * that is the day they are living in. The traffic bars are the last day by the
 * hour, the heatmap is the last twelve calendar days-of-week, and everything
 * summarised is a rolling seven days, because a split scoped to today is one
 * slice at nine in the morning and says nothing.
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
  const input = fields.input ?? 0;
  const output = fields.output ?? 0;
  const cacheCreate = fields.cacheCreate ?? 0;
  const cacheRead = fields.cacheRead ?? 0;
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
    input,
    output,
    cacheCreate,
    cacheRead,
    totalTokens: input + output + cacheCreate + cacheRead,
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
  session({ sid: "today-morning", end: "2026-08-21T13:40:00.000Z", cost: 3.5, project: "agent-usage-stat", input: 20_000, output: 80_000, cacheCreate: 100_000, cacheRead: 1_000_000 }),
  session({ sid: "today-midday", end: "2026-08-21T18:30:00.000Z", cost: 1.25, project: "portal", models: ["gpt-5.6-sol"], provider: "codex", input: 50_000, output: 150_000, cacheCreate: 100_000, cacheRead: 500_000 }),
  session({ sid: "yesterday", end: "2026-08-20T20:00:00.000Z", cost: 0.75, input: 10_000, output: 40_000, cacheCreate: 50_000, cacheRead: 400_000 }),
  session({ sid: "six-days-back", end: "2026-08-15T20:00:00.000Z", cost: 0.5, input: 5_000, output: 25_000, cacheCreate: 20_000, cacheRead: 250_000 }),
  session({ sid: "nine-days-back", end: "2026-08-12T20:00:00.000Z", cost: 4, input: 100_000, output: 400_000, cacheCreate: 500_000, cacheRead: 1_000_000 }),
  session({ sid: "long-past", end: "2026-08-01T20:00:00.000Z", cost: 9.99, input: 9_999 }),
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
    session({ sid: "on-the-seam", end: new Date(NOW - 7 * DAY).toISOString(), input: 10, cost: 1 }),
  ];
  const glance = buildGlance(edge, { now: NOW, timeZone: ZONE });

  assert.equal(glance.week.sessions + glance.priorWeek.sessions, 1);
  assert.deepEqual(glance.week, { sessions: 1, tokens: 10, cost: 1 });
  assert.deepEqual(glance.priorWeek, { sessions: 0, tokens: 0, cost: 0 });
});

test("the traffic bars cover the last twenty-four whole hours", () => {
  const { traffic } = buildGlance(LEDGER, { now: NOW, timeZone: ZONE });

  // NOW is 19:00Z, so the window runs to the end of that hour and back a day:
  // 2026-08-20T20:00Z through 2026-08-21T20:00Z.
  assert.equal(traffic.hours.length, 24);
  assert.equal(traffic.from, "2026-08-20T20:00:00.000Z");
  assert.equal(traffic.to, "2026-08-21T20:00:00.000Z");
  assert.equal(traffic.hours[0].at, "2026-08-20T20:00:00.000Z");
  assert.equal(traffic.hours[23].at, "2026-08-21T19:00:00.000Z");

  // Three sessions land in it: yesterday's on the opening hour, and today's
  // two at 13:40Z and 18:30Z. The rest of the ledger is outside the window and
  // must not be dragged into the first bar.
  const busy = traffic.hours
    .map((hour, index) => ({ index, tokens: hour.tokens }))
    .filter((hour) => hour.tokens > 0);
  assert.deepEqual(busy, [
    { index: 0, tokens: 500_000 },
    { index: 17, tokens: 1_200_000 },
    { index: 22, tokens: 800_000 },
  ]);
  assert.equal(traffic.peak, 1_200_000);
  assert.deepEqual(
    busy.map((hour) => traffic.hours[hour.index].height),
    [500_000 / 1_200_000, 1, 800_000 / 1_200_000],
  );
});

test("an hour with nothing in it is a bar of zero, not a missing bar", () => {
  const { traffic } = buildGlance([], { now: NOW, timeZone: ZONE });

  assert.equal(traffic.hours.length, 24);
  assert.equal(traffic.peak, 0);
  assert.deepEqual([...new Set(traffic.hours.map((hour) => hour.height))], [0]);
});

test("the heatmap covers half a year and steps each day against the busiest", () => {
  const { activity } = buildGlance(LEDGER, { now: NOW, timeZone: ZONE });

  assert.equal(activity.days.length, 182);
  assert.equal(activity.days[181].key, "2026-08-21");
  assert.equal(activity.days[0].key, "2026-02-21");
  assert.equal(activity.activeDays, 5);
  assert.equal(activity.peak, 2_000_000);
  // 2026-02-21 is a Saturday, so five cells stand empty ahead of it and every
  // row of the strip stays one weekday.
  assert.equal(activity.leadingDays, 5);

  // A square-root step, so a day at a two-hundredth of the peak still reads as
  // activity rather than as an empty cell.
  const levels = Object.fromEntries(
    activity.days.filter((day) => day.tokens > 0).map((day) => [day.key, day.level]),
  );
  assert.deepEqual(levels, {
    "2026-08-01": 1,
    "2026-08-12": 4,
    "2026-08-15": 2,
    "2026-08-20": 2,
    "2026-08-21": 4,
  });
  assert.deepEqual(
    [...new Set(activity.days.filter((day) => day.tokens === 0).map((day) => day.level))],
    [0],
  );
});

test("the week's tokens are split by model family, not by the tool that ran it", () => {
  const { models } = buildGlance(LEDGER, { now: NOW, timeZone: ZONE });

  // Opus across three sessions, and the one Codex session routed to a Sol
  // model. The host tool is a separate axis and does not appear here.
  assert.deepEqual(
    models.map(({ family, tokens, share }) => ({ family, tokens, share })),
    [
      { family: "Opus", tokens: 2_000_000, share: 2_000_000 / 2_800_000 },
      { family: "Sol", tokens: 800_000, share: 800_000 / 2_800_000 },
    ],
  );
  assert.equal(models[0].series.variable, "--model-opus");
  assert.equal(models[1].series.variable, "--model-sol");
});

test("past three families the rest become one slice rather than a ring of slivers", () => {
  const many = ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5", "claude-fable-5", "gpt-5.6-sol"]
    .map((model, index) => session({
      sid: "model-" + index,
      end: "2026-08-21T13:00:00.000Z",
      cost: 1,
      models: [model],
      input: (5 - index) * 1_000,
    }));
  const { models } = buildGlance(many, { now: NOW, timeZone: ZONE });

  assert.deepEqual(models.map((slice) => slice.family), ["Opus", "Sonnet", "Haiku", "Other"]);
  assert.equal(models[3].tokens, 2_000 + 1_000);
  assert.equal(models[3].series.variable, "--muted");
});

test("an unrecognised model folds into the same Other slice, not a second one", () => {
  // usage-model.js already calls a model it does not know Other, so a ring
  // with two slices under that name is the failure this guards against.
  const mixed = [
    session({ sid: "opus", end: "2026-08-21T13:00:00.000Z", cost: 1, models: ["claude-opus-5"], input: 9_000 }),
    session({ sid: "unknown", end: "2026-08-21T13:00:00.000Z", cost: 1, models: ["some-new-model"], input: 4_000 }),
    session({ sid: "sonnet", end: "2026-08-21T13:00:00.000Z", cost: 1, models: ["claude-sonnet-5"], input: 3_000 }),
    session({ sid: "haiku", end: "2026-08-21T13:00:00.000Z", cost: 1, models: ["claude-haiku-4-5"], input: 2_000 }),
    session({ sid: "fable", end: "2026-08-21T13:00:00.000Z", cost: 1, models: ["claude-fable-5"], input: 1_000 }),
  ];
  const { models } = buildGlance(mixed, { now: NOW, timeZone: ZONE });

  assert.deepEqual(
    models.map(({ family, tokens }) => ({ family, tokens })),
    [
      { family: "Opus", tokens: 9_000 },
      // The unrecognised model, plus Haiku and Fable folded in behind it.
      { family: "Other", tokens: 4_000 + 2_000 + 1_000 },
      { family: "Sonnet", tokens: 3_000 },
    ],
  );
});

test("a family too small to round to a percent still says it ran", () => {
  const lopsided = [
    session({ sid: "huge", end: "2026-08-21T13:00:00.000Z", cost: 1, models: ["claude-opus-5"], input: 10_000_000 }),
    session({ sid: "sliver", end: "2026-08-21T13:00:00.000Z", cost: 1, models: ["claude-haiku-4-5"], input: 1_000 }),
  ];
  const figures = glanceFigures(
    buildGlance(lopsided, { now: NOW, timeZone: ZONE }),
    { now: NOW, timeZone: ZONE },
  );

  assert.deepEqual(
    figures.models.map(({ family, percent }) => ({ family, percent })),
    [{ family: "Opus", percent: "100%" }, { family: "Haiku", percent: "<1%" }],
  );
});

test("the week names the project most of its tokens went to", () => {
  const glance = buildGlance(LEDGER, { now: NOW, timeZone: ZONE });

  assert.deepEqual(glance.project, {
    project: "agent-usage-stat",
    tokens: 1_200_000,
    projects: 3,
  });
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
  assert.deepEqual(glance.models, []);
  assert.equal(glance.project, null);
  assert.equal(glance.activity.activeDays, 0);
  assert.equal(glance.latest, null);
  assert.equal(glance.ledger.sessions, 0);
});

test("a session still running counts on the day it started", () => {
  // A capture checkpoint writes no end time until the session closes. The
  // portal's normalization falls back to the start, and the glance has to read
  // the same fact, or an open session is missing from today's figure entirely.
  const open = [{
    ...session({ sid: "open", end: "2026-08-21T17:00:00.000Z", input: 40, cost: 2 }),
    end: null,
  }];
  const glance = buildGlance(open, { now: NOW, timeZone: ZONE });

  assert.deepEqual(glance.today, { sessions: 1, tokens: 40, cost: 2 });
  assert.equal(glance.latest.at, "2026-08-21T16:00:00.000Z");
});

test("the panel prints figures at the resolution each one is read at", () => {
  const figures = glanceFigures(
    buildGlance(LEDGER, {
      now: NOW,
      timeZone: ZONE,
      generatedAt: "2026-08-21T18:59:00.000Z",
    }),
    { now: NOW, timeZone: ZONE },
  );

  // The headline is the figure the panel exists to show, so it is printed in
  // full. A compacted "2.00M" is a rounding of the number, not the number.
  // Two figures share a row half the panel wide, so they compact; the
  // dashboard is where the count is read in full.
  assert.deepEqual(figures.today, {
    tokens: "2.00M",
    cost: "$4.75",
    note: "2 sessions",
    delta: "+50% vs prior",
  });
  assert.deepEqual(figures.week, { meta: "2.80M · $6.00" });
  assert.equal(figures.traffic.peak, "peak 1.20M");
  assert.equal(figures.traffic.hours.length, 24);
  // The window opens at 20:00Z, which is 15:00 in Chicago, and every sixth
  // hour is named after it until the bar still being filled.
  assert.deepEqual(figures.traffic.axis, ["15:00", "21:00", "03:00", "09:00", "now"]);
  assert.equal(figures.activity.note, "5 of 182 days");
  assert.equal(figures.activity.levels.length, 182);
  assert.equal(figures.activity.leadingDays, 5);
  assert.deepEqual(
    figures.models.map(({ family, percent }) => ({ family, percent })),
    [{ family: "Opus", percent: "71%" }, { family: "Sol", percent: "29%" }],
  );
  assert.deepEqual(figures.project, { name: "agent-usage-stat", note: "of 3" });
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

  assert.deepEqual(figures.today, {
    tokens: "0",
    cost: "$0.00",
    note: "No sessions",
    delta: "No prior baseline",
  });
  assert.equal(figures.week.meta, "0 · $0.00");
  assert.deepEqual(figures.models, []);
  assert.equal(figures.traffic.peak, "no traffic");
  assert.deepEqual(figures.project, { name: "No projects", note: "nothing recorded" });
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
  // The panel is one fixed size, so a figure that outgrows its slot wraps onto
  // the row below it (issue #26). The widest string each slot can hold is
  // bounded by the formatters behind it, and the bound is declared in
  // SLOT_BUDGET beside the dashboard's own slots.
  const worst = glanceFigures(
    buildGlance(
      [
        session({ sid: "vast", end: "2026-08-21T18:30:00.000Z", cost: 9.9e14, project: "a-very-long-project-name-that-never-ends", models: ["claude-sonnet-5"], input: 9.9e14, output: 9.9e14, cacheCreate: 9.9e14, cacheRead: 9.9e14 }),
        session({ sid: "tiny-prior", end: "2026-08-12T20:00:00.000Z", input: 1, cost: 0.01 }),
      ],
      { now: NOW, timeZone: ZONE },
    ),
    { now: NOW, timeZone: ZONE },
  );

  assert.ok(worst.today.tokens.length <= SLOT_BUDGET.glanceHero, `hero ${JSON.stringify(worst.today.tokens)}`);
  assert.ok(worst.today.cost.length <= SLOT_BUDGET.glanceHero, `hero cost ${JSON.stringify(worst.today.cost)}`);
  assert.ok(worst.today.note.length <= SLOT_BUDGET.glanceNote, `sessions ${JSON.stringify(worst.today.note)}`);
  assert.ok(worst.today.delta.length <= SLOT_BUDGET.glanceNote, `delta ${JSON.stringify(worst.today.delta)}`);
  assert.ok(worst.week.meta.length <= SLOT_BUDGET.glanceMeta, `meta ${JSON.stringify(worst.week.meta)}`);
  assert.ok(worst.traffic.peak.length <= SLOT_BUDGET.glanceMeta, `peak ${JSON.stringify(worst.traffic.peak)}`);
  assert.ok(worst.activity.note.length <= SLOT_BUDGET.glanceMeta, `activity ${JSON.stringify(worst.activity.note)}`);
  for (const slice of worst.models) {
    assert.ok(slice.percent.length <= SLOT_BUDGET.glanceShare, `share ${JSON.stringify(slice.percent)}`);
  }
  assert.ok(
    worst.latest.detail.length <= SLOT_BUDGET.glanceDetail,
    `latest detail ${JSON.stringify(worst.latest.detail)} is ${worst.latest.detail.length} characters`,
  );
});

test("a session that routed to two models gives each family its own tokens", () => {
  // The panel and the dashboard read the same shares, so a mixed session
  // cannot be one family here and two on the dashboard beside it (#89).
  const mixed = [{
    ...session({ sid: "mixed", end: "2026-08-21T13:00:00.000Z", cost: 10, input: 1_000 }),
    models: ["claude-sonnet-5", "gpt-5"],
    byModel: {
      "claude-sonnet-5": { cost: 3, tokens: 300 },
      "gpt-5": { cost: 7, tokens: 700 },
    },
  }];

  const { models } = buildGlance(mixed, { now: NOW, timeZone: ZONE });

  assert.deepEqual(
    models.map(({ family, tokens, share }) => ({ family, tokens, share })),
    [
      { family: "GPT", tokens: 700, share: 0.7 },
      { family: "Sonnet", tokens: 300, share: 0.3 },
    ],
  );
  assert.equal(models[0].series.variable, "--model-luna", "GPT draws in the series timeline-colors.js gives it");
});
