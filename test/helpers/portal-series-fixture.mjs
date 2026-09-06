/**
 * Two flat ledgers whose totals are impossible to misread, for issues #130
 * and #131.
 *
 * Every session costs the same dollar and carries the same thousand tokens,
 * one session per day, so any figure covering the period is the number of days
 * it actually reached. A chart that keeps only its newest buckets says so in
 * plain arithmetic: 400 days of a dollar under a 120-bucket ceiling printed
 * $120 beside a hero reading $400, and 90 days of a thousand tokens under a
 * 30-row cap drew 30 bars beside a KPI reading 90.0K.
 *
 * Timestamps are relative to the moment the fixture is built, because the
 * portal windows everything against now. Sessions sit at local midday, so the
 * calendar day each falls on is unambiguous in any time zone.
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

/** A day as the portal's own axis labels print it, built from Intl directly
 *  rather than from the portal's formatter. A calendar bucket is anchored at
 *  noon UTC, which is the instant the label is formatted from. */
export function dayLabel(key) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", day: "2-digit", month: "short" })
    .format(new Date(Date.parse(`${key}T12:00:00Z`)))
    .toUpperCase();
}

/** What one session costs and carries, everywhere in both ledgers. */
const COST = 1;
const TOKENS = 1_000;

/** The long ledger behind #130: far past every chart's bucket ceiling. */
export const LONG_LEDGER_DAYS = 400;

/** The whole of it, as the hero and the cumulative annotation must both read. */
export const LONG_LEDGER_TOTAL_TEXT = "$400.00";

/** What the cumulative chart printed while it kept only its newest 120 days. */
export const TRUNCATED_TOTAL_TEXT = "$120.00";

/** The selection behind #131: the longest fixed range the header offers. */
export const NINETY_DAY_RANGE = "90D";
export const NINETY_DAY_DAYS = 90;

/** Its token volume, as the Tokens view's own KPI prints it. */
export const NINETY_DAY_TOKENS_TEXT = "90.0K";

/** The window's first day, which the trend charts must open on. */
export function ninetyDayFirstLabel(now = Date.now()) {
  return dayLabel(dateKey(localMidnight(now, NINETY_DAY_DAYS - 1)));
}

function session({ index, start }) {
  return {
    slug: `series-${String(index).padStart(6, "0")}`,
    sid: `session-${index}`,
    project: "agent-usage-stat",
    machine: "WORKSTATION-01",
    provider: "claude",
    start: new Date(start).toISOString(),
    end: new Date(start + 1_800_000).toISOString(),
    durSec: 1800,
    input: TOKENS,
    output: 0,
    cacheCreate: 0,
    cacheRead: 0,
    totalTokens: TOKENS,
    cost: COST,
    models: ["claude-opus-4-1"],
    turns: [],
  };
}

function fixture(dayCount, now) {
  const sessions = Array.from({ length: dayCount }, (_, index) =>
    session({ index, start: localMidnight(now, dayCount - 1 - index) + 12 * 3_600_000 }),
  );
  const meta = {
    generatedAt: new Date(now).toISOString(),
    source: "fixture",
    shardDir: "fixture/logbook.d",
    sessions: sessions.length,
    projects: 1,
    machines: 1,
    totalCost: dayCount * COST,
    parsedShards: sessions.length,
    reusedShards: 0,
    span: {
      from: new Date(localMidnight(now, dayCount - 1)).toISOString(),
      to: new Date(now).toISOString(),
    },
  };
  return { "sessions.json": sessions, "meta.json": meta };
}

/** 400 days of a dollar a day, for the ALL range. */
export function buildLongLedgerFixture(now = Date.now()) {
  return fixture(LONG_LEDGER_DAYS, now);
}

/** 90 days of a dollar and a thousand tokens a day, for the 90D range. */
export function buildNinetyDayFixture(now = Date.now()) {
  return fixture(NINETY_DAY_DAYS, now);
}
