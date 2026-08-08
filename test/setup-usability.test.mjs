import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
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
import { buildPortalData } from "../portal/scripts/build-data.mjs";
import { detectProvider } from "../dist/providers/registry.js";

test("installed agents are inferred without a provider setting", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-usage-stat-detect-"));
  const claudeHome = join(home, "custom-claude-home");
  const copilotHome = join(home, "custom-copilot-home");
  await mkdir(claudeHome);
  await mkdir(copilotHome);

  try {
    const agents = detectInstalledAgents(
      home,
      (command) => command === "codex",
      { CLAUDE_CONFIG_DIR: claudeHome, COPILOT_HOME: copilotHome },
    );
    assert.deepEqual(agents, ["claude", "codex", "copilot"]);
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
    await mkdir(join(home, ".copilot"));

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
      const copilotHooks = JSON.parse(
        await readFile(
          join(home, ".copilot", "hooks", "agent-usage-stat.json"),
          "utf8",
        ),
      );
      assert.equal(config.dataRoot, dataRoot);
      assert.equal(codexHooks.includes("--provider"), false);
      assert.equal(copilotHooks.version, 1);
      assert.equal(copilotHooks.hooks.SessionEnd.length, 1);
      assert.match(copilotHooks.hooks.SessionEnd[0].powershell, /capture --detach --quiet/);
      await readFile(join(home, ".claude", "settings.json"), "utf8");
      const shellProfile = await readFile(
        join(home, "shell-profile.ps1"),
        "utf8",
      );
      assert.match(shellProfile, /function global:claude/);
      assert.match(shellProfile, /function global:codex/);
      assert.match(shellProfile, /function global:claudex/);
      assert.match(shellProfile, /function global:copilot/);

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

test(
  "import-on-open setup removes automatic capture connections",
  { skip: !["win32", "darwin"].includes(process.platform) },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-usage-stat-hookless-"));
    const dataRoot = join(home, "usage");
    const claudeSettings = join(home, ".claude", "settings.json");
    const codexHooks = join(home, ".codex", "hooks.json");
    const copilotHook = join(
      home,
      ".copilot",
      "hooks",
      "agent-usage-stat.json",
    );
    const shellProfile = join(home, "shell-profile.ps1");
    await mkdir(join(home, ".claude"));
    await mkdir(join(home, ".codex"));
    await mkdir(join(home, ".copilot"));

    try {
      const automatic = await runCli(["setup", "--data-root", dataRoot], home);
      assert.equal(automatic.code, 0, automatic.output);
      assert.equal(existsSync(copilotHook), true);
      assert.match(await readFile(shellProfile, "utf8"), /function global:codex/);

      const configured = await runCli(
        ["config", "--set", "captureMode=on-open"],
        home,
      );
      assert.equal(configured.code, 0, configured.output);

      const hookless = await runCli(["setup", "--data-root", dataRoot], home);
      assert.equal(hookless.code, 0, hookless.output);
      assert.doesNotMatch(
        await readFile(claudeSettings, "utf8"),
        /agent-usage-stat/,
      );
      assert.doesNotMatch(await readFile(codexHooks, "utf8"), /agent-usage-stat/);
      assert.equal(existsSync(copilotHook), false);
      assert.doesNotMatch(await readFile(shellProfile, "utf8"), /Agent Usage Stat/);

      await runCli(["config", "--set", "captureMode=automatic"], home);
      const restored = await runCli(["setup", "--data-root", dataRoot], home);
      assert.equal(restored.code, 0, restored.output);
      assert.match(await readFile(claudeSettings, "utf8"), /agent-usage-stat/);
      assert.match(await readFile(codexHooks, "utf8"), /agent-usage-stat/);
      assert.equal(existsSync(copilotHook), true);
      assert.match(await readFile(shellProfile, "utf8"), /Agent Usage Stat/);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

test(
  "custom provider roots drive hook setup and transcript reconciliation",
  { skip: !["win32", "darwin"].includes(process.platform) },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-usage-stat-provider-roots-"));
    const dataRoot = join(home, "usage");
    const claudeHome = join(home, "agent-data", "claude");
    const codexHome = join(home, "agent-data", "codex");
    const copilotHome = join(home, "agent-data", "copilot");
    const sessionId = "77777777-7777-7777-7777-777777777777";
    const sessionDir = join(codexHome, "sessions", "2026", "08", "08");
    const rollout = join(
      sessionDir,
      `rollout-2026-08-08T10-00-00-${sessionId}.jsonl`,
    );
    const line = (type, payload, timestamp) =>
      JSON.stringify({ type, payload, timestamp });

    await Promise.all([
      mkdir(claudeHome, { recursive: true }),
      mkdir(sessionDir, { recursive: true }),
      mkdir(copilotHome, { recursive: true }),
    ]);
    await writeFile(
      join(home, ".agent-usage-stat.config.json"),
      JSON.stringify({
        version: "3.0.0",
        dataRoot,
        providerDataRoots: {
          claude: claudeHome,
          codex: codexHome,
          copilot: copilotHome,
        },
      }),
    );
    await writeFile(
      rollout,
      [
        line(
          "session_meta",
          { id: sessionId, cwd: join(home, "project") },
          "2026-08-08T10:00:00.000Z",
        ),
        line(
          "turn_context",
          { turn_id: "turn-1", model: "gpt-5.6-sol" },
          "2026-08-08T10:00:01.000Z",
        ),
        line(
          "event_msg",
          {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 1000,
                cached_input_tokens: 400,
                output_tokens: 100,
                total_tokens: 1100,
              },
              last_token_usage: {
                input_tokens: 1000,
                cached_input_tokens: 400,
                output_tokens: 100,
                total_tokens: 1100,
              },
            },
          },
          "2026-08-08T10:00:02.000Z",
        ),
      ].join("\n"),
    );

    try {
      const setup = await runCli(["setup", "--data-root", dataRoot], home);
      assert.equal(setup.code, 0, setup.output);
      assert.match(
        await readFile(join(claudeHome, "settings.json"), "utf8"),
        /agent-usage-stat/,
      );
      assert.match(
        await readFile(join(codexHome, "hooks.json"), "utf8"),
        /agent-usage-stat/,
      );
      assert.equal(
        existsSync(join(copilotHome, "hooks", "agent-usage-stat.json")),
        true,
      );

      const sync = await runCli(["sync", "--quiet"], home);
      assert.equal(sync.code, 0, sync.output);
      const shard = JSON.parse(await readFile(
        join(dataRoot, "logbook.d", `${sessionId}.json`),
        "utf8",
      ));
      assert.equal(shard.provider, "codex");
      assert.equal(shard.total_tokens, 1100);
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

test("an unchanged shard is reused from the portal snapshot cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-usage-stat-cache-"));
  const outDir = join(root, "portal");
  const shardDir = join(root, "logbook.d");
  await mkdir(shardDir);
  await writeFile(
    join(shardDir, "cached-session.json"),
    JSON.stringify({
      session_id: "cached-session",
      provider: "codex",
      start_time: "2026-08-01T12:00:00.000Z",
      end_time: "2026-08-01T12:05:00.000Z",
      project: "cache-test",
      machine: "test-machine",
      total_tokens: 1200,
      total_cost_usd: 0.12,
      models: ["gpt-5.6-sol"],
    }),
  );

  try {
    const first = await buildPortalData({ root, outDir });
    const second = await buildPortalData({ root, outDir });
    const sessions = JSON.parse(
      await readFile(join(outDir, "sessions.json"), "utf8"),
    );

    assert.equal(first.parsedShards, 1);
    assert.equal(first.reusedShards, 0);
    assert.equal(second.parsedShards, 0);
    assert.equal(second.reusedShards, 1);
    assert.deepEqual(
      sessions.map((session) => [session.sid, session.cost]),
      [["cached-session", 0.12]],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a changed shard replaces its cached normalized session", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-usage-stat-cache-change-"));
  const outDir = join(root, "portal");
  const shardDir = join(root, "logbook.d");
  const shard = join(shardDir, "changed-session.json");
  await mkdir(shardDir);
  const record = {
    session_id: "changed-session",
    provider: "claude",
    start_time: "2026-08-02T12:00:00.000Z",
    end_time: "2026-08-02T12:05:00.000Z",
    project: "cache-test",
    machine: "test-machine",
    total_tokens: 1200,
    total_cost_usd: 0.12,
    models: ["claude-opus-5"],
  };
  await writeFile(shard, JSON.stringify(record));

  try {
    await buildPortalData({ root, outDir });
    await writeFile(shard, JSON.stringify({ ...record, total_cost_usd: 0.24 }));
    const future = new Date(Date.now() + 5000);
    await utimes(shard, future, future);

    const changed = await buildPortalData({ root, outDir });
    const sessions = JSON.parse(
      await readFile(join(outDir, "sessions.json"), "utf8"),
    );

    assert.equal(changed.parsedShards, 1);
    assert.equal(changed.reusedShards, 0);
    assert.equal(sessions[0].cost, 0.24);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a deleted shard is removed from the cached portal snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-usage-stat-cache-delete-"));
  const outDir = join(root, "portal");
  const shardDir = join(root, "logbook.d");
  const shard = join(shardDir, "deleted-session.json");
  await mkdir(shardDir);
  await writeFile(
    shard,
    JSON.stringify({
      session_id: "deleted-session",
      provider: "copilot",
      start_time: "2026-08-03T12:00:00.000Z",
      total_tokens: 800,
      total_cost_usd: 0.08,
      models: ["gpt-5.4"],
    }),
  );

  try {
    await buildPortalData({ root, outDir });
    await rm(shard);

    const deleted = await buildPortalData({ root, outDir });
    const sessions = JSON.parse(
      await readFile(join(outDir, "sessions.json"), "utf8"),
    );

    assert.equal(deleted.sessions, 0);
    assert.deepEqual(sessions, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a temporarily unreadable changed shard preserves its last valid result", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-usage-stat-cache-recovery-"));
  const outDir = join(root, "portal");
  const shardDir = join(root, "logbook.d");
  const shard = join(shardDir, "recoverable-session.json");
  await mkdir(shardDir);
  await writeFile(
    shard,
    JSON.stringify({
      session_id: "recoverable-session",
      provider: "codex",
      start_time: "2026-08-04T12:00:00.000Z",
      total_tokens: 900,
      total_cost_usd: 0.09,
      models: ["gpt-5.6-sol"],
    }),
  );

  try {
    await buildPortalData({ root, outDir });
    await writeFile(shard, "{not-json");
    const future = new Date(Date.now() + 5000);
    await utimes(shard, future, future);

    const recovered = await buildPortalData({ root, outDir });
    const sessions = JSON.parse(
      await readFile(join(outDir, "sessions.json"), "utf8"),
    );

    assert.equal(recovered.sessions, 1);
    assert.equal(sessions[0].sid, "recoverable-session");
    assert.equal(sessions[0].cost, 0.09);
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
    assert.match(repriced.source_fingerprint, /^claude-usage-v4:/);

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

test("the root manifest is a private desktop application", async () => {
  const manifest = JSON.parse(
    await readFile(join(process.cwd(), "package.json"), "utf8"),
  );
  assert.equal(manifest.private, true);
  assert.equal(manifest.productName, "Agent Usage Stat");
  assert.equal(manifest.main, "./dist/desktop/main.js");
  assert.equal(manifest.bin, undefined);
  assert.equal(manifest.types, undefined);
});

test("the internal helper version follows the application manifest", async () => {
  const manifest = JSON.parse(
    await readFile(join(process.cwd(), "package.json"), "utf8"),
  );
  const result = await runCli(["--version"], process.cwd());
  assert.equal(result.code, 0, result.output);
  assert.equal(result.output.trim(), manifest.version);
});

function runCli(args, home) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(process.cwd(), "dist", "helper.js"), ...args],
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
