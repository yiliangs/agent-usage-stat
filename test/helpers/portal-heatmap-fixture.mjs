/**
 * A ledger with three named days for the heatmap day-detail guard.
 *
 * The heatmap draws every day the ledger covers, not only the selected
 * period, so the fixture names one day inside the default 30-day window, one
 * far outside it, and one with no work at all. Every figure below is written
 * out rather than derived, so the guard compares the rendered drawer against
 * numbers this file states rather than against the aggregation it is
 * checking.
 *
 * Timestamps are relative to the moment the fixture is built, because the
 * portal windows everything against now. Sessions sit at local midday and run
 * for an hour, so the calendar day a session falls on is unambiguous in any
 * time zone.
 */

const DAY = 86_400_000;

/** Local midnight for the day `daysAgo` before `now`, in the machine's own
 *  time zone, which is the one the portal renders in. */
function localMidnight(now, daysAgo) {
  const day = new Date(now - daysAgo * DAY);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

function dateKey(value) {
  const day = new Date(value);
  return [
    day.getFullYear(),
    String(day.getMonth() + 1).padStart(2, "0"),
    String(day.getDate()).padStart(2, "0"),
  ].join("-");
}

/** The day heading the drawer prints, built from Intl directly rather than
 *  from the portal's own formatter. The heatmap anchors each day at noon UTC,
 *  which is the instant the heading is formatted from. */
function dayLabel(key) {
  return new Intl.DateTimeFormat("en-US", { day: "2-digit", month: "short", year: "numeric" })
    .format(new Date(Date.parse(`${key}T12:00:00Z`)))
    .toUpperCase();
}

/** One recorded session. The token split is fixed at 80% cache read, so every
 *  day in the fixture reads back as an 80% cache ratio whatever it holds. */
function session({ index, start, project, model, cost, tokens }) {
  return {
    slug: `${project}-${String(index).padStart(6, "0")}`,
    sid: `session-${index}`,
    project,
    machine: "WORKSTATION-01",
    provider: "claude",
    start: new Date(start).toISOString(),
    end: new Date(start + 3_600_000).toISOString(),
    durSec: 3600,
    input: tokens * 0.1,
    output: tokens * 0.06,
    cacheCreate: tokens * 0.04,
    cacheRead: tokens * 0.8,
    totalTokens: tokens,
    cost,
    models: [model],
    turns: [],
  };
}

/** The day the reader is most likely to click: inside the default window, with
 *  work spread over two projects and three model families. */
const BUSY_DAY_AGO = 5;

/** A day the reader can see on the heatmap but has not selected. The heatmap
 *  covers the last 365 days, so this cell is drawn while the 30-day window
 *  excludes it. */
const DISTANT_DAY_AGO = 200;

/** A day drawn between two busy ones with nothing recorded on it. */
const EMPTY_DAY_AGO = 4;

const BUSY_SESSIONS = [
  { project: "agent-usage-stat", model: "claude-opus-4-1", cost: 18.75, tokens: 1_400_000 },
  { project: "agent-usage-stat", model: "claude-fable-5", cost: 12.5, tokens: 900_000 },
  { project: "claude-workboard", model: "gpt-5.6-codex", cost: 10, tokens: 700_000 },
];

const DISTANT_SESSIONS = [
  { project: "paper-milp-solver", model: "claude-sonnet-4-5", cost: 6.25, tokens: 500_000 },
  { project: "paper-milp-solver", model: "claude-sonnet-4-5", cost: 3.75, tokens: 300_000 },
];

/** Quiet days on either side, so the busy day is one cell among many rather
 *  than the only mark on the field. */
const FILLER_DAYS_AGO = [1, 2, 3, 10, 20];

/** What the drawer owes the reader for each named day, stated here rather than
 *  recomputed from the portal's aggregation. */
export function heatmapExpectations(now = Date.now()) {
  const busyKey = dateKey(localMidnight(now, BUSY_DAY_AGO));
  const distantKey = dateKey(localMidnight(now, DISTANT_DAY_AGO));
  const emptyKey = dateKey(localMidnight(now, EMPTY_DAY_AGO));
  return {
    busy: {
      label: dayLabel(busyKey),
      value: "$41.25",
      sessions: "3",
      tokens: "3.00M",
      cacheRead: "80%",
      projects: [
        { label: "agent-usage-stat", value: "$31.25" },
        { label: "claude-workboard", value: "$10.00" },
      ],
      models: [
        { label: "Opus", value: "$18.75" },
        { label: "Fable", value: "$12.50" },
        { label: "Codex", value: "$10.00" },
      ],
    },
    distant: {
      label: dayLabel(distantKey),
      value: "$10.00",
      sessions: "2",
      tokens: "800.0K",
      cacheRead: "80%",
      projects: [{ label: "paper-milp-solver", value: "$10.00" }],
      models: [{ label: "Sonnet", value: "$10.00" }],
    },
    empty: { label: dayLabel(emptyKey) },
  };
}

/** `sessions.json` and `meta.json` as the desktop build writes them. */
export function buildHeatmapFixture(now = Date.now()) {
  const sessions = [];
  let index = 0;

  const at = (daysAgo) => localMidnight(now, daysAgo) + 12 * 3_600_000;

  for (const entry of BUSY_SESSIONS) {
    sessions.push(session({ index: index++, start: at(BUSY_DAY_AGO), ...entry }));
  }
  for (const entry of DISTANT_SESSIONS) {
    sessions.push(session({ index: index++, start: at(DISTANT_DAY_AGO), ...entry }));
  }
  for (const daysAgo of FILLER_DAYS_AGO) {
    sessions.push(session({
      index: index++,
      start: at(daysAgo),
      project: "natalie-stackmix",
      model: "claude-sonnet-4-5",
      cost: 5,
      tokens: 400_000,
    }));
  }

  const totalCost = sessions.reduce((total, entry) => total + entry.cost, 0);
  const meta = {
    generatedAt: new Date(now).toISOString(),
    source: "fixture",
    shardDir: "fixture/logbook.d",
    sessions: sessions.length,
    projects: new Set(sessions.map((entry) => entry.project)).size,
    machines: 1,
    totalCost: Math.round(totalCost * 100) / 100,
    parsedShards: sessions.length,
    reusedShards: 0,
    span: {
      from: new Date(now - (DISTANT_DAY_AGO + 1) * DAY).toISOString(),
      to: new Date(now).toISOString(),
    },
  };
  return { "sessions.json": sessions, "meta.json": meta };
}
