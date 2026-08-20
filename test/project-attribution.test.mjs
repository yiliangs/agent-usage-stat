import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LogbookWriter } from "../dist/core/logbook-writer.js";
import { buildPortalData } from "../dist/desktop/portal-data.js";

/**
 * A session run inside a git worktree belongs to the project the worktree was
 * cut from, not to the worktree directory. The layouts below are the ones the
 * agent CLIs actually create, so each expected project comes from the tool's
 * own convention rather than from re-running the resolver:
 *
 *   Claude Code  <project>/.claude/worktrees/<worktree>
 *   T3 Code      ~/.t3/worktrees/<project>/<worktree>
 *   Codex        ~/.codex/worktrees/<number>/<project>
 *
 * `recorded` is the name the old last-segment rule wrote to disk, spelled out
 * rather than recomputed, so the shard fixtures below reproduce the ledger as
 * it stands today.
 */
const WORKTREE_CASES = [
  {
    label: "Claude Code cuts worktrees inside the project checkout",
    cwd: "C:\\Users\\y\\source\\repos\\natalie\\.claude\\worktrees\\issue-468-835273",
    recorded: "issue-468-835273",
    project: "natalie",
  },
  {
    label: "a subdirectory of a Claude Code worktree stays with the project",
    cwd: "C:\\Users\\y\\source\\repos\\natalie\\.claude\\worktrees\\issue-468-835273\\web",
    recorded: "web",
    project: "natalie",
  },
  {
    label: "T3 Code keeps one machine-global store grouped by project",
    cwd: "C:\\Users\\y\\.t3\\worktrees\\claude-channel\\t3code-a09dee1e",
    recorded: "t3code-a09dee1e",
    project: "claude-channel",
  },
  {
    label: "a POSIX T3 store resolves the same way as a Windows one",
    cwd: "/Users/y/.t3/worktrees/agent-usage-stat/t3code-538f0bf7",
    recorded: "t3code-538f0bf7",
    project: "agent-usage-stat",
  },
  {
    label: "Codex names the checkout itself for the project",
    cwd: "C:\\Users\\y\\.codex\\worktrees\\5604\\natalie",
    recorded: "natalie",
    project: "natalie",
  },
  {
    label: "a plain checkout is its own project",
    cwd: "C:\\Users\\y\\source\\repos\\natalie",
    recorded: "natalie",
    project: "natalie",
  },
];

function sessionData(sessionId) {
  return {
    provider: "claude",
    sessionId,
    inputTokens: 90,
    outputTokens: 10,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 100,
    totalCost: 1,
    sourceFingerprint: `fingerprint-${sessionId}`,
    modelBreakdowns: [],
  };
}

function transcriptData(cwd) {
  return {
    sessionSlug: "worktree-session",
    firstPrompt: "work",
    startTime: new Date("2026-08-10T10:00:00.000Z"),
    endTime: new Date("2026-08-10T10:10:00.000Z"),
    userMessageCount: 1,
    assistantMessageCount: 1,
    totalMessages: 2,
    cwd,
  };
}

test("a captured session records the project its worktree belongs to", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-usage-stat-attribution-"));
  const writer = new LogbookWriter();

  try {
    for (const [index, expected] of WORKTREE_CASES.entries()) {
      const shard = await writer.append(root, {
        sessionData: sessionData(`session-${index}`),
        transcriptData: transcriptData(expected.cwd),
      });
      const record = JSON.parse(await readFile(shard, "utf8"));

      assert.equal(record.project, expected.project, expected.label);
      assert.equal(record.cwd, expected.cwd, "the raw path stays recorded");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recorded worktree sessions rejoin their project in the portal snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-usage-stat-attribution-"));
  const shardDir = join(root, "logbook.d");
  const outDir = join(root, "portal");
  await mkdir(shardDir);

  await Promise.all(
    WORKTREE_CASES.map((expected, index) =>
      writeFile(
        join(shardDir, `worktree-${index}.json`),
        JSON.stringify({
          session_slug: `worktree-${index}`,
          session_id: `worktree-${index}`,
          project: expected.recorded,
          cwd: expected.cwd,
          machine: "machine-a",
          start_time: "2026-08-10T10:00:00.000Z",
          end_time: "2026-08-10T10:10:00.000Z",
          duration_seconds: 600,
          input_tokens: 90,
          output_tokens: 10,
          total_tokens: 100,
          total_cost_usd: 1,
          models: ["claude-opus-5"],
          provider: "claude",
        }),
      ),
    ),
  );

  // A path that is no worktree proves nothing about the recorded name, so the
  // record's own claim has to survive untouched even when it disagrees with
  // the directory it ran in.
  await writeFile(
    join(shardDir, "recorded-name.json"),
    JSON.stringify({
      session_slug: "recorded-name",
      session_id: "recorded-name",
      project: "Current Project",
      cwd: "C:/work/current",
      machine: "machine-a",
      start_time: "2026-08-10T11:00:00.000Z",
      end_time: "2026-08-10T11:10:00.000Z",
      duration_seconds: 600,
      input_tokens: 90,
      output_tokens: 10,
      total_tokens: 100,
      total_cost_usd: 1,
      models: ["claude-opus-5"],
      provider: "claude",
    }),
  );

  try {
    await buildPortalData({ root, outDir });
    const sessions = JSON.parse(
      await readFile(join(outDir, "sessions.json"), "utf8"),
    );
    const projectOf = new Map(
      sessions.map((session) => [session.sid, session.project]),
    );

    for (const [index, expected] of WORKTREE_CASES.entries()) {
      assert.equal(
        projectOf.get(`worktree-${index}`),
        expected.project,
        expected.label,
      );
    }
    assert.equal(projectOf.get("recorded-name"), "Current Project");

    // Four of the six worktree sessions belong to natalie, so the panel counts
    // one project for them instead of one row each.
    const meta = JSON.parse(await readFile(join(outDir, "meta.json"), "utf8"));
    assert.equal(meta.sessions, 7);
    assert.equal(meta.projects, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
