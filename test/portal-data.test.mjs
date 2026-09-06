import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildPortalData } from "../dist/desktop/portal-data.js";

test("portal artifacts preserve the exact current and legacy ledger boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-usage-stat-portal-golden-"));
  const shardDir = join(root, "logbook.d");
  const outDir = join(root, "portal");
  const currentPath = join(shardDir, "01-current.json");
  const legacyPath = join(shardDir, "02-legacy.json");
  await mkdir(shardDir);

  const currentRecord = {
    timestamp: "2026-08-10T10:01:30.000Z",
    session_slug: "current-mixed",
    session_id: "current-session",
    project: " Current Project ",
    branch: " main ",
    cwd: "C:/work/current",
    machine: " machine-a ",
    start_time: "2026-08-10T10:00:00.000Z",
    end_time: "2026-08-10T10:01:30.000Z",
    duration_seconds: 90,
    duration_human: "1m 30s",
    input_tokens: 100,
    output_tokens: 50,
    cache_creation_tokens: 20,
    cache_read_tokens: 30,
    total_tokens: 200,
    total_cost_usd: 1.25,
    models: ["claude-opus-5", "gpt-5.6-sol"],
    model_breakdowns: [
      {
        model: "claude-opus-5",
        vendor: "anthropic",
        input_tokens: 60,
        output_tokens: 30,
        cache_creation_tokens: 10,
        cache_read_tokens: 20,
        total_tokens: 120,
        total_cost_usd: 0.75,
      },
      {
        model: "gpt-5.6-sol",
        vendor: "openai",
        input_tokens: 40,
        output_tokens: 20,
        cache_creation_tokens: 10,
        cache_read_tokens: 10,
        total_tokens: 80,
        total_cost_usd: 0.5,
      },
    ],
    turns: [
      {
        turn_id: "current-turn",
        start_time: "2026-08-10T10:00:00.000Z",
        end_time: "2026-08-10T10:00:45.000Z",
        input_tokens: 60,
        output_tokens: 20,
        cache_creation_tokens: 10,
        cache_read_tokens: 10,
        total_tokens: 100,
        total_cost_usd: 0.6,
        models: ["claude-opus-5", "gpt-5.6-sol"],
      },
    ],
    source_fingerprint: "current:fingerprint",
    provider: "claude",
  };
  const legacyRecord = {
    session_slug: "",
    session_id: "legacy-session",
    project: " Legacy Project ",
    branch: " legacy ",
    machine: " machine-b ",
    start_time: "2026-08-10T12:00:00.000Z",
    duration_seconds: " 15 ",
    input_tokens: " 10 ",
    output_tokens: 20,
    cache_creation_tokens: null,
    cache_read_tokens: "not-a-number",
    total_tokens: 90,
    total_cost_usd: 0.9,
    models: ["claude-sonnet-4-6", "gpt-5.4", "gpt-5.6-sol"],
    turns: [
      {
        turn_id: "legacy-turn",
        start_time: "2026-08-10T12:00:05.000Z",
        input_tokens: "3",
        output_tokens: 2,
        total_tokens: "9",
        total_cost_usd: "0.09",
        models: ["gpt-5.4", " "],
      },
    ],
  };

  await writeFile(currentPath, JSON.stringify(currentRecord));
  await writeFile(legacyPath, JSON.stringify(legacyRecord));
  const [currentStat, legacyStat] = await Promise.all([
    stat(currentPath),
    stat(legacyPath),
  ]);

  try {
    await buildPortalData({ root, outDir });

    const currentSession = {
      slug: "current-mixed",
      sid: "current-session",
      project: "Current Project",
      branch: "main",
      cwd: "C:/work/current",
      machine: "machine-a",
      start: "2026-08-10T10:00:00.000Z",
      end: "2026-08-10T10:01:30.000Z",
      durSec: 90,
      durHuman: "1m 30s",
      input: 100,
      output: 50,
      cacheCreate: 20,
      cacheRead: 30,
      totalTokens: 200,
      cost: 1.25,
      models: ["claude-opus-5", "gpt-5.6-sol"],
      turns: [
        {
          id: "current-turn",
          start: "2026-08-10T10:00:00.000Z",
          end: "2026-08-10T10:00:45.000Z",
          input: 60,
          output: 20,
          cacheCreate: 10,
          cacheRead: 10,
          totalTokens: 100,
          cost: 0.6,
          models: ["claude-opus-5", "gpt-5.6-sol"],
        },
      ],
      provider: "claude",
      byVendor: {
        anthropic: { cost: 0.75, tokens: 120 },
        openai: { cost: 0.5, tokens: 80 },
      },
      // Each model keeps its own figures. A chart that fans a session out over
      // its models can only do so from a split the snapshot carries (#89).
      byModel: {
        "claude-opus-5": { cost: 0.75, tokens: 120 },
        "gpt-5.6-sol": { cost: 0.5, tokens: 80 },
      },
    };
    const legacySession = {
      slug: "legacy-s",
      sid: "legacy-session",
      project: "Legacy Project",
      branch: "legacy",
      cwd: "",
      machine: "machine-b",
      start: "2026-08-10T12:00:00.000Z",
      end: null,
      durSec: 15,
      durHuman: "",
      input: 10,
      output: 20,
      cacheCreate: 0,
      cacheRead: 0,
      totalTokens: 90,
      cost: 0.9,
      models: ["claude-sonnet-4-6", "gpt-5.4", "gpt-5.6-sol"],
      turns: [
        {
          id: "legacy-turn",
          start: "2026-08-10T12:00:05.000Z",
          end: "2026-08-10T12:00:05.000Z",
          input: 3,
          output: 2,
          cacheCreate: 0,
          cacheRead: 0,
          totalTokens: 9,
          cost: 0.09,
          models: ["gpt-5.4"],
        },
      ],
      provider: "claude",
      byVendor: {
        anthropic: { cost: 0.45, tokens: 45 },
        openai: { cost: 0.45, tokens: 45 },
      },
      // No breakdowns to read, so the model axis falls back the way the vendor
      // axis does: evenly between the names the shard carries.
      byModel: {
        "claude-sonnet-4-6": { cost: 0.3, tokens: 30 },
        "gpt-5.4": { cost: 0.3, tokens: 30 },
        "gpt-5.6-sol": { cost: 0.3, tokens: 30 },
      },
    };
    const expectedSessions = [currentSession, legacySession];
    const sessionsRaw = await readFile(join(outDir, "sessions.json"), "utf8");
    assert.equal(sessionsRaw, JSON.stringify(expectedSessions));

    const expectedCache = {
      version: 2,
      source: root,
      entries: {
        "01-current.json": {
          size: currentStat.size,
          mtimeMs: currentStat.mtimeMs,
          session: currentSession,
        },
        "02-legacy.json": {
          size: legacyStat.size,
          mtimeMs: legacyStat.mtimeMs,
          session: legacySession,
        },
      },
    };
    const cacheRaw = await readFile(
      join(outDir, "snapshot-cache.json"),
      "utf8",
    );
    assert.equal(cacheRaw, JSON.stringify(expectedCache));

    const metaRaw = await readFile(join(outDir, "meta.json"), "utf8");
    const meta = JSON.parse(metaRaw);
    assert.match(meta.generatedAt, /^2026-|^202[7-9]-|^20[3-9]\d-/);
    const expectedMeta = {
      generatedAt: meta.generatedAt,
      source: root,
      shardDir: resolve(root, "logbook.d"),
      sessions: 2,
      projects: 2,
      machines: 2,
      totalCost: 2.15,
      parsedShards: 2,
      reusedShards: 0,
      span: {
        from: "2026-08-10T10:00:00.000Z",
        to: "2026-08-10T12:00:00.000Z",
      },
    };
    assert.equal(metaRaw, JSON.stringify(expectedMeta, null, 2));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a session's per-model split survives into the snapshot the portal reads", async () => {
  // Every model chart draws one series per model family, and a session that
  // used more than one model owes each family its own spend. The shard records
  // that split; before #89 the snapshot folded it to vendors and dropped it,
  // leaving the renderer nothing to fan a session out over.
  const root = await mkdtemp(join(tmpdir(), "agent-usage-stat-portal-models-"));
  const shardDir = join(root, "logbook.d");
  const outDir = join(root, "portal");
  await mkdir(shardDir);

  const shard = (fields) => ({
    session_id: fields.session_id,
    project: "Split",
    machine: "machine-a",
    start_time: fields.start_time,
    end_time: fields.start_time,
    total_tokens: fields.total_tokens,
    total_cost_usd: fields.total_cost_usd,
    models: fields.models,
    provider: "claude",
    ...(fields.model_breakdowns ? { model_breakdowns: fields.model_breakdowns } : {}),
  });

  await writeFile(
    join(shardDir, "mixed.json"),
    JSON.stringify(shard({
      session_id: "mixed-session",
      start_time: "2026-08-11T10:00:00.000Z",
      total_tokens: 1000,
      total_cost_usd: 10,
      models: ["claude-sonnet-5", "gpt-5"],
      model_breakdowns: [
        {
          model: "claude-sonnet-5",
          vendor: "anthropic",
          input_tokens: 100,
          output_tokens: 100,
          cache_creation_tokens: 50,
          cache_read_tokens: 50,
          total_tokens: 300,
          total_cost_usd: 3,
        },
        {
          model: "gpt-5",
          vendor: "openai",
          input_tokens: 200,
          output_tokens: 200,
          cache_creation_tokens: 150,
          cache_read_tokens: 150,
          total_tokens: 700,
          total_cost_usd: 7,
        },
      ],
    })),
  );
  await writeFile(
    join(shardDir, "legacy-single.json"),
    JSON.stringify(shard({
      session_id: "legacy-single-session",
      start_time: "2026-08-11T11:00:00.000Z",
      total_tokens: 400,
      total_cost_usd: 4,
      models: ["claude-haiku-4-5"],
    })),
  );

  try {
    await buildPortalData({ root, outDir });
    const sessions = JSON.parse(await readFile(join(outDir, "sessions.json"), "utf8"));
    const byId = new Map(sessions.map((session) => [session.sid, session]));

    assert.deepEqual(byId.get("mixed-session").byModel, {
      "claude-sonnet-5": { cost: 3, tokens: 300 },
      "gpt-5": { cost: 7, tokens: 700 },
    });
    // The two axes are two groupings of the same figures, so neither may drift.
    assert.deepEqual(byId.get("mixed-session").byVendor, {
      anthropic: { cost: 3, tokens: 300 },
      openai: { cost: 7, tokens: 700 },
    });

    // One model on the shard means one model owns the session, whether or not
    // the shard is old enough to carry breakdowns.
    assert.deepEqual(byId.get("legacy-single-session").byModel, {
      "claude-haiku-4-5": { cost: 4, tokens: 400 },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
