import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LogbookWriter } from "../dist/core/logbook-writer.js";
import { LOGBOOK_SHARD_DIR } from "../dist/core/usage-ledger.js";

/**
 * The behavioural half of "never let a recomputation replace a recorded
 * session with lower tokens", which `architecture-invariants.test.mjs` says
 * outright it cannot cover because it needs fixtures.
 *
 * Two writers can observe one session at different moments, so a shard write
 * has to decide which observation is the later one. Cumulative tokens answer
 * that and cost does not: a session only ever accumulates tokens, while its
 * cost is tokens times a rate that a pricing correction can lower underneath
 * it. Ordering by cost is what #128 reports and what the tests below pin.
 */

const SESSION = "preservation-session";

function sessionData(overrides) {
  return {
    provider: "claude",
    sessionId: SESSION,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    totalCost: 0,
    sourceFingerprint: "fingerprint",
    modelBreakdowns: [],
    ...overrides,
  };
}

/** One model holding the whole snapshot, so the shard's breakdown sums to its
 *  own totals exactly as a real capture's would. */
function wholeSessionOn(model, { input, output, cost }) {
  return [{
    modelName: model,
    inputTokens: input,
    outputTokens: output,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    cost,
  }];
}

function transcriptData(endTime = "2026-08-10T10:10:00.000Z") {
  return {
    sessionSlug: "preservation",
    firstPrompt: "work",
    startTime: new Date("2026-08-10T10:00:00.000Z"),
    endTime: new Date(endTime),
    userMessageCount: 1,
    assistantMessageCount: 1,
    totalMessages: 2,
    cwd: "C:\\Users\\y\\source\\repos\\agent-usage-stat",
  };
}

async function withRoot(run) {
  const root = await mkdtemp(join(tmpdir(), "agent-usage-stat-preservation-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** A shard as it was written before `model_breakdowns` existed: totals and a
 *  model list, and no per-model split to read them by. */
async function writeLegacyShard(root, record) {
  const dir = join(root, LOGBOOK_SHARD_DIR);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${SESSION}.json`);
  await writeFile(path, JSON.stringify({
    timestamp: "2026-07-01T10:10:00.000Z",
    session_slug: "preservation",
    session_id: SESSION,
    project: "agent-usage-stat",
    branch: "",
    cwd: "C:\\Users\\y\\source\\repos\\agent-usage-stat",
    machine: "WORKSTATION-01",
    start_time: "2026-07-01T10:00:00.000Z",
    end_time: "2026-07-01T10:10:00.000Z",
    duration_seconds: 600,
    duration_human: "10m",
    provider: "claude",
    source_fingerprint: "legacy-fingerprint",
    ...record,
  }, null, 2), "utf-8");
  return path;
}

test("a later snapshot keeps its grown tokens when a rate correction lowers its cost", async () => {
  await withRoot(async (root) => {
    const writer = new LogbookWriter();

    // Recorded while Sonnet 5 was still priced at the pre-correction rate.
    await writer.append(root, {
      sessionData: sessionData({
        inputTokens: 40_000,
        outputTokens: 60_000,
        totalTokens: 100_000,
        totalCost: 1,
        sourceFingerprint: "first-read",
        modelBreakdowns: wholeSessionOn("claude-sonnet-5", {
          input: 40_000,
          output: 60_000,
          cost: 1,
        }),
      }),
      transcriptData: transcriptData(),
    });

    // The same session, later and larger, repriced at the corrected rate.
    const shard = await writer.append(root, {
      sessionData: sessionData({
        inputTokens: 60_000,
        outputTokens: 90_000,
        totalTokens: 150_000,
        totalCost: 0.9,
        sourceFingerprint: "second-read",
        modelBreakdowns: wholeSessionOn("claude-sonnet-5", {
          input: 60_000,
          output: 90_000,
          cost: 0.9,
        }),
      }),
      transcriptData: transcriptData("2026-08-10T10:30:00.000Z"),
    });

    const record = JSON.parse(await readFile(shard, "utf8"));
    assert.equal(record.total_tokens, 150_000, "the fifty thousand new tokens survive");
    assert.equal(record.total_cost_usd, 0.9, "the corrected rate is what gets recorded");
    assert.equal(record.model_breakdowns?.[0]?.total_tokens, 150_000,
      "the breakdown is the one that sums to the recorded totals");
  });
});

test("an out-of-order worker's smaller snapshot never replaces the recorded one", async () => {
  await withRoot(async (root) => {
    const writer = new LogbookWriter();

    await writer.append(root, {
      sessionData: sessionData({
        inputTokens: 60_000,
        outputTokens: 90_000,
        totalTokens: 150_000,
        totalCost: 1.5,
        sourceFingerprint: "complete-read",
        modelBreakdowns: wholeSessionOn("claude-sonnet-5", {
          input: 60_000,
          output: 90_000,
          cost: 1.5,
        }),
      }),
      transcriptData: transcriptData("2026-08-10T10:30:00.000Z"),
    });

    const shard = await writer.append(root, {
      sessionData: sessionData({
        inputTokens: 40_000,
        outputTokens: 60_000,
        totalTokens: 100_000,
        totalCost: 1,
        sourceFingerprint: "stale-read",
        modelBreakdowns: wholeSessionOn("claude-sonnet-5", {
          input: 40_000,
          output: 60_000,
          cost: 1,
        }),
      }),
      transcriptData: transcriptData(),
    });

    const record = JSON.parse(await readFile(shard, "utf8"));
    assert.equal(record.total_tokens, 150_000, "the larger recorded snapshot stands");
    assert.equal(record.total_cost_usd, 1.5);
    assert.equal(record.source_fingerprint, "stale-read",
      "the fingerprint still advances so an unchanged transcript is not retried");

    const parts =
      record.input_tokens +
      record.output_tokens +
      record.cache_creation_tokens +
      record.cache_read_tokens;
    assert.equal(parts, record.total_tokens, "the shard's parts still sum to its total");
    assert.equal(record.end_time, "2026-08-10T10:30:00.000Z",
      "the preserved snapshot keeps its own time window, not the rejected read's");
  });
});

test("a rejected recompute leaves a single-model legacy shard able to name its vendor", async () => {
  await withRoot(async (root) => {
    await writeLegacyShard(root, {
      input_tokens: 400,
      output_tokens: 600,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 1000,
      total_cost_usd: 5,
      models: ["claude-sonnet-4-5"],
    });

    const shard = await new LogbookWriter().append(root, {
      sessionData: sessionData({
        inputTokens: 360,
        outputTokens: 540,
        totalTokens: 900,
        totalCost: 4,
        sourceFingerprint: "recompute",
        modelBreakdowns: wholeSessionOn("claude-sonnet-4-5", {
          input: 360,
          output: 540,
          cost: 4,
        }),
      }),
      transcriptData: transcriptData(),
    });

    const record = JSON.parse(await readFile(shard, "utf8"));
    assert.equal(record.total_tokens, 1000, "the recorded totals stand");
    assert.equal(record.total_cost_usd, 5);

    assert.ok(Array.isArray(record.model_breakdowns), "the shard carries a breakdown");
    assert.equal(record.model_breakdowns.length, 1);
    const [only] = record.model_breakdowns;
    assert.equal(only.model, "claude-sonnet-4-5");
    assert.equal(only.vendor, "anthropic");
    assert.equal(only.total_tokens, 1000, "the breakdown sums to the recorded totals");
    assert.equal(only.total_cost_usd, 5);
    assert.equal(only.input_tokens, 400, "and to each recorded component");
    assert.equal(only.output_tokens, 600);
  });
});

test("a rejected recompute invents no split for a multi-model legacy shard", async () => {
  await withRoot(async (root) => {
    await writeLegacyShard(root, {
      input_tokens: 400,
      output_tokens: 600,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 1000,
      total_cost_usd: 5,
      models: ["claude-sonnet-4-5", "gpt-5.6-codex"],
    });

    const shard = await new LogbookWriter().append(root, {
      sessionData: sessionData({
        inputTokens: 360,
        outputTokens: 540,
        totalTokens: 900,
        totalCost: 4,
        sourceFingerprint: "recompute",
        modelBreakdowns: wholeSessionOn("claude-sonnet-4-5", {
          input: 360,
          output: 540,
          cost: 4,
        }),
      }),
      transcriptData: transcriptData(),
    });

    const record = JSON.parse(await readFile(shard, "utf8"));
    assert.equal(record.total_tokens, 1000);
    assert.equal(record.model_breakdowns, undefined,
      "two models and one set of totals admit no honest split, so none is written");
    assert.deepEqual(record.models, ["claude-sonnet-4-5", "gpt-5.6-codex"],
      "the recorded model list is left alone for the reader's legacy fallback");
  });
});
