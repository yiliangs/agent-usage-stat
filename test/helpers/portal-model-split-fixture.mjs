/**
 * One session that routed to two model families, for the rendered model guards.
 *
 * A Claude Code session can route to a GPT model mid-run, and the shard records
 * what each model cost. The defect (#89) is downstream of that: the page charged
 * the whole session to the first model named, so a ring drawn from a two-family
 * session showed one family at a hundred percent. One session is the smallest
 * ledger that reaches it, and the smallest one whose arithmetic a reader can do
 * by hand: seven of ten dollars on GPT, three on Sonnet.
 *
 * Sonnet is named first and is the cheaper of the two, so a page still reading
 * `models[0]` names the wrong family as well as the wrong amount.
 */

const DAY = 86_400_000;

/** What each model of the session earned, in the order the shard lists them. */
export const SPLIT = [
  { model: "claude-sonnet-5", family: "Sonnet", cost: 3, tokens: 300_000 },
  { model: "gpt-5", family: "GPT", cost: 7, tokens: 700_000 },
];

export const PROJECT = "split-runner";
export const MACHINE = "WORKSTATION-01";
export const PERIOD_COST = SPLIT.reduce((total, entry) => total + entry.cost, 0);
export const PERIOD_TOKENS = SPLIT.reduce((total, entry) => total + entry.tokens, 0);

/** The families the page owes the reader, costliest first, with the share each
 *  one holds of the period. `fmt.pct` rounds, so these are whole percents. */
export const EXPECTED_FAMILIES = SPLIT.slice()
  .sort((left, right) => right.cost - left.cost)
  .map((entry) => ({
    family: entry.family,
    cost: entry.cost,
    percent: Math.round((entry.cost / PERIOD_COST) * 100),
  }));

/** `sessions.json` and `meta.json` as the desktop build writes them, with the
 *  per-model split the snapshot now carries. */
export function buildModelSplitFixture(now = Date.now()) {
  // Two days back keeps the session inside the period the portal opens on and
  // out of the future, whichever hour the guard runs at.
  const start = now - 2 * DAY;
  const cacheRead = Math.round(PERIOD_TOKENS * 0.81);
  const input = Math.round(PERIOD_TOKENS * 0.09);
  const output = Math.round(PERIOD_TOKENS * 0.05);
  const sessions = [{
    slug: "split-000001",
    sid: "split-session",
    project: PROJECT,
    branch: "main",
    cwd: "",
    machine: MACHINE,
    provider: "claude",
    start: new Date(start).toISOString(),
    end: new Date(start + 45 * 60_000).toISOString(),
    durSec: 45 * 60,
    durHuman: "45m",
    input,
    output,
    cacheCreate: PERIOD_TOKENS - cacheRead - input - output,
    cacheRead,
    totalTokens: PERIOD_TOKENS,
    cost: PERIOD_COST,
    models: SPLIT.map((entry) => entry.model),
    turns: [],
    byVendor: {
      anthropic: { cost: SPLIT[0].cost, tokens: SPLIT[0].tokens },
      openai: { cost: SPLIT[1].cost, tokens: SPLIT[1].tokens },
    },
    byModel: Object.fromEntries(
      SPLIT.map((entry) => [entry.model, { cost: entry.cost, tokens: entry.tokens }]),
    ),
  }];

  const meta = {
    generatedAt: new Date(now).toISOString(),
    source: "fixture",
    shardDir: "fixture/logbook.d",
    sessions: sessions.length,
    projects: 1,
    machines: 1,
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
