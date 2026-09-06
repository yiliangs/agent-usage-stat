/**
 * A single overnight session, for issue #93.
 *
 * The session runs from 23:00 on one date to 01:00 on the next, so the
 * timeline draws it on both and the data table has a row for each. It is the
 * only session in the ledger, which makes the token column trivially checkable:
 * whatever the two rows hold has to add up to the one session's thousand
 * tokens, and the reading that put a thousand on each is exactly twice that.
 *
 * It sits on the Tuesday and Wednesday of the week the fixture is built in, so
 * both dates are in the week the timeline opens on whatever weekday the guard
 * runs. When that Wednesday is still ahead, the portal's window closes on the
 * session itself, which is the same week either way.
 */

const DAY = 86_400_000;

/** Local midnight today, in the machine's own time zone, which is the one the
 *  portal renders in. */
function localMidnight(now) {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** Monday-first weekday of `now`. */
function weekday(now) {
  return (new Date(now).getDay() + 6) % 7;
}

/** The session's whole volume, which one date must hold and the other must not. */
export const OVERNIGHT_TOKENS = 1_000;

/** How the two dates read once each holds only what landed on it. */
export const FIRST_DATE_TOKENS_TEXT = "0";
export const SECOND_DATE_TOKENS_TEXT = "1.0K";

/** What both dates read while each carried the whole session. */
export const DOUBLE_COUNTED_TOKENS_TEXT = "1.0K";

/** One session is active on both dates, because it was running on both. */
export const ACTIVE_SESSIONS_TEXT = "1";

/** The two date labels the table prints, formatted as the table formats them:
 *  the date key is anchored at noon UTC and read back in UTC. */
function rowLabel(key) {
  return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })
    .format(new Date(Date.parse(`${key}T12:00:00Z`)));
}

function dateKey(value) {
  const day = new Date(value);
  return [
    day.getFullYear(),
    String(day.getMonth() + 1).padStart(2, "0"),
    String(day.getDate()).padStart(2, "0"),
  ].join("-");
}

/** Local midnight on the Tuesday of the week holding `now`. */
function tuesdayMidnight(now) {
  return localMidnight(now) - (weekday(now) - 1) * DAY;
}

/** The two rows the guard reads, oldest first. */
export function overnightRowLabels(now = Date.now()) {
  const tuesday = tuesdayMidnight(now);
  return [rowLabel(dateKey(tuesday)), rowLabel(dateKey(tuesday + DAY))];
}

/** `sessions.json` and `meta.json` as the desktop build writes them. */
export function buildOvernightFixture(now = Date.now()) {
  const start = tuesdayMidnight(now) + 23 * 3_600_000;
  const end = start + 2 * 3_600_000;
  const sessions = [
    {
      slug: "overnight-000000",
      sid: "session-overnight",
      project: "agent-usage-stat",
      machine: "WORKSTATION-01",
      provider: "claude",
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      durSec: 7200,
      input: 600,
      output: 400,
      cacheCreate: 0,
      cacheRead: 0,
      totalTokens: OVERNIGHT_TOKENS,
      cost: 4,
      models: ["claude-opus-4-1"],
      turns: [],
    },
  ];
  const meta = {
    generatedAt: new Date(now).toISOString(),
    source: "fixture",
    shardDir: "fixture/logbook.d",
    sessions: 1,
    projects: 1,
    machines: 1,
    totalCost: 4,
    parsedShards: 1,
    reusedShards: 0,
    span: { from: new Date(start).toISOString(), to: new Date(end).toISOString() },
  };
  return { "sessions.json": sessions, "meta.json": meta };
}
