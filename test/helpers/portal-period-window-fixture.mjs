/**
 * A ledger built around the edge of the thirty-day window, for issue #92.
 *
 * The 30D range covers thirty calendar dates: the day the ledger is read on
 * and the twenty-nine before it. The day before that is outside the range on
 * every panel that draws calendar days, and the fixture puts one session there
 * -- late enough in that day that a window opening at the reading instant's own
 * clock time thirty days back would still admit it. That one session is the
 * whole guard: with a rolling start the hero total held it and the heatmap's
 * "Current 30D" panel did not, so two figures a finger's width apart on the
 * same screen reported different windows.
 *
 * Everything is placed relative to the moment the fixture is built, because the
 * portal windows everything against now. The boundary session sits a little
 * later in its day than the fixture was built, which is what puts it after a
 * rolling start and before none of the calendar one; the offset is capped
 * inside the day so the session cannot slide onto the following date.
 */

const DAY = 86_400_000;

/** Local midnight for the day `daysAgo` before `now`, in the machine's own
 *  time zone, which is the one the portal renders in. */
function localMidnight(now, daysAgo) {
  const day = new Date(now - daysAgo * DAY);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** The day the 30D window opens on: today counts as one of the thirty. */
const FIRST_DAY_AGO = 29;

/** The day outside it, which the boundary session sits on. */
const BOUNDARY_DAY_AGO = 30;

/** Days inside the window carrying an ordinary midday session. */
const INSIDE_DAYS_AGO = [FIRST_DAY_AGO, 20, 10, 5, 1];

/** What one ordinary session costs. */
const INSIDE_COST = 10;

/** The session at 00:30 on the window's first day, which the window must hold:
 *  it is the counterpart of the boundary session, six hours the other side of
 *  the midnight the window now opens on. */
const FIRST_MORNING_COST = 3;

/** The session on the day before the window opens, which no panel may count. */
export const BOUNDARY_COST = 7;

/** The window's real total: five ordinary sessions and the first morning. */
export const WINDOW_COST_TEXT = "$53.00";

/** What the hero read while its window was a rolling span, with the boundary
 *  session folded in. The heatmap read `WINDOW_COST_TEXT` beside it. */
export const ROLLING_COST_TEXT = "$60.00";

/** Tokens recorded per dollar, so the token figures track the costs. */
const TOKENS_PER_DOLLAR = 100_000;

function session({ index, start, cost }) {
  const tokens = cost * TOKENS_PER_DOLLAR;
  return {
    slug: `period-window-${String(index).padStart(6, "0")}`,
    sid: `session-${index}`,
    project: "agent-usage-stat",
    machine: "WORKSTATION-01",
    provider: "claude",
    start: new Date(start).toISOString(),
    end: new Date(start + 1_800_000).toISOString(),
    durSec: 1800,
    input: tokens * 0.1,
    output: tokens * 0.06,
    cacheCreate: tokens * 0.04,
    cacheRead: tokens * 0.8,
    totalTokens: tokens,
    cost,
    models: ["claude-opus-4-1"],
    turns: [],
  };
}

/**
 * How far into the boundary day the boundary session sits.
 *
 * It has to be later in the day than the page's own reading instant, or a
 * rolling window would not have admitted it and the guard would pass without
 * measuring anything. It also has to stay inside that day, or it lands on the
 * window's first date and belongs to both windows. An hour later satisfies
 * both, except in the last hour before local midnight, where the fixture takes
 * half of whatever is left instead.
 */
function boundaryOffset(now) {
  const intoDay = now - localMidnight(now, 0);
  return intoDay + Math.min(3_600_000, (DAY - intoDay) / 2);
}

/** `sessions.json` and `meta.json` as the desktop build writes them. */
export function buildPeriodWindowFixture(now = Date.now()) {
  const sessions = [];
  let index = 0;

  for (const daysAgo of INSIDE_DAYS_AGO) {
    sessions.push(session({ index: index++, start: localMidnight(now, daysAgo) + 12 * 3_600_000, cost: INSIDE_COST }));
  }
  sessions.push(session({
    index: index++,
    start: localMidnight(now, FIRST_DAY_AGO) + 1_800_000,
    cost: FIRST_MORNING_COST,
  }));
  sessions.push(session({
    index: index++,
    start: localMidnight(now, BOUNDARY_DAY_AGO) + boundaryOffset(now),
    cost: BOUNDARY_COST,
  }));

  const totalCost = sessions.reduce((total, entry) => total + entry.cost, 0);
  const meta = {
    generatedAt: new Date(now).toISOString(),
    source: "fixture",
    shardDir: "fixture/logbook.d",
    sessions: sessions.length,
    projects: 1,
    machines: 1,
    totalCost,
    parsedShards: sessions.length,
    reusedShards: 0,
    span: {
      from: new Date(localMidnight(now, BOUNDARY_DAY_AGO)).toISOString(),
      to: new Date(now).toISOString(),
    },
  };
  return { "sessions.json": sessions, "meta.json": meta };
}
