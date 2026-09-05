/**
 * A ten-day ledger for the ALL-range prior-period guard.
 *
 * One session a day, each a different cost, so the oldest one is identifiable
 * in whatever the comparison line reports: the ALL window starts exactly on
 * that session's timestamp, and a window filter that admits it at both ends
 * counts it once in the period and once in the period before, which is the
 * whole ledger measured against its own first day.
 *
 * The ledger reaches back ten days, well inside the default thirty-day window,
 * so the same fixture selected at 30D has nothing before it either. That is
 * the control: both ranges owe the reader the same answer, and only ALL got it
 * wrong.
 *
 * Timestamps are relative to the moment the fixture is built, because the
 * portal windows everything against now. Sessions sit at local midday and run
 * for an hour, so the calendar day a session falls on is unambiguous in any
 * time zone.
 */

const DAY = 86_400_000;

/** What each day of the ledger cost, oldest first. The dollar figures are
 *  written out rather than derived, so the guard compares the rendered page
 *  against numbers this file states. */
const COSTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/** Tokens recorded per dollar spent, which fixes the token totals to the same
 *  shape as the costs and makes the tokens comparison the spend one again. */
const TOKENS_PER_DOLLAR = 100_000;

/** The oldest session's cost, which is what a prior period built from it alone
 *  compares the whole ledger against. */
export const OLDEST_COST = COSTS[0];

/** Every session's cost summed: 1 + 2 + ... + 10. This is the hero figure on
 *  both ALL and 30D, since the ledger fits inside either window. */
export const TOTAL_COST = 55;

/** The hero figure as the portal prints it. */
export const TOTAL_COST_TEXT = "$55.00";

/** What every comparison against a period that does not exist reads. */
export const NO_PRIOR_TEXT = "No prior baseline";

/** What the hero delta read before the fix: the ledger's $55 against the $1 of
 *  its own oldest session, which the prior window had borrowed from it. */
export const OVERLAP_DELTA_TEXT = `×${TOTAL_COST / OLDEST_COST} vs prior`;

/** Local midnight for the day `daysAgo` before `now`, in the machine's own
 *  time zone, which is the one the portal renders in. */
function localMidnight(now, daysAgo) {
  const day = new Date(now - daysAgo * DAY);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** One recorded session. The token split is fixed at 80% cache read, so the
 *  cache figures say nothing about which day a session landed on. */
function session({ index, start, cost }) {
  const tokens = cost * TOKENS_PER_DOLLAR;
  return {
    slug: `prior-period-${String(index).padStart(6, "0")}`,
    sid: `session-${index}`,
    project: "agent-usage-stat",
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
    models: ["claude-opus-4-1"],
    turns: [],
  };
}

/** `sessions.json` and `meta.json` as the desktop build writes them. */
export function buildPriorPeriodFixture(now = Date.now()) {
  const sessions = COSTS.map((cost, index) =>
    session({
      index,
      start: localMidnight(now, COSTS.length - 1 - index) + 12 * 3_600_000,
      cost,
    }),
  );
  const meta = {
    generatedAt: new Date(now).toISOString(),
    source: "fixture",
    shardDir: "fixture/logbook.d",
    sessions: sessions.length,
    projects: 1,
    machines: 1,
    totalCost: TOTAL_COST,
    parsedShards: sessions.length,
    reusedShards: 0,
    span: {
      from: new Date(now - COSTS.length * DAY).toISOString(),
      to: new Date(now).toISOString(),
    },
  };
  return { "sessions.json": sessions, "meta.json": meta };
}
