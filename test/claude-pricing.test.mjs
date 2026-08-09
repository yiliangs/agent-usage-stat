import test from "node:test";
import assert from "node:assert/strict";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { UsageCalculator } from "../dist/providers/claude/usage-calculator.js";
import { ClaudeProvider } from "../dist/providers/claude/provider.js";

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

test("Claude checkpoints process only appended transcript bytes across the session tree", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-usage-stat-claude-incremental-"));
  const cache = join(dir, "cache");
  const sessionId = "22222222-2222-4222-8222-222222222222";
  const projectDir = join(dir, "projects", "demo");
  const path = join(projectDir, `${sessionId}.jsonl`);
  const subagentDir = join(projectDir, sessionId, "subagents");
  const subagent = join(subagentDir, "agent-one.jsonl");
  const priorCacheRoot = process.env.AGENT_USAGE_STAT_CACHE_ROOT;
  process.env.AGENT_USAGE_STAT_CACHE_ROOT = cache;
  await mkdir(subagentDir, { recursive: true });
  await writeFile(
    path,
    [
      JSON.stringify({
        type: "user",
        timestamp: "2026-08-09T10:00:00.000Z",
        cwd: "C:\\work\\demo",
        message: { role: "user", content: "First prompt" },
      }),
      assistant("main-one", {
        input_tokens: 1_000,
        output_tokens: 100,
      }, "claude-sonnet-4-6", "2026-08-09T10:00:01.000Z"),
    ].join("\n") + "\n",
  );
  await writeFile(
    subagent,
    assistant("sub-one", {
      input_tokens: 2_000,
      output_tokens: 200,
    }, "claude-sonnet-4-6", "2026-08-09T10:00:02.000Z") + "\n",
  );

  try {
    const provider = new ClaudeProvider();
    const first = await provider.calculateUsage(path, sessionId);
    assert.equal(first.totalTokens, 3_300);

    const appended = assistant("main-two", {
      input_tokens: 3_000,
      output_tokens: 300,
    }, "claude-sonnet-4-6", "2026-08-09T10:00:03.000Z") + "\n";
    await appendFile(path, appended + '{"type":"user"');

    const second = await provider.calculateUsage(path, sessionId);
    const transcript = await provider.parseTranscript(path, sessionId);
    assert.equal(second.totalTokens, 6_600);
    assert.deepEqual(second.turns.map((turn) => turn.id), [
      "main-one",
      "sub-one",
      "main-two",
    ]);
    assert.equal(transcript.firstPrompt, "First prompt");
    assert.equal(transcript.projectName, "demo");

    const [cacheFile] = (await readdir(join(cache, "claude")))
      .filter((name) => name.endsWith(".json"));
    const cacheState = JSON.parse(
      await readFile(join(cache, "claude", cacheFile), "utf8"),
    );
    assert.ok(cacheState.lastReadBytes > 0);
    assert.ok(cacheState.lastReadBytes < (await stat(path)).size);
  } finally {
    if (priorCacheRoot === undefined) delete process.env.AGENT_USAGE_STAT_CACHE_ROOT;
    else process.env.AGENT_USAGE_STAT_CACHE_ROOT = priorCacheRoot;
    await rm(dir, { recursive: true, force: true });
  }
});

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

test("Claude prices each Opus response using its recorded speed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-usage-stat-claude-fast-"));
  const sessionId = "66666666-6666-4666-8666-666666666666";
  const path = join(dir, `${sessionId}.jsonl`);
  const standardUsage = {
    input_tokens: 1_000,
    cache_creation_input_tokens: 2_000,
    cache_read_input_tokens: 400,
    output_tokens: 100,
    speed: "standard",
  };
  const fastUsage = { ...standardUsage, speed: "fast" };

  await writeFile(
    path,
    [
      assistant("resp_standard", standardUsage, "claude-opus-5"),
      assistant("resp_fast", fastUsage, "claude-opus-5"),
    ].join("\n"),
    "utf8",
  );

  try {
    const calculator = new UsageCalculator();
    const usage = await calculator.calculate(path, sessionId);

    assert.equal(usage.turns.length, 2);
    assert.equal(Number(usage.turns[0].totalCost.toFixed(6)), 0.0202);
    assert.equal(Number(usage.turns[1].totalCost.toFixed(6)), 0.0404);
    assert.equal(Number(usage.totalCost.toFixed(6)), 0.0606);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Claude preserves historical Fast pricing for earlier supported Opus models", async () => {
  const cases = [
    { model: "claude-opus-4-8", expected: 0.015 },
    { model: "claude-opus-4-7", expected: 0.045 },
    { model: "claude-opus-4-6", expected: 0.045 },
  ];

  for (const { model, expected } of cases) {
    const dir = await mkdtemp(join(tmpdir(), "agent-usage-stat-claude-fast-model-"));
    const sessionId = "88888888-8888-4888-8888-888888888888";
    const path = join(dir, `${sessionId}.jsonl`);
    const usage = {
      input_tokens: 1_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 100,
      speed: "fast",
    };

    await writeFile(path, assistant(`resp_${model}`, usage, model), "utf8");

    try {
      const calculator = new UsageCalculator();
      const result = await calculator.calculate(path, sessionId);
      assert.equal(Number(result.totalCost.toFixed(6)), expected, model);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
