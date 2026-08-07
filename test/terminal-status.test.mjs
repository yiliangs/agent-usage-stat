import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import {
  createAgentRun,
  createCorrelatedInputPath,
  publishCaptureOutcome,
  readRunSnapshot,
  removeAgentRun,
  waitForAgentRun,
} from "../dist/utils/capture-run.js";
import { formatRunMessage } from "../dist/commands/run.js";
import {
  installTerminalWrappers,
  removeTerminalWrappers,
} from "../dist/core/terminal-wrappers.js";

const root = process.cwd();

test("capture runs correlate pending input with an atomic terminal result", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-usage-stat-run-"));
  const environment = { HOME: home, USERPROFILE: home };
  const run = await createAgentRun("claude", environment);

  try {
    assert.equal(createCorrelatedInputPath("../bad", "capture123", environment), null);
    assert.equal(createCorrelatedInputPath(run.manifest.run_id, "bad", environment), null);

    const inputPath = createCorrelatedInputPath(
      run.manifest.run_id,
      "capture123",
      environment,
    );
    assert.ok(inputPath);
    await writeFile(inputPath, "{}", "utf8");

    const published = await publishCaptureOutcome(
      inputPath,
      {
        status: "recorded",
        project: "terminal-test",
        total_tokens: 1_234_567,
        total_cost_usd: 1.25,
        shard_path: join(home, "usage", "logbook.d", "session.json"),
      },
      { provider: "claude", sessionId: "session-1" },
      environment,
    );
    assert.equal(published, true);

    const snapshot = await readRunSnapshot(run);
    assert.deepEqual(snapshot.pendingCaptureIds, ["capture123"]);
    assert.deepEqual(snapshot.unresolvedCaptureIds, []);
    assert.equal(snapshot.results[0].status, "recorded");
    assert.equal(snapshot.results[0].total_tokens, 1_234_567);
    assert.equal(snapshot.results[0].total_cost_usd, 1.25);
  } finally {
    await removeAgentRun(run);
    await rm(home, { recursive: true, force: true });
  }
});

test("run settling waits for delayed pending work and a quiet period", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-usage-stat-settle-"));
  const environment = { HOME: home, USERPROFILE: home };
  const run = await createAgentRun("codex", environment);
  const inputPath = createCorrelatedInputPath(
    run.manifest.run_id,
    "capture456",
    environment,
  );
  assert.ok(inputPath);
  await writeFile(inputPath, "{}", "utf8");

  const publish = new Promise((resolve, reject) => {
    setTimeout(async () => {
      try {
        await publishCaptureOutcome(
          inputPath,
          { status: "no_usage", reason: "zero_tokens" },
          { provider: "codex" },
          environment,
        );
        await unlink(inputPath);
        resolve();
      } catch (error) {
        reject(error);
      }
    }, 30);
  });

  try {
    const settled = await waitForAgentRun(run, {
      pollMs: 5,
      quietMs: 25,
      timeoutMs: 500,
    });
    await publish;
    assert.equal(settled.timedOut, false);
    assert.deepEqual(settled.unresolvedCaptureIds, []);
    assert.equal(settled.results[0].status, "no_usage");
  } finally {
    await removeAgentRun(run);
    await rm(home, { recursive: true, force: true });
  }
});

test("terminal message aggregation never overclaims incomplete work", () => {
  const recorded = {
    schema_version: 1,
    run_id: "12345678",
    capture_id: "capture123",
    completed_at: "2026-07-20T00:00:00.000Z",
    status: "recorded",
    provider: "claude",
    project: "natalie",
    total_tokens: 18_562_108,
    total_cost_usd: 42.678,
    shard_path: "usage.json",
  };
  const base = {
    results: [recorded],
    pendingCaptureIds: [],
    unresolvedCaptureIds: [],
    signature: "",
    timedOut: false,
  };

  assert.equal(
    formatRunMessage(base),
    "[Agent Usage Stat] Usage recorded: Claude, 18.6M tokens, $42.68, natalie",
  );
  assert.match(
    formatRunMessage({ ...base, timedOut: true }),
    /could not be verified/,
  );
  assert.equal(
    formatRunMessage({
      ...base,
      results: [{ ...recorded, status: "failed", message: "boom" }],
    }),
    "[Agent Usage Stat] Failed to record usage.",
  );
  assert.equal(
    formatRunMessage({ ...base, results: [] }),
    null,
  );
});

test("shell wrapper blocks are idempotent and reversible", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-usage-stat-profile-"));
  const profile = {
    kind: "powershell",
    path: join(home, "PowerShell", "profile.ps1"),
  };
  const original = [
    "# user profile",
    "$env:EXISTING = 'kept'",
    "function claudex {",
    "  claude @args",
    "}",
    "",
  ].join("\n");
  await mkdir(join(home, "PowerShell"));
  await writeFile(profile.path, original, "utf8");

  try {
    const cliPath = join(root, "bin", "agent-usage-stat.js");
    await installTerminalWrappers(profile, cliPath);
    let content = await readFile(profile.path, "utf8");
    assert.match(content, /function global:claude/);
    assert.match(content, /function global:codex/);
    assert.match(content, /function global:claudex/);
    assert.match(content, /Test-Path Function:\\claudex/);
    assert.match(content, /function claudex \{/);

    await installTerminalWrappers(profile, cliPath);
    const repeated = await readFile(profile.path, "utf8");
    assert.equal(repeated, content);

    await removeTerminalWrappers(profile);
    content = await readFile(profile.path, "utf8");
    assert.equal(content, original);

    const helperPath = join(home, "bin", "agent-usage-stat-helper.exe");
    await installTerminalWrappers(profile, helperPath, false);
    content = await readFile(profile.path, "utf8");
    assert.match(content, /agent-usage-stat-helper\.exe' run claude/);
    assert.doesNotMatch(content, /& node .*agent-usage-stat-helper/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("zsh and bash wrapper blocks preserve unrelated profile content", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-usage-stat-posix-profile-"));
  const cliPath = join(root, "bin", "agent-usage-stat.js");
  const original = "export EXISTING=value\n";

  try {
    for (const kind of ["zsh", "bash"]) {
      const profile = { kind, path: join(home, `${kind}rc`) };
      await writeFile(profile.path, original, "utf8");
      await installTerminalWrappers(profile, cliPath);
      const content = await readFile(profile.path, "utf8");
      assert.match(content, /claude\(\)/);
      assert.match(content, /codex\(\)/);
      assert.match(content, /typeset -f claudex/);
      await removeTerminalWrappers(profile);
      assert.equal(await readFile(profile.path, "utf8"), original);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("invalid explicit hook input publishes failure instead of manual capture", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-usage-stat-invalid-input-"));
  const environment = { ...process.env, HOME: home, USERPROFILE: home };
  const run = await createAgentRun("claude", environment);
  const inputPath = createCorrelatedInputPath(
    run.manifest.run_id,
    "capture789",
    environment,
  );
  assert.ok(inputPath);
  await writeFile(inputPath, "not-json", "utf8");

  try {
    const result = await runCli(
      ["capture", "--input-file", inputPath, "--quiet"],
      {
        ...environment,
        AGENT_USAGE_STAT_RUN_ID: run.manifest.run_id,
      },
    );
    assert.equal(result.code, 1);
    const snapshot = await readRunSnapshot(run);
    assert.equal(snapshot.results[0].status, "failed");
    assert.match(snapshot.results[0].message, /Failed to read hook input/);
    assert.deepEqual(snapshot.pendingCaptureIds, []);
  } finally {
    await removeAgentRun(run);
    await rm(home, { recursive: true, force: true });
  }
});

test("runner preserves arguments, environment, and exit code for Claude launchers", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-usage-stat-runner-"));
  const bin = join(home, "bin");
  const helper = join(home, "fake-agent.mjs");
  await writeFile(
    helper,
    `import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
const runId = process.env.AGENT_USAGE_STAT_RUN_ID;
const captureId = "capture999";
const run = join(process.env.HOME, ".agent-usage-stat", "runs", runId);
await mkdir(join(run, "pending"), { recursive: true });
await mkdir(join(run, "results"), { recursive: true });
const pending = join(run, "pending", captureId + ".json");
await writeFile(pending, "{}");
const result = {
  schema_version: 1,
  run_id: runId,
  capture_id: captureId,
  completed_at: new Date().toISOString(),
  status: "recorded",
  provider: "claude",
  project: "fake-project",
  total_tokens: 1234567,
  total_cost_usd: 1.2532,
  shard_path: "fake-shard.json"
};
const temp = join(run, "results", captureId + ".tmp");
const final = join(run, "results", captureId + ".json");
await writeFile(temp, JSON.stringify(result));
await rename(temp, final);
await unlink(pending);
process.stdout.write(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), correlated: !!runId }));
process.exit(7);
`,
    "utf8",
  );
  await createLaunchers(bin, helper, ["claude", "claudex"]);

  try {
    for (const command of ["claude", "claudex"]) {
      const result = await runCli(
        ["run", command, "--", "hello world", "a&b", "--flag=value"],
        {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          PATH: `${bin}${delimiter}${process.env.PATH || ""}`,
        },
      );
      assert.equal(result.code, 7, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout).args, [
        "hello world",
        "a&b",
        "--flag=value",
      ]);
      assert.equal(JSON.parse(result.stdout).correlated, true);
      assert.match(
        result.stderr,
        /Usage recorded: Claude, 1\.2M tokens, \$1\.25, fake-project/,
      );
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

async function createLaunchers(bin, helper, commands) {
  await import("node:fs/promises").then(({ mkdir }) => mkdir(bin, { recursive: true }));
  for (const command of commands) {
    if (process.platform === "win32") {
      await writeFile(
        join(bin, `${command}.cmd`),
        `@echo off\r\n"${process.execPath}" "${helper}" %*\r\nexit /b %ERRORLEVEL%\r\n`,
        "utf8",
      );
    } else {
      const path = join(bin, command);
      await writeFile(
        path,
        `#!/bin/sh\nexec "${process.execPath}" "${helper}" "$@"\n`,
        "utf8",
      );
      await chmod(path, 0o755);
    }
  }
}

function runCli(args, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(root, "dist", "helper.js"), ...args],
      {
        cwd: root,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
