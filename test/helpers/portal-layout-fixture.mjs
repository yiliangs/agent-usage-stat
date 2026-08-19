/**
 * A worst-case session set for the portal layout guard.
 *
 * Panels are sized for the numbers a real install produces, so the fixture is
 * built from the extremes rather than from typical data: six-figure spend, a
 * near-empty prior period so the comparison percentage reaches four digits,
 * and a day of heavily concurrent sessions so the rhythm field has to divide
 * one column into many lanes. Timestamps are relative to the moment the
 * fixture is built because the portal windows everything against now.
 */

const DAY = 86_400_000;
const MODELS = ["gpt-5.6-sol", "claude-opus-4-1", "claude-fable-5", "gpt-5.6-codex"];

function session({ index, start, durationMinutes, project, cost, tokens, model }) {
  const end = start + durationMinutes * 60_000;
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
    end: new Date(end).toISOString(),
    durSec: durationMinutes * 60,
    input,
    output,
    cacheCreate: tokens - cacheRead - input - output,
    cacheRead,
    totalTokens: tokens,
    cost,
    models: [model],
    turns: [],
  };
}

/** `sessions.json` and `meta.json` as the desktop build writes them. */
export function buildLayoutFixture(now = Date.now()) {
  const sessions = [];
  let index = 0;

  // A single prior-period session keeps every comparison finite while making
  // the current period read as a four-digit percentage increase.
  sessions.push(session({
    index: index++,
    start: now - 45 * DAY,
    durationMinutes: 30,
    project: "baseline",
    cost: 4.25,
    tokens: 1_200_000,
    model: MODELS[0],
  }));

  // Current period: enough spend to push the API-value figure past $100,000
  // and the token figure into the billions.
  for (let day = 1; day <= 29; day += 1) {
    for (let slot = 0; slot < 3; slot += 1) {
      sessions.push(session({
        index: index++,
        start: now - day * DAY + slot * 3 * 3_600_000,
        durationMinutes: 95,
        project: `project-${String.fromCharCode(97 + (slot % 4))}`,
        cost: 1_450.75,
        tokens: 640_000_000,
        model: MODELS[(day + slot) % MODELS.length],
      }));
    }
  }

  // One dense day: eight overlapping sessions divide a rhythm column into
  // eight lanes, the narrowest an event block ever gets.
  for (let lane = 0; lane < 8; lane += 1) {
    sessions.push(session({
      index: index++,
      start: now - 2 * DAY + 9 * 3_600_000 + lane * 60_000,
      durationMinutes: 240,
      project: `long-running-integration-project-${lane}`,
      cost: 96.5,
      tokens: 41_000_000,
      model: MODELS[lane % MODELS.length],
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
      from: new Date(now - 45 * DAY).toISOString(),
      to: new Date(now).toISOString(),
    },
  };
  return { "sessions.json": sessions, "meta.json": meta };
}
