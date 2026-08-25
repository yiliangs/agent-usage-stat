/**
 * A densely concurrent week for the session-timeline label guard.
 *
 * The shape is taken from what a real ledger produces rather than from a
 * worst case: an agent left running across local midnight, several long
 * sessions overlapping it through the working day, and short sessions
 * scattered around them. That is enough to merge a whole day into one
 * concurrency cluster, which is the condition under which the timeline stops
 * naming its blocks.
 *
 * Every session is long enough that the timeline commits to labelling it, so
 * any block left anonymous is a defect rather than a block the design gave up
 * on for want of height.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Projects are distinct per lane so a rendered label identifies exactly one
 *  block, and hyphenated so the guard also covers the wrapped-name path. */
const CONCURRENT_PROJECTS = [
  "rhino-worktree-launcher",
  "natalie-stackmix",
  "paper-milp-solver",
  "claude-workboard",
  "agent-usage-stat",
  "issue-468-835273",
];

const MODELS = ["claude-opus-4-1", "claude-fable-5", "gpt-5.6-codex"];

/** Local midnight for the day `daysAgo` before `now`, in the time zone the
 *  portal renders in, which is the machine's own. */
function localMidnight(now, daysAgo) {
  const day = new Date(now - daysAgo * DAY);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** How far back the dense day sits, counted in days before `now`.
 *
 *  The timeline renders the Monday-anchored week that contains today, so a day
 *  a fixed three back leaves that week entirely on Monday, Tuesday, and
 *  Wednesday, and the guard then measures an empty column instead of a dense
 *  one. Three days back whenever the week is that old, and the week's own
 *  Monday when it is not, keeps the dense day on screen every weekday without
 *  ever placing it in the future. */
function denseDaysAgo(now) {
  const daysSinceMonday = (new Date(now).getDay() + 6) % 7;
  return Math.min(3, daysSinceMonday);
}

function session({ index, start, durationMinutes, project, model }) {
  const tokens = 2_000_000 + index * 25_000;
  const cacheRead = Math.round(tokens * 0.81);
  const input = Math.round(tokens * 0.09);
  const output = Math.round(tokens * 0.05);
  return {
    slug: `${project}-${String(index).padStart(6, "0")}`,
    sid: `session-${index}`,
    project,
    machine: "WORKSTATION-01",
    provider: "claude",
    start: new Date(start).toISOString(),
    end: new Date(start + durationMinutes * MINUTE).toISOString(),
    durSec: durationMinutes * 60,
    input,
    output,
    cacheCreate: tokens - cacheRead - input - output,
    cacheRead,
    totalTokens: tokens,
    cost: 12.5 + index,
    models: [model],
    turns: [],
  };
}

/** The project name every block on the dense day should be able to show. */
export const TIMELINE_PROJECTS = CONCURRENT_PROJECTS;

/** `sessions.json` and `meta.json` as the desktop build writes them. */
export function buildTimelineFixture(now = Date.now()) {
  const sessions = [];
  let index = 0;

  // Placed inside the week the timeline draws, whichever weekday the guard
  // happens to run on, and never in the future.
  const denseOffset = denseDaysAgo(now);
  const dense = localMidnight(now, denseOffset);

  // An agent left running overnight. It occupies a lane for the whole day,
  // which is what merges the day into a single concurrency cluster.
  sessions.push(session({
    index: index++,
    start: dense - 7 * HOUR,
    durationMinutes: 21 * 60,
    project: "overnight-mission",
    model: MODELS[0],
  }));

  // Six sessions overlapping through the working day, each long enough to
  // carry a name.
  CONCURRENT_PROJECTS.forEach((project, lane) => {
    sessions.push(session({
      index: index++,
      start: dense + 9 * HOUR + lane * 12 * MINUTE,
      durationMinutes: 180,
      project,
      model: MODELS[lane % MODELS.length],
    }));
  });

  // Quieter neighbouring days keep the week from reading as one long spike and
  // give the period comparisons something finite to divide by.
  for (let daysAgo = 1; daysAgo <= 6; daysAgo += 1) {
    if (daysAgo === denseOffset) continue;
    const midnight = localMidnight(now, daysAgo);
    for (let slot = 0; slot < 2; slot += 1) {
      sessions.push(session({
        index: index++,
        start: midnight + (10 + slot * 5) * HOUR,
        durationMinutes: 120,
        project: CONCURRENT_PROJECTS[(daysAgo + slot) % CONCURRENT_PROJECTS.length],
        model: MODELS[slot % MODELS.length],
      }));
    }
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
      from: new Date(now - 7 * DAY).toISOString(),
      to: new Date(now).toISOString(),
    },
  };
  return { "sessions.json": sessions, "meta.json": meta };
}
