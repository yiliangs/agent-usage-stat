import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SyncCommand } from "../dist/commands/sync.js";

const SESSION_COUNT = 12;

test("sync overlaps read-only preflight but serializes provider calculation", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-usage-stat-sync-"));
  const dataRoot = join(home, "usage");
  const shardDir = join(dataRoot, "logbook.d");
  const priorHome = process.env.HOME;
  const priorUserProfile = process.env.USERPROFILE;
  const priorClaudeConfig = process.env.CLAUDE_CONFIG_DIR;
  const priorCodexHome = process.env.CODEX_HOME;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
  process.env.CODEX_HOME = join(home, ".codex");

  await mkdir(shardDir, { recursive: true });
  await writeFile(
    join(home, ".agent-usage-stat.config.json"),
    JSON.stringify({ dataRoot }),
  );

  const activity = {
    fingerprints: 0,
    maxFingerprints: 0,
    calculations: 0,
    maxCalculations: 0,
  };
  const provider = fakeProvider(activity);

  try {
    const command = new SyncCommand({ providers: [provider] });
    const updated = await command.execute({ quiet: true });

    assert.equal(updated, SESSION_COUNT);
    assert.ok(
      activity.maxFingerprints > 1,
      `expected overlapping fingerprints, observed ${activity.maxFingerprints}`,
    );
    assert.ok(
      activity.maxFingerprints < SESSION_COUNT,
      `expected bounded fingerprints, observed ${activity.maxFingerprints}`,
    );
    assert.equal(activity.maxCalculations, 1);
  } finally {
    restoreEnv("HOME", priorHome);
    restoreEnv("USERPROFILE", priorUserProfile);
    restoreEnv("CLAUDE_CONFIG_DIR", priorClaudeConfig);
    restoreEnv("CODEX_HOME", priorCodexHome);
    await rm(home, { recursive: true, force: true });
  }
});

function fakeProvider(activity) {
  const sessions = Array.from({ length: SESSION_COUNT }, (_, index) => ({
    sessionId: `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`,
    transcriptPath: `session-${index}.jsonl`,
    projectPath: `project/session-${index}`,
    mtimeMs: index,
  }));

  return {
    name: "claude",
    findSession: async () => sessions[0],
    findAllSessions: async () => sessions,
    fingerprintSession: async (session) => {
      activity.fingerprints++;
      activity.maxFingerprints = Math.max(
        activity.maxFingerprints,
        activity.fingerprints,
      );
      await delay(10);
      activity.fingerprints--;
      return `fingerprint:${session.sessionId}`;
    },
    readSession: async (_path, sessionId) => {
      activity.calculations++;
      activity.maxCalculations = Math.max(
        activity.maxCalculations,
        activity.calculations,
      );
      await delay(5);
      activity.calculations--;
      return {
        sessionData: {
          provider: "claude",
          sessionId,
          inputTokens: 100,
          outputTokens: 10,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          totalTokens: 110,
          totalCost: 0.01,
          modelBreakdowns: [],
          sourceFingerprint: `fingerprint:${sessionId}`,
        },
        transcriptData: {
          sessionSlug: sessionId.slice(0, 8),
          firstPrompt: "test",
          startTime: new Date("2026-07-30T12:00:00.000Z"),
          endTime: new Date("2026-07-30T12:01:00.000Z"),
          userMessageCount: 1,
          assistantMessageCount: 1,
          totalMessages: 2,
          projectName: "sync-test",
        },
        unknownModels: [],
      };
    },
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
