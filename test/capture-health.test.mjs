import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readCaptureHealth,
  recordCaptureHealth,
} from "../dist/utils/capture-health.js";

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
