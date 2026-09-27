import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readCaptureHealth,
  recordCaptureHealth,
} from "../dist/utils/capture-health.js";

const run = promisify(execFile);

test("hook health distinguishes the latest attempt from the last successful checkpoint", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-usage-stat-hook-health-"));
  const environment = { ...process.env, HOME: home, USERPROFILE: home };
  try {
    await recordCaptureHealth({
      provider: "claude",
      hookEventName: "Stop",
      status: "recorded",
      occurredAt: "2026-08-09T10:00:00.000Z",
    }, environment);
    await recordCaptureHealth({
      provider: "claude",
      hookEventName: "SessionEnd",
      status: "failed",
      message: "transcript disappeared before capture",
      occurredAt: "2026-08-09T11:00:00.000Z",
    }, environment);

    assert.deepEqual(await readCaptureHealth("claude", environment), {
      provider: "claude",
      lastAttemptAt: "2026-08-09T11:00:00.000Z",
      lastAttemptEvent: "SessionEnd",
      lastAttemptStatus: "failed",
      lastSuccessAt: "2026-08-09T10:00:00.000Z",
      lastFailureAt: "2026-08-09T11:00:00.000Z",
      lastFailureMessage: "transcript disappeared before capture",
    });
    assert.equal(await readCaptureHealth("codex", environment), null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a hook for a session that never wrote a transcript records no usage, not a failure", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-usage-stat-empty-session-"));
  const environment = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    AGENT_USAGE_STAT_DIR: undefined,
  };
  try {
    // Claude Code emits SessionEnd for sessions with no turns; the transcript
    // path it reports was never written. Issue #60: each such hook marked the
    // capture health record failed even though no usage exists to lose.
    await mkdir(join(home, ".claude", "projects", "test"), { recursive: true });
    const inputFile = join(home, "hook-input.json");
    await writeFile(inputFile, JSON.stringify({
      session_id: "11111111-2222-3333-4444-555555555555",
      transcript_path: join(
        home, ".claude", "projects", "test",
        "11111111-2222-3333-4444-555555555555.jsonl",
      ),
      hook_event_name: "SessionEnd",
      cwd: home,
    }), "utf8");

    const result = await run(process.execPath, [
      join(process.cwd(), "dist", "helper.js"),
      "capture",
      "--input-file",
      inputFile,
      "--quiet",
    ], { env: environment });
    assert.equal(result instanceof Object, true);

    const health = await readCaptureHealth("claude", environment);
    assert.equal(health.lastAttemptStatus, "no_usage");
    assert.equal(health.lastAttemptEvent, "SessionEnd");
    assert.equal(health.lastFailureAt, undefined);
    assert.equal(health.lastFailureMessage, undefined);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// Issue #102: a capture that fails before any provider is resolved used to
// leave no health record, because the record was filed under the detected
// provider. The installed hook now names its host, and that host owns the
// record whatever detection makes of the payload.
test("a capture whose provider detection throws still files a failed record under the hook's host", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-usage-stat-undetected-"));
  const environment = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    AGENT_USAGE_STAT_DIR: undefined,
  };
  try {
    // A transcript that exists but lies outside every host's data root, so
    // detection has nothing to match it against and throws.
    const transcript = join(home, "elsewhere", "session.jsonl");
    await mkdir(join(home, "elsewhere"), { recursive: true });
    await writeFile(transcript, "{}\n", "utf8");
    const inputFile = join(home, "hook-input.json");
    await writeFile(inputFile, JSON.stringify({
      session_id: "22222222-3333-4444-5555-666666666666",
      transcript_path: transcript,
      hook_event_name: "SessionEnd",
      cwd: home,
    }), "utf8");

    await run(process.execPath, [
      join(process.cwd(), "dist", "helper.js"),
      "capture",
      "--input-file",
      inputFile,
      "--quiet",
      "--host",
      "copilot",
    ], { env: environment }).catch(() => undefined);

    const health = await readCaptureHealth("copilot", environment);
    assert.ok(health, "no health record was filed for the hook's host");
    assert.equal(health.lastAttemptStatus, "failed");
    assert.equal(health.lastAttemptEvent, "SessionEnd");
    assert.ok(health.lastFailureMessage);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a hook whose input is not valid JSON files a failed record under the host the shim forwards", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-usage-stat-bad-input-"));
  const environment = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    AGENT_USAGE_STAT_DIR: undefined,
    AGENT_USAGE_STAT_RUN_ID: undefined,
  };
  try {
    // The installed hook command end to end: the detach shim writes the raw
    // payload to a file and hands it to a detached worker, which cannot parse it.
    const shim = spawnSync(process.execPath, [
      join(process.cwd(), "dist", "helper.js"),
      "capture",
      "--detach",
      "--quiet",
      "--host",
      "codex",
    ], { env: environment, input: '{"hook_event_name": "Stop", "cwd": "C:\\bad"' });
    assert.equal(shim.status, 0);

    let health = null;
    for (let attempt = 0; attempt < 100 && !health; attempt++) {
      health = await readCaptureHealth("codex", environment);
      if (!health) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(health, "no health record was filed for the forwarded host");
    assert.equal(health.lastAttemptStatus, "failed");
    assert.equal(health.lastAttemptEvent, "unknown");
    assert.match(health.lastFailureMessage, /Failed to read hook input/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
