import test from "node:test";
import assert from "node:assert/strict";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { detectInstalledAgents } from "../dist/commands/setup.js";
import { portalTaskScript } from "../dist/commands/portal-autostart.js";
import { buildPortalData } from "../portal/scripts/build-data.mjs";
import { detectProvider } from "../dist/index.js";

test("installed agents are inferred without a provider setting", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-usage-stat-detect-"));
  const claudeHome = join(home, "custom-claude-home");
  await mkdir(claudeHome);

  try {
    const agents = detectInstalledAgents(
      home,
      (command) => command === "codex",
      { CLAUDE_CONFIG_DIR: claudeHome },
    );
    assert.deepEqual(agents, ["claude", "codex"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("the provider is inferred from transcript content", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-usage-stat-provider-"));
  const transcript = join(root, "session.jsonl");
  await writeFile(transcript, '{"type":"user","message":{"role":"user"}}\n');

  try {
    const provider = await detectProvider(transcript);
    assert.equal(provider.name, "claude");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "setup asks for no provider and reuses the chosen folder",
  { skip: !["win32", "darwin"].includes(process.platform) },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-usage-stat-setup-"));
    const dataRoot = join(home, "usage");
    await mkdir(join(home, ".claude"));
    await mkdir(join(home, ".codex"));

    try {
      const first = await runCli(
        ["setup", "--data-root", dataRoot],
        home,
      );
      assert.equal(first.code, 0, first.output);

      const config = JSON.parse(
        await readFile(join(home, ".agent-usage-stat.config.json"), "utf8"),
      );
      const codexHooks = await readFile(
        join(home, ".codex", "hooks.json"),
        "utf8",
      );
      assert.equal(config.dataRoot, dataRoot);
      assert.equal(codexHooks.includes("--provider"), false);
      await readFile(join(home, ".claude", "settings.json"), "utf8");
      const shellProfile = await readFile(
        join(home, "shell-profile.ps1"),
        "utf8",
      );
      assert.match(shellProfile, /function global:claude/);
      assert.match(shellProfile, /function global:codex/);
      assert.match(shellProfile, /function global:claudex/);

      const second = await runCli(["setup"], home);
      assert.equal(second.code, 0, second.output);
      assert.equal(second.output.includes("Usage data folder"), false);
      assert.equal(second.output.includes("one final action"), false);
      assert.equal(
        await readFile(join(home, "shell-profile.ps1"), "utf8"),
        shellProfile,
      );

      const disabled = await runCli(["setup", "--no-terminal-message"], home);
      assert.equal(disabled.code, 0, disabled.output);
      assert.doesNotMatch(
        await readFile(join(home, "shell-profile.ps1"), "utf8"),
        /Agent Usage Stat terminal message/,
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

test("a new empty data folder produces a usable portal snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-usage-stat-empty-"));
  const outDir = join(root, "portal");
  await mkdir(join(root, "logbook.d"));

  try {
    const meta = await buildPortalData({ root, outDir });
    const sessions = JSON.parse(
      await readFile(join(outDir, "sessions.json"), "utf8"),
    );

    assert.deepEqual(sessions, []);
    assert.equal(meta.sessions, 0);
    assert.deepEqual(meta.span, { from: null, to: null });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("portal data preserves turn-scoped usage slices", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-usage-stat-turn-data-"));
  const outDir = join(root, "portal");
  const shardDir = join(root, "logbook.d");
  await mkdir(shardDir);
  await writeFile(
    join(shardDir, "turn-session.json"),
    JSON.stringify({
      session_id: "turn-session",
      session_slug: "turn-session",
      provider: "codex",
      start_time: "2026-07-15T23:50:00.000Z",
      end_time: "2026-07-16T00:15:00.000Z",
      total_tokens: 3300,
      total_cost_usd: 0.01,
      models: ["gpt-5.6-sol"],
      turns: [
        {
          turn_id: "turn-july-15",
          start_time: "2026-07-15T23:50:00.000Z",
          end_time: "2026-07-15T23:55:00.000Z",
          total_tokens: 1100,
          total_cost_usd: 0.003,
          models: ["gpt-5.6-sol"],
        },
        {
          turn_id: "turn-july-16",
          start_time: "2026-07-16T00:10:00.000Z",
          end_time: "2026-07-16T00:15:00.000Z",
          total_tokens: 2200,
          total_cost_usd: 0.007,
          models: ["gpt-5.6-sol"],
        },
      ],
    }),
  );

  try {
    await buildPortalData({ root, outDir });
    const sessions = JSON.parse(
      await readFile(join(outDir, "sessions.json"), "utf8"),
    );
    assert.deepEqual(
      sessions[0].turns.map((turn) => [turn.id, turn.end, turn.totalTokens]),
      [
        ["turn-july-15", "2026-07-15T23:55:00.000Z", 1100],
        ["turn-july-16", "2026-07-16T00:15:00.000Z", 2200],
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sync repairs a stale newer shard by rollout content, then stays idempotent", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-usage-stat-sync-"));
  const sessionId = "55555555-5555-5555-5555-555555555555";
  const sessionDir = join(home, ".codex", "sessions", "2026", "07", "17");
  const dataRoot = join(home, "usage");
  const shardDir = join(dataRoot, "logbook.d");
  const rollout = join(
    sessionDir,
    `rollout-2026-07-17T10-00-00-${sessionId}.jsonl`,
  );
  const shard = join(shardDir, `${sessionId}.json`);
  const line = (type, payload, timestamp) =>
    JSON.stringify({ type, payload, timestamp });
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

  await mkdir(sessionDir, { recursive: true });
  await mkdir(shardDir, { recursive: true });
  await writeFile(
    join(home, ".agent-usage-stat.config.json"),
    JSON.stringify({ dataRoot }),
  );
  await writeFile(
    rollout,
    [
      line(
        "session_meta",
        { id: sessionId, cwd: join(home, "project") },
        "2026-07-17T10:00:00.000Z",
      ),
      line(
        "turn_context",
        { turn_id: "turn-1", model: "gpt-5.6-sol" },
        "2026-07-17T10:00:01.000Z",
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
        "2026-07-17T10:00:02.000Z",
      ),
      line(
        "turn_context",
        { turn_id: "turn-2", model: "gpt-5.6-sol" },
        "2026-07-17T11:00:01.000Z",
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
        "2026-07-17T11:00:02.000Z",
      ),
    ].join("\n"),
  );
  await writeFile(
    shard,
    JSON.stringify({
      session_id: sessionId,
      session_slug: "stale-session",
      provider: "codex",
      start_time: "2026-07-17T10:00:00.000Z",
      end_time: "2026-07-17T10:00:02.000Z",
      total_tokens: 1100,
      total_cost_usd: 0.003,
      models: ["gpt-5.6-sol"],
      turns: [{ turn_id: "turn-1", total_tokens: 1100 }],
    }),
  );
  const future = new Date(Date.now() + 60_000);
  await utimes(shard, future, future);

  try {
    const first = await runCli(["sync", "--quiet"], home);
    assert.equal(first.code, 0, first.output);
    const repaired = JSON.parse(await readFile(shard, "utf8"));
    assert.equal(repaired.total_tokens, 3300);
    assert.deepEqual(
      repaired.turns.map((turn) => turn.turn_id),
      ["turn-1", "turn-2"],
    );

    const beforeSecondSync = await stat(shard);
    const second = await runCli(["sync", "--quiet"], home);
    assert.equal(second.code, 0, second.output);
    const afterSecondSync = await stat(shard);
    assert.equal(afterSecondSync.mtimeMs, beforeSecondSync.mtimeMs);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("sync backfills Claude sessions and fingerprints recursive subagent usage", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-usage-stat-claude-sync-"));
  const sessionId = "66666666-6666-6666-6666-666666666666";
  const projectDir = join(home, ".claude", "projects", "test-project");
  const transcript = join(projectDir, `${sessionId}.jsonl`);
  const subagentDir = join(
    projectDir,
    sessionId,
    "subagents",
    "workflows",
    "wf_test",
  );
  const subagent = join(subagentDir, "agent-test.jsonl");
  const dataRoot = join(home, "usage");
  const shard = join(dataRoot, "logbook.d", `${sessionId}.json`);
  const assistant = (id, inputTokens) =>
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-18T00:00:01.000Z",
      cwd: join(home, "project"),
      message: {
        id,
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "done" }],
        usage: { input_tokens: inputTokens, output_tokens: 100 },
      },
    });

  await mkdir(subagentDir, { recursive: true });
  await writeFile(
    join(home, ".agent-usage-stat.config.json"),
    JSON.stringify({ dataRoot }),
  );
  await writeFile(transcript, assistant("main-response", 1000));
  await writeFile(subagent, assistant("subagent-response-1", 2000));

  try {
    const first = await runCli(["sync", "--quiet"], home);
    assert.equal(first.code, 0, first.output);
    const initial = JSON.parse(await readFile(shard, "utf8"));
    assert.equal(initial.provider, "claude");
    assert.equal(initial.total_tokens, 3200);
    assert.match(initial.source_fingerprint, /^claude-usage-/);

    await writeFile(
      shard,
      JSON.stringify({
        ...initial,
        total_cost_usd: 0,
        source_fingerprint: "claude-usage-v1:legacy-pricing",
      }),
    );
    const second = await runCli(["sync", "--quiet"], home);
    assert.equal(second.code, 0, second.output);
    const repriced = JSON.parse(await readFile(shard, "utf8"));
    assert.equal(repriced.total_cost_usd, 0.012);
    assert.match(repriced.source_fingerprint, /^claude-usage-v3:/);

    const beforeThirdSync = await stat(shard);
    const third = await runCli(["sync", "--quiet"], home);
    assert.equal(third.code, 0, third.output);
    const afterThirdSync = await stat(shard);
    assert.equal(afterThirdSync.mtimeMs, beforeThirdSync.mtimeMs);

    await appendFile(
      subagent,
      `\n${assistant("subagent-response-2", 3000)}`,
      "utf8",
    );
    const fourth = await runCli(["sync", "--quiet"], home);
    assert.equal(fourth.code, 0, fourth.output);
    const updated = JSON.parse(await readFile(shard, "utf8"));
    assert.equal(updated.total_tokens, 6300);
    assert.notEqual(updated.source_fingerprint, repriced.source_fingerprint);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("health check validates each shard against its provider pricing", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-usage-stat-health-"));
  const dataRoot = join(home, "usage");
  const shardDir = join(dataRoot, "logbook.d");
  const now = new Date().toISOString();
  const base = {
    end_time: now,
    input_tokens: 1,
    output_tokens: 1,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    total_tokens: 2,
    total_cost_usd: 0.01,
    machine: "test-machine",
  };

  await mkdir(shardDir, { recursive: true });
  await writeFile(
    join(home, ".agent-usage-stat.config.json"),
    JSON.stringify({ dataRoot }),
  );
  await writeFile(
    join(shardDir, "claude.json"),
    JSON.stringify({
      ...base,
      session_id: "claude",
      provider: "claude",
      models: ["claude-sonnet-4-6"],
    }),
  );
  await writeFile(
    join(shardDir, "codex.json"),
    JSON.stringify({
      ...base,
      session_id: "codex",
      provider: "codex",
      models: ["gpt-5.6-sol"],
    }),
  );

  try {
    const result = await runNodeScript("scripts/health-check.mjs", home);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /ok\s+all shard models priced/);
    assert.doesNotMatch(result.output, /codex:gpt-5\.6-sol/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("the package exposes the short aus terminal command", async () => {
  const manifest = JSON.parse(
    await readFile(join(process.cwd(), "package.json"), "utf8"),
  );
  assert.equal(manifest.bin.aus, "bin/agent-usage-stat.js");
  assert.equal(manifest.bin["agent-usage-stat"], manifest.bin.aus);
});

test("one-click portal launchers preserve the persistent server when available", async () => {
  for (const launcher of [
    "portal/Agent-Usage-Stat.bat",
    "portal/Agent-Usage-Stat.command",
  ]) {
    const content = await readFile(join(process.cwd(), launcher), "utf8");
    assert.match(content, /bin[\\/]agent-usage-stat\.js["']? portal/);
    assert.match(content, /127\.0\.0\.1:4179/);
    assert.doesNotMatch(content, /npm run data|npx vite|taskkill|kill \$pids/);
  }
});

test("portal autostart runs a hidden restartable login task", () => {
  const task = portalTaskScript(
    "C:\\Program Files\\nodejs\\node.exe",
    "C:\\tools\\agent-usage-stat\\bin\\agent-usage-stat.js",
  );
  assert.match(task, /New-ScheduledTaskAction/);
  assert.match(task, /agent-usage-stat\.js" portal --no-open --port 4179/);
  assert.match(task, /New-ScheduledTaskTrigger -AtLogOn/);
  assert.match(task, /ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/);
  assert.match(task, /RestartCount 3/);
  assert.match(task, /Start-ScheduledTask/);
});

function runCli(args, home) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(process.cwd(), "bin", "agent-usage-stat.js"), ...args],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          AGENT_USAGE_STAT_SHELL_PROFILE: join(home, "shell-profile.ps1"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}

function runNodeScript(script, home) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(process.cwd(), script)], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}
