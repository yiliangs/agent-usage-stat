import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CopilotProvider } from "../dist/providers/copilot/provider.js";
import { normalizeModelId, priceFor } from "../dist/providers/copilot/pricing.js";
import { detectProvider } from "../dist/providers/registry.js";

test("Copilot shutdown usage becomes one normalized provider session", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-usage-stat-copilot-"));
  const sessionId = "11111111-2222-4333-8444-555555555555";
  const sessionDir = join(home, "session-state", sessionId);
  const transcript = join(sessionDir, "events.jsonl");
  const line = (type, data, timestamp) =>
    JSON.stringify({ id: `${type}-${timestamp}`, type, data, timestamp });

  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    transcript,
    [
      line(
        "session.start",
        {
          sessionId,
          startTime: "2026-08-06T14:00:00.000Z",
          context: { cwd: join(home, "sample-project") },
        },
        "2026-08-06T14:00:00.000Z",
      ),
      line(
        "user.message",
        { content: "Inspect the build" },
        "2026-08-06T14:00:01.000Z",
      ),
      line(
        "assistant.message",
        { messageId: "response-1", model: "gpt-5.4-mini", outputTokens: 100 },
        "2026-08-06T14:00:02.000Z",
      ),
      line(
        "session.shutdown",
        {
          modelMetrics: {
            "gpt-5.4-mini": {
              totalNanoAiu: 0,
              usage: {
                inputTokens: 3500,
                outputTokens: 100,
                cacheReadTokens: 2000,
                cacheWriteTokens: 500,
              },
              tokenDetails: {
                input: { tokenCount: 1000 },
                cache_read: { tokenCount: 2000 },
                cache_write: { tokenCount: 500 },
                output: { tokenCount: 100 },
              },
            },
          },
          currentModel: "gpt-5.4-mini",
        },
        "2026-08-06T14:05:00.000Z",
      ),
    ].join("\n") + "\n",
  );

  try {
    const detected = await detectProvider(transcript);
    assert.equal(detected.name, "copilot");

    const provider = new CopilotProvider(home);
    const found = await provider.findSession(sessionId.slice(0, 8));
    assert.equal(found.sessionId, sessionId);

    const snapshot = await provider.readSession(transcript, sessionId);
    const { sessionData: usage, transcriptData: parsed, unknownModels } = snapshot;
    assert.equal(usage.provider, "copilot");
    assert.equal(usage.inputTokens, 1000);
    assert.equal(usage.outputTokens, 100);
    assert.equal(usage.cacheCreationTokens, 500);
    assert.equal(usage.cacheReadTokens, 2000);
    assert.equal(usage.totalTokens, 3600);
    assert.equal(usage.totalCost, 0.001725);
    assert.deepEqual(
      usage.modelBreakdowns.map((breakdown) => breakdown.modelName),
      ["gpt-5.4-mini"],
    );
    assert.deepEqual(usage.modelBreakdowns, [
      {
        modelName: "gpt-5.4-mini",
        displayName: "GPT-5.4 Mini",
        inputTokens: 1000,
        outputTokens: 100,
        cacheCreationTokens: 500,
        cacheReadTokens: 2000,
        cost: 0.001725,
      },
    ]);
    assert.deepEqual(unknownModels, []);

    assert.equal(parsed.firstPrompt, "Inspect the build");
    assert.equal(parsed.cwd, join(home, "sample-project"));
    assert.equal(parsed.userMessageCount, 1);
    assert.equal(parsed.assistantMessageCount, 1);
    assert.equal(parsed.startTime.toISOString(), "2026-08-06T14:00:00.000Z");
    assert.equal(parsed.endTime.toISOString(), "2026-08-06T14:05:00.000Z");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Copilot uses native per-model billed AI units when Fast mode keeps the same model id", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-usage-stat-copilot-fast-"));
  const sessionId = "77777777-7777-4777-8777-777777777777";
  const sessionDir = join(home, "session-state", sessionId);
  const transcript = join(sessionDir, "events.jsonl");
  const event = (type, data) => JSON.stringify({ type, data });

  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    transcript,
    [
      event("session.start", { sessionId }),
      event("session.shutdown", {
        modelMetrics: {
          "claude-opus-4.8": {
            totalNanoAiu: 2_325_000_000,
            tokenDetails: {
              input: { tokenCount: 1000 },
              cache_read: { tokenCount: 2000 },
              cache_write: { tokenCount: 500 },
              output: { tokenCount: 100 },
            },
          },
        },
        currentModel: "claude-opus-4.8",
      }),
    ].join("\n") + "\n",
  );

  try {
    const provider = new CopilotProvider(home);
    const { sessionData: usage, unknownModels } = await provider.readSession(
      transcript,
      sessionId,
    );

    assert.equal(usage.totalTokens, 3600);
    assert.equal(usage.modelBreakdowns[0].modelName, "claude-opus-4-8");
    assert.equal(Number(usage.totalCost.toFixed(6)), 0.02325);
    assert.deepEqual(unknownModels, []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Copilot prices both dotted Claude id orderings", () => {
  // The version-first shape is the one the normalizer used to pass through
  // untouched (#123): the family-first rule needs a letter after `claude-`,
  // so `claude-3.5-sonnet` never reached the table keyed `claude-3-5-sonnet`
  // and the session recorded its tokens at zero cost.
  const canonical = {
    "claude-3.5-sonnet": "claude-3-5-sonnet",
    "claude-3.7-sonnet": "claude-3-7-sonnet",
    "claude-3.5-haiku": "claude-3-5-haiku",
    "claude-sonnet-4.5": "claude-sonnet-4-5",
  };

  for (const [raw, expected] of Object.entries(canonical)) {
    assert.equal(normalizeModelId(raw), expected);
    assert.ok(priceFor(raw), `${raw} misses the pricing table`);
  }
});

test("Copilot returns unknown pricing models in the same immutable snapshot", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-usage-stat-copilot-unknown-"));
  const sessionId = "99999999-9999-4999-8999-999999999999";
  const transcript = join(home, "events.jsonl");
  const event = (type, data) => JSON.stringify({ type, data });
  await writeFile(
    transcript,
    [
      event("session.start", { sessionId }),
      event("session.shutdown", {
        modelMetrics: {
          "future-model-preview": {
            tokenDetails: {
              input: { tokenCount: 10 },
              output: { tokenCount: 2 },
            },
          },
        },
      }),
    ].join("\n") + "\n",
  );

  try {
    const snapshot = await new CopilotProvider(home).readSession(
      transcript,
      sessionId,
    );
    assert.equal(snapshot.sessionData.totalTokens, 12);
    assert.equal(snapshot.sessionData.totalCost, 0);
    assert.deepEqual(snapshot.unknownModels, ["future-model-preview"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
