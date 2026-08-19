import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
