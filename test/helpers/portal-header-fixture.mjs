/**
 * A two-machine, ten-project week for the header and topology guards.
 *
 * The header prints one machine name and the topology table prints seven
 * project rows over a footer that totals every project, so both defects need a
 * ledger that is plural where the page assumes it is singular. One fixture
 * reaches both: ten projects at ten dollars down to one, split across two
 * machines, all inside the period the portal opens on.
 *
 * The costs are whole dollars in descending order so the arithmetic a reader
 * would do by hand is the arithmetic the guard does: six visible rows carry
 * forty-five dollars, the folded remainder carries ten, and the footer reads
 * fifty-five.
 */

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** How many projects the topology table draws before it folds the rest. */
export const TOPOLOGY_LIMIT = 7;

/** Ten projects at $10 down to $1. Two machines, alternating, so the header
 *  has a plural to report; one model family per project so the topology grid
 *  stays readable while the Value column carries the whole cost. */
export const PROJECTS = Array.from({ length: 10 }, (_, index) => ({
  project: `project-${String(index + 1).padStart(2, "0")}`,
  cost: 10 - index,
  machine: index % 2 === 0 ? "WORKSTATION-01" : "LAPTOP-02",
  model: index % 3 === 0 ? "claude-opus-4-1" : "claude-sonnet-4-5",
  tokens: 1_000_000 - index * 50_000,
}));

/** The machines the fixture writes from, in the order the header groups them:
 *  by session count, and both carry five. */
export const MACHINES = ["WORKSTATION-01", "LAPTOP-02"];

/** What the Value column and its footer owe the reader once the table stops
 *  hiding rows: six named projects, one folded remainder, one total. */
export const EXPECTED_VALUES = {
  kept: PROJECTS.slice(0, TOPOLOGY_LIMIT - 1).map((entry) => entry.cost),
  folded: PROJECTS.slice(TOPOLOGY_LIMIT - 1).reduce((total, entry) => total + entry.cost, 0),
  total: PROJECTS.reduce((total, entry) => total + entry.cost, 0),
  foldedProjects: PROJECTS.length - (TOPOLOGY_LIMIT - 1),
};

function session({ index, start, entry }) {
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
    end: new Date(start + 45 * 60_000).toISOString(),
    durSec: 45 * 60,
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
export function buildHeaderFixture(now = Date.now()) {
  // Two days back keeps every session inside the selected period and out of
  // the future, whichever hour the guard runs at.
  const sessions = PROJECTS.map((entry, index) =>
    session({ index, start: now - 2 * DAY + index * HOUR, entry }),
  );

  const meta = {
    generatedAt: new Date(now).toISOString(),
    source: "fixture",
    shardDir: "fixture/logbook.d",
    sessions: sessions.length,
    projects: PROJECTS.length,
    machines: MACHINES.length,
    totalCost: EXPECTED_VALUES.total,
    parsedShards: sessions.length,
    reusedShards: 0,
    span: {
      from: new Date(now - 7 * DAY).toISOString(),
      to: new Date(now).toISOString(),
    },
  };
  return { "sessions.json": sessions, "meta.json": meta };
}
