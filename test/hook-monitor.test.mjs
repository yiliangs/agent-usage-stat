import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildDesktopSettingsState } from "../dist/desktop/settings-state.js";
import { installClaudeHook } from "../dist/integrations/claude-hooks.js";
import { createAgentIntegrations } from "../dist/integrations/agent-integrations.js";
import { recordCaptureHealth } from "../dist/utils/capture-health.js";

test("capture monitor follows local hook configuration and observed delivery", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-usage-stat-monitor-"));
  const claudeRoot = join(home, "claude");
  const environment = { ...process.env, HOME: home, USERPROFILE: home };
  await mkdir(claudeRoot, { recursive: true });

  const settingsPath = join(claudeRoot, "settings.json");
  const readClaudeMonitor = async (capturePolicy = { default: "continuous" }) => {
    const state = await buildDesktopSettingsState(
      {
        capturePolicy,
        providerDataRoots: { claude: claudeRoot },
      },
      { root: join(home, "ledger"), source: "default" },
      environment,
      home,
    );
    return state.providers.find((provider) => provider.provider === "claude")
      .captureMonitor;
  };

  try {
    assert.deepEqual(await readClaudeMonitor(), {
      status: "needs_attention",
      reason: "hook_missing",
      observation: null,
    });

    await installClaudeHook(settingsPath);
    assert.deepEqual(await readClaudeMonitor(), {
      status: "unverified",
      reason: "awaiting_first_attempt",
      observation: null,
    });

    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    settings.disableAllHooks = true;
    await writeFile(settingsPath, JSON.stringify(settings), "utf8");
    assert.deepEqual(await readClaudeMonitor(), {
      status: "needs_attention",
      reason: "hooks_disabled",
      observation: null,
    });

    settings.disableAllHooks = false;
    await writeFile(settingsPath, JSON.stringify(settings), "utf8");
    await recordCaptureHealth({
      provider: "claude",
      hookEventName: "Stop",
      status: "recorded",
      occurredAt: "2026-08-09T10:00:00.000Z",
    }, environment);
    assert.equal((await readClaudeMonitor()).status, "observed");

    await recordCaptureHealth({
      provider: "claude",
      hookEventName: "SessionEnd",
      status: "failed",
      message: "capture worker did not start",
      occurredAt: "2026-08-09T11:00:00.000Z",
    }, environment);
    const failed = await readClaudeMonitor();
    assert.equal(failed.status, "needs_attention");
    assert.equal(failed.reason, "last_attempt_failed");
    assert.equal(failed.observation.lastSuccessAt, "2026-08-09T10:00:00.000Z");

    assert.equal(
      (await readClaudeMonitor({ default: "batch" })).status,
      "off",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("local provider inspectors recognize their installed hook files", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-usage-stat-inspection-"));
  const roots = {
    claude: join(home, "claude"),
    codex: join(home, "codex"),
    copilot: join(home, "copilot"),
  };
  const integrations = createAgentIntegrations(
    home,
    () => false,
    process.env,
    { providerDataRoots: roots },
  );

  try {
    assert.deepEqual(
      await Promise.all(integrations.map((integration) => integration.inspect())),
      ["missing", "missing", "missing"],
    );
    await Promise.all(integrations.map((integration) => integration.install()));
    assert.deepEqual(
      await Promise.all(integrations.map((integration) => integration.inspect())),
      ["configured", "configured", "configured"],
    );

    await writeFile(join(roots.codex, "hooks.json"), "not json", "utf8");
    assert.equal(await integrations[1].inspect(), "invalid");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
