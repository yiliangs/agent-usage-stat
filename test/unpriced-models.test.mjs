import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LogbookWriter } from "../dist/core/logbook-writer.js";
import { buildPortalData } from "../dist/desktop/portal-data.js";
import { isUnpriced, summarizeUsage } from "../portal/usage-model.js";

/**
 * A model that no baked table and no feed entry prices is billed at $0. The
 * shard and the snapshot must say so, or an unpriced session reads as a free
 * one (#108). The marker is provider-neutral: every reader fills
 * `ProviderSessionSnapshot.unknownModels`, and nothing downstream of it asks
 * which provider produced the session.
 */

async function withRoot(run) {
  const root = await mkdtemp(join(tmpdir(), "agent-usage-stat-unpriced-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function snapshot(provider, unknownModels) {
  return {
    sessionData: {
      provider,
      sessionId: `unpriced-${provider}`,
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 1500,
      totalCost: 0,
      sourceFingerprint: "fingerprint",
      modelBreakdowns: [{
        modelName: "claude-mythos-5",
        inputTokens: 1000,
        outputTokens: 500,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        cost: 0,
      }],
    },
    transcriptData: {
      sessionSlug: "unpriced",
      firstPrompt: "work",
      startTime: new Date("2026-08-10T10:00:00.000Z"),
      endTime: new Date("2026-08-10T10:10:00.000Z"),
      userMessageCount: 1,
      assistantMessageCount: 1,
      cwd: "C:/work/unpriced",
      gitBranch: "main",
    },
    unknownModels,
  };
}

for (const provider of ["claude", "codex", "copilot", "opencode"]) {
  test(`a ${provider} shard names the models no pricing source covered`, async () => {
    await withRoot(async (root) => {
      const shard = await new LogbookWriter().append(
        root,
        snapshot(provider, ["claude-mythos-5", "claude-mythos-5"]),
      );
      const record = JSON.parse(await readFile(shard, "utf8"));
      assert.equal(record.total_cost_usd, 0);
      assert.deepEqual(record.unpriced_models, ["claude-mythos-5"]);
    });
  });
}

test("a fully priced shard records an empty unpriced list, not an absent one", async () => {
  await withRoot(async (root) => {
    const shard = await new LogbookWriter().append(root, snapshot("claude", []));
    const record = JSON.parse(await readFile(shard, "utf8"));
    assert.deepEqual(record.unpriced_models, []);
  });
});

function shard(sessionId, extra) {
  return {
    timestamp: "2026-08-10T10:10:00.000Z",
    session_slug: sessionId,
    session_id: sessionId,
    project: "Project",
    branch: "main",
    cwd: "C:/work/project",
    machine: "machine",
    start_time: "2026-08-10T10:00:00.000Z",
    end_time: "2026-08-10T10:10:00.000Z",
    duration_seconds: 600,
    duration_human: "10m",
    input_tokens: 1000,
    output_tokens: 500,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    total_tokens: 1500,
    total_cost_usd: 0,
    models: ["claude-mythos-5"],
    provider: "claude",
    ...extra,
  };
}

test("the snapshot carries the unpriced marker, and a legacy shard reads as none", async () => {
  await withRoot(async (root) => {
    const shardDir = join(root, "logbook.d");
    const outDir = join(root, "portal");
    await mkdir(shardDir);
    await writeFile(
      join(shardDir, "unpriced.json"),
      JSON.stringify(shard("unpriced", { unpriced_models: ["claude-mythos-5", 7, ""] })),
    );
    await writeFile(join(shardDir, "legacy.json"), JSON.stringify(shard("legacy", {})));

    await buildPortalData({ root, outDir });
    const sessions = JSON.parse(await readFile(join(outDir, "sessions.json"), "utf8"));
    const bySid = Object.fromEntries(sessions.map((session) => [session.sid, session]));

    assert.deepEqual(bySid.unpriced.unpricedModels, ["claude-mythos-5"]);
    assert.deepEqual(bySid.legacy.unpricedModels, []);
    assert.equal(bySid.unpriced.cost, 0, "no cost is fabricated for the unpriced model");
  });
});

test("usage-model marks unpriced sessions without charging them", () => {
  const sessions = [
    { cost: 2, totalTokens: 10, unpricedModels: [] },
    { cost: 0, totalTokens: 10, unpricedModels: ["claude-mythos-5"] },
    { cost: 1, totalTokens: 10 },
  ];
  assert.equal(isUnpriced(sessions[0]), false);
  assert.equal(isUnpriced(sessions[1]), true);
  assert.equal(isUnpriced(sessions[2]), false);
  const summary = summarizeUsage(sessions);
  assert.equal(summary.cost, 3, "the unpriced session adds nothing to the total");
});
