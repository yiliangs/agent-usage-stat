import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSessionUsage,
  buildTurnUsage,
  summarizeModelBreakdowns,
} from "../dist/core/usage-summary.js";
import { LogbookWriter } from "../dist/core/logbook-writer.js";

const breakdowns = [
  {
    modelName: "claude-opus-5",
    displayName: "Claude Opus 5",
    inputTokens: 10,
    outputTokens: 2,
    cacheCreationTokens: 3,
    cacheReadTokens: 4,
    cost: 0.00123456,
  },
  {
    modelName: "gpt-5.6-sol",
    displayName: "GPT-5.6 Sol",
    inputTokens: 20,
    outputTokens: 5,
    cacheCreationTokens: 6,
    cacheReadTokens: 7,
    cost: 0.00234567,
  },
];

test("normalized usage derives every aggregate and model projection", () => {
  assert.deepEqual(summarizeModelBreakdowns(breakdowns), {
    inputTokens: 30,
    outputTokens: 7,
    cacheCreationTokens: 9,
    cacheReadTokens: 11,
    totalTokens: 57,
    totalCost: 0.00358023,
  });

  const turn = buildTurnUsage({
    id: "turn-1",
    startTime: "2026-08-12T12:00:00.000Z",
    endTime: "2026-08-12T12:01:00.000Z",
    modelBreakdowns: breakdowns,
  });
  assert.equal(turn.totalTokens, 57);
  assert.equal(turn.totalCost, 0.00358023);
  assert.deepEqual(
    turn.modelBreakdowns.map((model) => model.modelName),
    ["claude-opus-5", "gpt-5.6-sol"],
  );

  const session = buildSessionUsage({
    provider: "claude",
    sessionId: "session-1",
    modelBreakdowns: breakdowns,
    turns: [turn],
    sourceFingerprint: "fingerprint-1",
  });
  assert.equal(session.totalTokens, 57);
  assert.equal(session.totalCost, 0.00358023);
  assert.deepEqual(
    session.modelBreakdowns.map((model) => model.modelName),
    ["claude-opus-5", "gpt-5.6-sol"],
  );
});

test("all providers serialize the same normalized usage contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-usage-stat-summary-"));

  try {
    for (const provider of ["claude", "codex", "copilot"]) {
      const sessionId = `${provider}-session`;
      const turn = buildTurnUsage({
        id: "turn-1",
        startTime: "2026-08-12T12:00:00.000Z",
        endTime: "2026-08-12T12:01:00.000Z",
        modelBreakdowns: breakdowns,
      });
      const sessionData = buildSessionUsage({
        provider,
        sessionId,
        modelBreakdowns: breakdowns,
        turns: [turn],
        sourceFingerprint: `${provider}-fingerprint`,
      });
      const path = await new LogbookWriter().append(root, {
        sessionData,
        transcriptData: {
          sessionSlug: `${provider}-slug`,
          firstPrompt: "test",
          startTime: new Date("2026-08-12T12:00:00.000Z"),
          endTime: new Date("2026-08-12T12:01:00.000Z"),
          userMessageCount: 1,
          assistantMessageCount: 1,
          totalMessages: 2,
          gitBranch: "main",
          cwd: "C:\\work\\usage-summary",
        },
      });

      const expected = {
        timestamp: "2026-08-12T12:01:00.000Z",
        session_slug: `${provider}-slug`,
        session_id: sessionId,
        project: "usage-summary",
        branch: "main",
        cwd: "C:\\work\\usage-summary",
        machine: hostname(),
        start_time: "2026-08-12T12:00:00.000Z",
        end_time: "2026-08-12T12:01:00.000Z",
        duration_seconds: 60,
        duration_human: "1m 0s",
        input_tokens: 30,
        output_tokens: 7,
        cache_creation_tokens: 9,
        cache_read_tokens: 11,
        total_tokens: 57,
        total_cost_usd: 0.00358,
        models: ["claude-opus-5", "gpt-5.6-sol"],
        model_breakdowns: [
          {
            model: "claude-opus-5",
            vendor: "anthropic",
            input_tokens: 10,
            output_tokens: 2,
            cache_creation_tokens: 3,
            cache_read_tokens: 4,
            total_tokens: 19,
            total_cost_usd: 0.001235,
          },
          {
            model: "gpt-5.6-sol",
            vendor: "openai",
            input_tokens: 20,
            output_tokens: 5,
            cache_creation_tokens: 6,
            cache_read_tokens: 7,
            total_tokens: 38,
            total_cost_usd: 0.002346,
          },
        ],
        turns: [
          {
            turn_id: "turn-1",
            start_time: "2026-08-12T12:00:00.000Z",
            end_time: "2026-08-12T12:01:00.000Z",
            input_tokens: 30,
            output_tokens: 7,
            cache_creation_tokens: 9,
            cache_read_tokens: 11,
            total_tokens: 57,
            total_cost_usd: 0.00358,
            models: ["claude-opus-5", "gpt-5.6-sol"],
          },
        ],
        source_fingerprint: `${provider}-fingerprint`,
        provider,
      };
      assert.equal(await readFile(path, "utf8"), JSON.stringify(expected, null, 2));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
