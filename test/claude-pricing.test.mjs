import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { UsageCalculator } from "../dist/providers/claude/usage-calculator.js";

function assistant(
  id,
  usage,
  model = "gpt-5.6-sol",
  timestamp = "2026-07-18T00:00:00.000Z",
) {
  return JSON.stringify({
    type: "assistant",
    timestamp,
    message: {
      id,
      role: "assistant",
      model,
      content: [{ type: "text", text: "done" }],
      usage,
    },
  });
}

test("Claude Opus 5 aliases use current Anthropic pricing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-usage-stat-opus-5-"));
  const sessionId = "55555555-5555-5555-5555-555555555555";
  const path = join(dir, `${sessionId}.jsonl`);
  const usage = {
    input_tokens: 1_000,
    cache_creation_input_tokens: 2_000,
    cache_read_input_tokens: 400,
    output_tokens: 100,
  };

  await writeFile(
    path,
    assistant("resp_opus_5", usage, "claude-opus-5-20260724[1m]"),
    "utf8",
  );

  try {
    const calculator = new UsageCalculator();
    const result = await calculator.calculate(path, sessionId);

    assert.equal(result.totalTokens, 3_500);
    assert.equal(Number(result.totalCost.toFixed(6)), 0.0202);
    assert.deepEqual(result.modelsUsed, ["claude-opus-5"]);
    assert.equal(result.modelBreakdowns[0].displayName, "Claude Opus 5");
    assert.deepEqual(calculator.getUnknownModels(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Claude preserves response-scoped usage timestamps across days", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-usage-stat-claude-turns-"));
  const sessionId = "33333333-3333-3333-3333-333333333333";
  const path = join(dir, `${sessionId}.jsonl`);
  const first = {
    input_tokens: 1_000,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 100,
  };
  const second = {
    input_tokens: 2_000,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 200,
  };

  await writeFile(
    path,
    [
      assistant(
        "resp-july-15",
        first,
        "claude-opus-5",
        "2026-07-15T23:55:00.000Z",
      ),
      assistant(
        "resp-july-16",
        second,
        "claude-opus-5",
        "2026-07-16T00:15:00.000Z",
      ),
    ].join("\n"),
    "utf8",
  );

  try {
    const calculator = new UsageCalculator();
    const usage = await calculator.calculate(path, sessionId);

    assert.deepEqual(
      usage.turns.map((turn) => ({
        id: turn.id,
        endTime: turn.endTime,
        totalTokens: turn.totalTokens,
      })),
      [
        {
          id: "resp-july-15",
          endTime: "2026-07-15T23:55:00.000Z",
          totalTokens: 1_100,
        },
        {
          id: "resp-july-16",
          endTime: "2026-07-16T00:15:00.000Z",
          totalTokens: 2_200,
        },
      ],
    );
    assert.equal(
      Number(usage.turns.reduce((sum, turn) => sum + turn.totalCost, 0).toFixed(6)),
      Number(usage.totalCost.toFixed(6)),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Claude transcripts dedupe GPT responses and apply OpenAI request pricing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-usage-stat-claude-gpt-"));
  const sessionId = "44444444-4444-4444-4444-444444444444";
  const path = join(dir, `${sessionId}.jsonl`);
  const standardUsage = {
    input_tokens: 1_000,
    cache_creation_input_tokens: 2_000,
    cache_read_input_tokens: 400,
    output_tokens: 100,
  };
  const longContextUsage = {
    input_tokens: 100_000,
    cache_creation_input_tokens: 20_000,
    cache_read_input_tokens: 200_000,
    output_tokens: 1_000,
  };

  await writeFile(
    path,
    [
      assistant("resp_standard", standardUsage),
      assistant("resp_standard", standardUsage),
      assistant("resp_standard", standardUsage),
      assistant("resp_long", longContextUsage),
      assistant("resp_long", longContextUsage),
    ].join("\n"),
    "utf8",
  );

  try {
    const calculator = new UsageCalculator();
    const usage = await calculator.calculate(path, sessionId);

    assert.equal(usage.provider, "claude");
    assert.equal(usage.inputTokens, 101_000);
    assert.equal(usage.cacheCreationTokens, 22_000);
    assert.equal(usage.cacheReadTokens, 200_400);
    assert.equal(usage.outputTokens, 1_100);
    assert.equal(usage.totalTokens, 324_500);
    assert.equal(Number(usage.totalCost.toFixed(6)), 1.5157);
    assert.deepEqual(usage.modelsUsed, ["gpt-5.6-sol"]);
    assert.equal(usage.modelBreakdowns[0].displayName, "GPT-5.6 Sol");
    assert.deepEqual(calculator.getUnknownModels(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
