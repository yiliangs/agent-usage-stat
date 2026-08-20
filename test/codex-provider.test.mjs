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
import { spawn } from "node:child_process";
import { CodexProvider } from "../dist/providers/codex/provider.js";
import { detectProvider } from "../dist/providers/registry.js";
import { LogbookWriter } from "../dist/core/logbook-writer.js";
import {
  createAgentRun,
  removeAgentRun,
  waitForAgentRun,
} from "../dist/utils/capture-run.js";

function line(type, payload, timestamp) {
  return JSON.stringify({ type, payload, timestamp });
}

test("Codex snapshot cache processes appended complete lines and defers partial tails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-usage-stat-incremental-"));
  const cache = join(dir, "cache");
  const sessionId = "99999999-9999-9999-9999-999999999999";
  const path = join(dir, `rollout-${sessionId}.jsonl`);
  const firstUsage = {
    input_tokens: 1000,
    cached_input_tokens: 400,
    output_tokens: 100,
    total_tokens: 1100,
  };
  const secondUsage = {
    input_tokens: 3000,
    cached_input_tokens: 800,
    output_tokens: 300,
    total_tokens: 3300,
  };
  const priorCacheRoot = process.env.AGENT_USAGE_STAT_CACHE_ROOT;
  process.env.AGENT_USAGE_STAT_CACHE_ROOT = cache;

  await writeFile(
    path,
    [
      line("session_meta", { id: sessionId, cwd: "C:\\work\\demo" }),
      line("turn_context", { turn_id: "one", model: "gpt-5.6-sol" }),
      line("event_msg", { type: "user_message", message: "First prompt" }),
      line("event_msg", {
        type: "token_count",
        info: { total_token_usage: firstUsage, last_token_usage: firstUsage },
      }),
    ].join("\n") + "\n",
  );

  try {
    const provider = new CodexProvider();
    const first = await provider.readSession(path, sessionId);
    assert.equal(first.sessionData.totalTokens, 1100);
    assert.deepEqual(first.unknownModels, []);
    assert.equal((await readdir(cache)).filter((x) => x.endsWith(".json")).length, 1);

    const completeSecondTurn = [
      line("turn_context", { turn_id: "two", model: "gpt-5.6-sol" }),
      line("event_msg", { type: "agent_message", message: "Second response" }),
      line("event_msg", {
        type: "token_count",
        info: { total_token_usage: secondUsage, last_token_usage: {
          input_tokens: 2000,
          cached_input_tokens: 400,
          output_tokens: 200,
          total_tokens: 2200,
        } },
      }),
    ].join("\n") + "\n";
    await appendFile(path, completeSecondTurn + '{"type":"event_msg"');

    const second = await provider.readSession(path, sessionId);
    assert.equal(second.sessionData.totalTokens, 3300);
    assert.equal(second.sessionData.turns.length, 2);
    assert.equal(second.transcriptData.assistantMessageCount, 1);
    assert.deepEqual(second.unknownModels, []);
    const [cacheFile] = (await readdir(cache)).filter((x) => x.endsWith(".json"));
    const cacheState = JSON.parse(await readFile(join(cache, cacheFile), "utf8"));
    assert.ok(cacheState.lastReadBytes > 0);
    assert.ok(cacheState.lastReadBytes < (await stat(path)).size);

    await appendFile(path, ',"payload":{"type":"user_message","message":"Later"}}\n');
    const third = await provider.readSession(path, sessionId);
    assert.equal(third.transcriptData.userMessageCount, 2);
    assert.deepEqual(third.unknownModels, []);
  } finally {
    if (priorCacheRoot === undefined) {
      delete process.env.AGENT_USAGE_STAT_CACHE_ROOT;
    } else {
      process.env.AGENT_USAGE_STAT_CACHE_ROOT = priorCacheRoot;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex rollout usage is deduped, split by model, and long-context priced", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-usage-stat-test-"));
  const path = join(
    dir,
    "rollout-2026-07-13T00-00-00-11111111-1111-1111-1111-111111111111.jsonl",
  );
  const cumulativeOne = {
    input_tokens: 1000,
    cached_input_tokens: 400,
    output_tokens: 100,
    total_tokens: 1100,
  };
  const cumulativeTwo = {
    input_tokens: 301000,
    cached_input_tokens: 200400,
    output_tokens: 1100,
    total_tokens: 302100,
  };
  await writeFile(
    path,
    [
      line(
        "session_meta",
        {
          id: "11111111-1111-1111-1111-111111111111",
          cwd: "C:\\work\\usage-stat",
          git: { branch: "main" },
        },
        "2026-07-13T00:00:00.000Z",
      ),
      line("turn_context", { model: "gpt-5.4" }, "2026-07-13T00:00:01.000Z"),
      line(
        "event_msg",
        { type: "user_message", message: "Build usage analytics" },
        "2026-07-13T00:00:02.000Z",
      ),
      line(
        "event_msg",
        {
          type: "token_count",
          info: {
            total_token_usage: cumulativeOne,
            last_token_usage: cumulativeOne,
          },
        },
        "2026-07-13T00:00:03.000Z",
      ),
      // Replay of the same cumulative event must not double bill.
      line(
        "event_msg",
        {
          type: "token_count",
          info: {
            total_token_usage: cumulativeOne,
            last_token_usage: cumulativeOne,
          },
        },
        "2026-07-13T00:00:03.500Z",
      ),
      line(
        "turn_context",
        { model: "gpt-5.6-sol" },
        "2026-07-13T00:00:04.000Z",
      ),
      line(
        "event_msg",
        {
          type: "token_count",
          info: {
            total_token_usage: cumulativeTwo,
            last_token_usage: {
              input_tokens: 300000,
              cached_input_tokens: 200000,
              cache_write_tokens: 80000,
              output_tokens: 1000,
              total_tokens: 301000,
            },
          },
        },
        "2026-07-13T00:00:05.000Z",
      ),
      line(
        "event_msg",
        { type: "agent_message", message: "Done" },
        "2026-07-13T00:00:06.000Z",
      ),
    ].join("\n"),
    "utf8",
  );

  try {
    const provider = new CodexProvider();
    const snapshot = await provider.readSession(path, "fallback");
    const { sessionData: usage, transcriptData: transcript, unknownModels } = snapshot;
    const detected = await detectProvider(path);

    assert.equal(detected.name, "codex");
    assert.equal(usage.sessionId, "11111111-1111-1111-1111-111111111111");
    assert.equal(usage.inputTokens, 20600);
    assert.equal(usage.cacheCreationTokens, 80000);
    assert.equal(usage.cacheReadTokens, 200400);
    assert.equal(usage.outputTokens, 1100);
    assert.equal(usage.totalTokens, 302100);
    assert.equal(Number(usage.totalCost.toFixed(6)), 1.4481);
    assert.deepEqual(
      usage.modelBreakdowns.map((breakdown) => breakdown.modelName),
      ["gpt-5.6-sol", "gpt-5.4"],
    );
    assert.deepEqual(unknownModels, []);
    assert.equal(transcript.sessionSlug, "build-usage-analytics");
    assert.equal(transcript.cwd, "C:\\work\\usage-stat");
    assert.equal(transcript.gitBranch, "main");
    assert.equal(transcript.userMessageCount, 1);
    assert.equal(transcript.assistantMessageCount, 1);

  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex prices the GPT-5.6 alias as Sol", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-usage-stat-test-"));
  const path = join(dir, "rollout-alias.jsonl");
  const usageEvent = {
    input_tokens: 2000,
    cached_input_tokens: 500,
    cache_write_tokens: 1000,
    output_tokens: 100,
    total_tokens: 2100,
  };

  await writeFile(
    path,
    [
      line("turn_context", { model: "gpt-5.6" }),
      line("event_msg", {
        type: "token_count",
        info: {
          total_token_usage: usageEvent,
          last_token_usage: usageEvent,
        },
      }),
    ].join("\n"),
    "utf8",
  );

  try {
    const provider = new CodexProvider();
    const { sessionData: usage, unknownModels } = await provider.readSession(
      path,
      "fallback",
    );

    assert.equal(usage.inputTokens, 500);
    assert.equal(usage.cacheCreationTokens, 1000);
    assert.equal(usage.cacheReadTokens, 500);
    assert.equal(usage.outputTokens, 100);
    assert.equal(usage.totalTokens, 2100);
    assert.equal(Number(usage.totalCost.toFixed(6)), 0.012);
    assert.deepEqual(
      usage.modelBreakdowns.map((breakdown) => breakdown.modelName),
      ["gpt-5.6-sol"],
    );
    assert.equal(usage.modelBreakdowns[0].displayName, "GPT-5.6 Sol");
    assert.deepEqual(unknownModels, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex applies Fast pricing only to turns recorded at the priority tier", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-usage-stat-fast-tier-"));
  const path = join(dir, "rollout-fast-tier.jsonl");
  const oneTurn = {
    input_tokens: 1000,
    cached_input_tokens: 0,
    output_tokens: 100,
    total_tokens: 1100,
  };

  await writeFile(
    path,
    [
      line("event_msg", {
        type: "thread_settings_applied",
        thread_settings: {
          model: "gpt-5.6-sol",
          service_tier: "default",
        },
      }),
      line("turn_context", { turn_id: "standard", model: "gpt-5.6-sol" }),
      line("event_msg", {
        type: "token_count",
        info: {
          total_token_usage: oneTurn,
          last_token_usage: oneTurn,
        },
      }),
      line("event_msg", {
        type: "thread_settings_applied",
        thread_settings: {
          model: "gpt-5.6-sol",
          service_tier: "priority",
        },
      }),
      line("turn_context", { turn_id: "fast", model: "gpt-5.6-sol" }),
      line("event_msg", {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 2000,
            cached_input_tokens: 0,
            output_tokens: 200,
            total_tokens: 2200,
          },
          last_token_usage: oneTurn,
        },
      }),
    ].join("\n"),
    "utf8",
  );

  try {
    const provider = new CodexProvider();
    const { sessionData: usage, unknownModels } = await provider.readSession(
      path,
      "fallback",
    );

    assert.equal(usage.turns.length, 2);
    assert.equal(Number(usage.turns[0].totalCost.toFixed(6)), 0.008);
    assert.equal(Number(usage.turns[1].totalCost.toFixed(6)), 0.02);
    assert.equal(Number(usage.totalCost.toFixed(6)), 0.028);
    assert.deepEqual(unknownModels, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex uses the documented Fast multiplier for each supported model", async () => {
  const cases = [
    { model: "gpt-5.6-sol", expected: 0.02 },
    { model: "gpt-5.5", expected: 0.02 },
    { model: "gpt-5.4", expected: 0.008 },
  ];

  for (const { model, expected } of cases) {
    const dir = await mkdtemp(join(tmpdir(), "agent-usage-stat-fast-model-"));
    const path = join(dir, `rollout-${model}.jsonl`);
    const tokenUsage = {
      input_tokens: 1000,
      cached_input_tokens: 0,
      output_tokens: 100,
      total_tokens: 1100,
    };

    await writeFile(
      path,
      [
        line("event_msg", {
          type: "thread_settings_applied",
          thread_settings: { model, service_tier: "priority" },
        }),
        line("turn_context", { turn_id: model, model }),
        line("event_msg", {
          type: "token_count",
          info: {
            total_token_usage: tokenUsage,
            last_token_usage: tokenUsage,
          },
        }),
      ].join("\n"),
      "utf8",
    );

    try {
      const provider = new CodexProvider();
      const { sessionData: usage, unknownModels } = await provider.readSession(
        path,
        "fallback",
      );
      assert.equal(Number(usage.totalCost.toFixed(6)), expected, model);
      assert.deepEqual(unknownModels, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("Codex preserves the rollout identity when fork history repeats parent metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-usage-stat-codex-fork-"));
  const forkId = "77777777-7777-7777-7777-777777777777";
  const parentId = "88888888-8888-8888-8888-888888888888";
  const path = join(
    dir,
    `rollout-2026-07-18T00-00-00-${forkId}.jsonl`,
  );
  const usage = {
    input_tokens: 1000,
    cached_input_tokens: 400,
    output_tokens: 100,
    total_tokens: 1100,
  };

  await writeFile(
    path,
    [
      line(
        "session_meta",
        { id: forkId, session_id: parentId, forked_from_id: parentId },
        "2026-07-18T00:00:00.000Z",
      ),
      line(
        "turn_context",
        { turn_id: "turn-1", model: "gpt-5.6-sol" },
        "2026-07-18T00:00:01.000Z",
      ),
      line(
        "event_msg",
        {
          type: "token_count",
          info: { total_token_usage: usage, last_token_usage: usage },
        },
        "2026-07-18T00:00:02.000Z",
      ),
      line(
        "session_meta",
        { id: parentId, session_id: parentId },
        "2026-07-17T00:00:00.000Z",
      ),
    ].join("\n"),
  );

  try {
    const provider = new CodexProvider();
    const result = await provider.readSession(path, forkId);
    assert.equal(result.sessionData.sessionId, forkId);
    assert.deepEqual(result.unknownModels, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex preserves per-turn usage and timestamps across days", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-usage-stat-turns-"));
  const path = join(dir, "rollout-turns.jsonl");
  const firstUsage = {
    input_tokens: 1000,
    cached_input_tokens: 400,
    output_tokens: 100,
    total_tokens: 1100,
  };
  const secondUsage = {
    input_tokens: 2000,
    cached_input_tokens: 500,
    output_tokens: 200,
    total_tokens: 2200,
  };

  await writeFile(
    path,
    [
      line(
        "turn_context",
        { turn_id: "turn-july-15", model: "gpt-5.6-sol" },
        "2026-07-15T23:50:00.000Z",
      ),
      line(
        "event_msg",
        {
          type: "token_count",
          info: {
            total_token_usage: firstUsage,
            last_token_usage: firstUsage,
          },
        },
        "2026-07-15T23:55:00.000Z",
      ),
      line(
        "turn_context",
        { turn_id: "turn-july-16", model: "gpt-5.6-sol" },
        "2026-07-16T00:10:00.000Z",
      ),
      line(
        "event_msg",
        {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 3000,
              cached_input_tokens: 900,
              output_tokens: 300,
              total_tokens: 3300,
            },
            last_token_usage: secondUsage,
          },
        },
        "2026-07-16T00:15:00.000Z",
      ),
    ].join("\n"),
    "utf8",
  );

  try {
    const provider = new CodexProvider();
    const { sessionData: usage, unknownModels } = await provider.readSession(
      path,
      "fallback",
    );

    assert.deepEqual(
      usage.turns.map((turn) => ({
        id: turn.id,
        endTime: turn.endTime,
        totalTokens: turn.totalTokens,
      })),
      [
        {
          id: "turn-july-15",
          endTime: "2026-07-15T23:55:00.000Z",
          totalTokens: 1100,
        },
        {
          id: "turn-july-16",
          endTime: "2026-07-16T00:15:00.000Z",
          totalTokens: 2200,
        },
      ],
    );
    assert.equal(
      Number(usage.turns.reduce((sum, turn) => sum + turn.totalCost, 0).toFixed(6)),
      Number(usage.totalCost.toFixed(6)),
    );
    assert.deepEqual(unknownModels, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("logbook never regresses when detached workers finish out of order", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-logbook-test-"));
  const writer = new LogbookWriter();
  const makeData = (tokens, cost, end) => ({
    sessionData: {
      provider: "codex",
      sessionId: "22222222-2222-2222-2222-222222222222",
      inputTokens: tokens - 10,
      outputTokens: 10,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: tokens,
      totalCost: cost,
      sourceFingerprint: `snapshot-${tokens}`,
      modelBreakdowns: [],
    },
    transcriptData: {
      sessionSlug: "race-test",
      firstPrompt: "race",
      startTime: new Date("2026-07-13T00:00:00.000Z"),
      endTime: new Date(end),
      userMessageCount: 1,
      assistantMessageCount: 1,
      totalMessages: 2,
      cwd: "C:\\work\\usage-stat",
    },
  });

  try {
    const shard = await writer.append(
      root,
      makeData(1000, 1.5, "2026-07-13T00:10:00.000Z"),
    );
    await writer.append(
      root,
      makeData(900, 0.9, "2026-07-13T00:09:00.000Z"),
    );
    const preserved = JSON.parse(await readFile(shard, "utf8"));
    assert.equal(preserved.total_tokens, 1000);
    assert.equal(preserved.total_cost_usd, 1.5);
    assert.equal(preserved.source_fingerprint, "snapshot-900");

    await Promise.all(
      [800, 700, 600, 500].map((tokens) =>
        writer.append(
          root,
          makeData(
            tokens,
            tokens / 1000,
            `2026-07-13T00:0${tokens / 100}:00.000Z`,
          ),
        ),
      ),
    );
    const record = JSON.parse(await readFile(shard, "utf8"));
    assert.equal(record.total_tokens, 1000);
    assert.equal(record.total_cost_usd, 1.5);
    assert.notEqual(record.source_fingerprint, "snapshot-1000");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detached Codex hook performs a quiet usage update", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-cli-test-"));
  const codexHome = join(home, ".codex");
  const sessionDir = join(codexHome, "sessions", "2026", "07", "13");
  const dataRoot = join(home, "usage-data");
  const sessionId = "33333333-3333-3333-3333-333333333333";
  const rollout = join(
    sessionDir,
    `rollout-2026-07-13T00-00-00-${sessionId}.jsonl`,
  );

  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(home, ".agent-usage-stat.config.json"),
    JSON.stringify({ version: "2.0.0", dataRoot }),
    "utf8",
  );
  await writeFile(
    rollout,
    [
      line(
        "session_meta",
        { id: sessionId, cwd: "C:\\work\\cli-test" },
        "2026-07-13T00:00:00.000Z",
      ),
      line("turn_context", { model: "gpt-5.4" }, "2026-07-13T00:00:01.000Z"),
      line(
        "event_msg",
        {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 1000,
              cached_input_tokens: 500,
              output_tokens: 100,
              total_tokens: 1100,
            },
            last_token_usage: {
              input_tokens: 1000,
              cached_input_tokens: 500,
              output_tokens: 100,
              total_tokens: 1100,
            },
          },
        },
        "2026-07-13T00:00:02.000Z",
      ),
    ].join("\n"),
    "utf8",
  );

  const run = await createAgentRun("codex", {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
  });

  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        join(process.cwd(), "dist", "helper.js"),
        "capture",
        "--detach",
        "--quiet",
      ], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          CODEX_HOME: codexHome,
          AGENT_USAGE_STAT_RUN_ID: run.manifest.run_id,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(
        JSON.stringify({
          session_id: sessionId,
          transcript_path: rollout,
          cwd: "C:\\work\\cli-test",
          permission_mode: "default",
          hook_event_name: "Stop",
          model: "gpt-5.4",
          turn_id: "turn-1",
          stop_hook_active: false,
        }),
      );
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");

    const shardPath = join(dataRoot, "logbook.d", `${sessionId}.json`);
    let shard;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        shard = JSON.parse(await readFile(shardPath, "utf8"));
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.ok(shard, "detached worker did not write its shard");
    assert.equal(shard.provider, "codex");
    assert.equal(shard.total_tokens, 1100);
    assert.equal(shard.total_cost_usd, 0.002875);
    assert.equal(shard.turns.length, 1);
    assert.equal(shard.turns[0].turn_id, "turn-1");
    assert.equal(shard.turns[0].total_tokens, 1100);

    const settled = await waitForAgentRun(run, {
      pollMs: 10,
      quietMs: 20,
      timeoutMs: 1000,
    });
    assert.equal(settled.timedOut, false);
    assert.equal(settled.results.length, 1);
    assert.equal(settled.results[0].status, "recorded");
    assert.equal(settled.results[0].shard_path, shardPath);
  } finally {
    await removeAgentRun(run);
    await rm(home, { recursive: true, force: true });
  }
});
