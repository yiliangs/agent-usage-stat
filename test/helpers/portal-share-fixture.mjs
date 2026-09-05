/**
 * A sub-dollar week for the composition share guard.
 *
 * Every share on the dashboard divides one row by the period total, so the
 * denominator is a dollar amount and nothing keeps it above one. A fresh
 * install, a quiet week, or a Haiku-only stretch all land there. This fixture
 * is the smallest set that reaches it: three sessions in the current week
 * whose costs add up to sixty cents, one model family, one machine, and one
 * project each, so a single set of expected shares covers the model ring, the
 * machine composition, and the topology footer at once.
 *
 * Token volume stays realistic. Token shares divide by an integer that is
 * either zero or at least one, so they never reach the sub-dollar case; they
 * are here as the control that must read the same before and after.
 */

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** Cost, family, machine, and project all split three ways at $0.30, $0.20,
 *  and $0.10, so every composition on the page owes the reader 50, 33, and 17
 *  percent of a sixty-cent period. */
const SPLIT = [
  { model: "claude-opus-4-1", family: "Opus", cost: 0.3, project: "atlas-scheduler", machine: "WORKSTATION-01", tokens: 900_000 },
  { model: "claude-sonnet-4-5", family: "Sonnet", cost: 0.2, project: "beacon-parser", machine: "LAPTOP-02", tokens: 600_000 },
  { model: "claude-haiku-4-5", family: "Haiku", cost: 0.1, project: "cinder-notes", machine: "TABLET-03", tokens: 300_000 },
];

/** What each composition should read once the denominator is the true total.
 *  `fmt.pct` rounds, so a third reads 33 percent and a sixth reads 17. */
export const EXPECTED_SHARES = SPLIT.map((entry) => ({
  family: entry.family,
  machine: entry.machine,
  percent: Math.round((entry.cost / 0.6) * 100),
}));

/** The period total the shares divide by, below the dollar the old guard
 *  floored the denominator at. */
export const PERIOD_COST = 0.6;

function session({ index, start, durationMinutes, entry }) {
  const cacheRead = Math.round(entry.tokens * 0.81);
  const input = Math.round(entry.tokens * 0.09);
  const output = Math.round(entry.tokens * 0.05);
  return {
    slug: `${entry.project}-${String(index).padStart(6, "0")}`,
    sid: `session-${index}`,
    project: entry.project,
    machine: entry.machine,
    provider: "claude",
    start: new Date(start).toISOString(),
    end: new Date(start + durationMinutes * 60_000).toISOString(),
    durSec: durationMinutes * 60,
    input,
    output,
    cacheCreate: entry.tokens - cacheRead - input - output,
    cacheRead,
    totalTokens: entry.tokens,
    cost: entry.cost,
    models: [entry.model],
    turns: [],
  };
}

/** `sessions.json` and `meta.json` as the desktop build writes them. */
export function buildShareFixture(now = Date.now()) {
  // Two days back keeps every session inside the selected period and out of
  // the future, whichever hour the guard runs at.
  const sessions = SPLIT.map((entry, index) =>
    session({
      index,
      start: now - 2 * DAY + index * 3 * HOUR,
      durationMinutes: 45,
      entry,
    }),
  );

  const meta = {
    generatedAt: new Date(now).toISOString(),
    source: "fixture",
    shardDir: "fixture/logbook.d",
    sessions: sessions.length,
    projects: new Set(sessions.map((entry) => entry.project)).size,
    machines: new Set(sessions.map((entry) => entry.machine)).size,
    totalCost: PERIOD_COST,
    parsedShards: sessions.length,
    reusedShards: 0,
    span: {
      from: new Date(now - 7 * DAY).toISOString(),
      to: new Date(now).toISOString(),
    },
  };
  return { "sessions.json": sessions, "meta.json": meta };
}
