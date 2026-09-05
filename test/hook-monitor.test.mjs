import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildDesktopSettingsState } from "../dist/desktop/settings-state.js";
import { installClaudeHook } from "../dist/integrations/claude-hooks.js";
import { createAgentIntegrations } from "../dist/integrations/agent-integrations.js";
import { captureMonitor } from "../dist/desktop/capture-monitor.js";
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
      repairable: true,
      observation: null,
    });

    await installClaudeHook(settingsPath);
    assert.deepEqual(await readClaudeMonitor(), {
      status: "warning",
      reason: "awaiting_first_attempt",
      repairable: false,
      observation: null,
    });

    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    settings.disableAllHooks = true;
    await writeFile(settingsPath, JSON.stringify(settings), "utf8");
    assert.deepEqual(await readClaudeMonitor(), {
      status: "needs_attention",
      reason: "hooks_disabled",
      repairable: false,
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
    assert.equal(failed.status, "warning");
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
    opencode: join(home, "opencode"),
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
      ["missing", "missing", "missing", "missing"],
    );
    await Promise.all(integrations.map((integration) => integration.install()));
    assert.deepEqual(
      await Promise.all(integrations.map((integration) => integration.inspect())),
      ["configured", "configured", "configured", "configured"],
    );

    await writeFile(join(roots.codex, "hooks.json"), "not json", "utf8");
    assert.equal(await integrations[1].inspect(), "invalid");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a foreign hook group without a hooks array survives install and remove", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-usage-stat-hookless-group-"));
  const roots = {
    claude: join(home, "claude"),
    codex: join(home, "codex"),
  };
  const [claude, codex] = createAgentIntegrations(
    home,
    () => false,
    process.env,
    { providerDataRoots: roots },
  ).filter((integration) => integration.provider in roots);
  // A group with no hooks array is nothing of ours. Reading one used to throw
  // out of install and remove and take the hosts behind it down with the throw.
  const foreign = { matcher: "*" };
  const fixtures = [
    [claude, join(roots.claude, "settings.json"), { hooks: { Stop: [foreign] } }],
    [codex, join(roots.codex, "hooks.json"), { hooks: { Stop: [foreign] } }],
  ];

  try {
    for (const [integration, path, contents] of fixtures) {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, JSON.stringify(contents, null, 2), "utf8");

      await integration.install();
      assert.equal(await integration.inspect(), "configured");
      assert.deepEqual(
        JSON.parse(await readFile(path, "utf8")).hooks.Stop[0],
        foreign,
      );

      await integration.remove();
      assert.deepEqual(
        JSON.parse(await readFile(path, "utf8")).hooks.Stop,
        [foreign],
      );
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("settings joins provider collaborators by identity instead of array position", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-usage-stat-settings-order-"));
  const providerNames = ["claude", "codex", "copilot", "opencode"];
  const roots = Object.fromEntries(
    providerNames.map((provider) => [provider, join(home, provider)]),
  );
  await Promise.all(
    Object.values(roots).map((root) => mkdir(root, { recursive: true })),
  );

  const providers = providerNames.map((name, index) => ({
    name,
    findSession: async () => { throw new Error("unused"); },
    findAllSessions: async () => Array.from({ length: index + 1 }, () => ({})),
    fingerprintSession: async () => "unused",
    readSession: async () => { throw new Error("unused"); },
  })).reverse();
  const hookStatuses = {
    claude: "configured",
    codex: "missing",
    copilot: "disabled",
    opencode: "invalid",
  };
  const integrations = providerNames.map((provider) => ({
    provider,
    label: provider,
    isInstalled: () => true,
    inspect: async () => hookStatuses[provider],
    install: async () => ({ needsTrust: false }),
    remove: async () => undefined,
  })).reverse();

  try {
    const state = await buildDesktopSettingsState(
      { providerDataRoots: roots },
      { root: join(home, "ledger"), source: "default" },
      { ...process.env, HOME: home, USERPROFILE: home },
      home,
      { providers, integrations },
    );

    assert.deepEqual(
      state.providers.map((provider) => ({
        provider: provider.provider,
        sessions: provider.sessions,
        monitor: provider.captureMonitor.reason,
      })),
      [
        { provider: "claude", sessions: 1, monitor: "awaiting_first_attempt" },
        { provider: "codex", sessions: 2, monitor: "hook_missing" },
        { provider: "copilot", sessions: 3, monitor: "hooks_disabled" },
        { provider: "opencode", sessions: 4, monitor: "settings_invalid" },
      ],
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("repair is offered exactly where a reinstall changes the outcome", () => {
  const verdict = (configuration, ownsHookFile) =>
    captureMonitor("continuous", true, configuration, null, ownsHookFile).repairable;

  // A missing hook is what install() writes, so it is always repairable.
  assert.equal(verdict("missing", false), true);
  assert.equal(verdict("missing", true), true);

  // An unreadable hook file is repairable only when the application owns it
  // and a reinstall rewrites it; agent-owned files make install() throw.
  assert.equal(verdict("invalid", true), true);
  assert.equal(verdict("invalid", false), false);

  // Disabled execution is an agent-side switch a reinstall must not override.
  assert.equal(verdict("disabled", true), false);
  assert.equal(verdict("disabled", false), false);

  // A recorded delivery failure clears only on the next successful capture.
  const failed = captureMonitor("continuous", true, "configured", {
    provider: "claude",
    lastAttemptAt: "2026-08-19T20:50:02.764Z",
    lastAttemptEvent: "SessionEnd",
    lastAttemptStatus: "failed",
  }, false);
  assert.equal(failed.reason, "last_attempt_failed");
  assert.equal(failed.repairable, false);

  // Copilot and opencode are the integrations whose hook file we write whole.
  const integrations = createAgentIntegrations("/home", () => false, process.env, {});
  assert.deepEqual(
    integrations.map((integration) => [integration.provider, integration.ownsHookFile]),
    [["claude", false], ["codex", false], ["copilot", true], ["opencode", true]],
  );
  for (const integration of integrations) {
    assert.ok(integration.hookConfigPath.length > 0, `${integration.provider} names no hook file`);
  }
});

test("the opencode plugin round-trips and keeps its runtime contract", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-usage-stat-opencode-hook-"));
  const [integration] = createAgentIntegrations(home, () => false, {}, {})
    .filter((candidate) => candidate.provider === "opencode");
  const plugin = integration.hookConfigPath;

  try {
    // opencode auto-loads every .js file in its global plugin directory, so
    // the file lands there rather than in any shared configuration.
    assert.equal(plugin, join(home, ".config", "opencode", "plugin", "agent-usage-stat.js"));
    assert.equal(await integration.inspect(), "missing");

    await integration.install();
    assert.equal(await integration.inspect(), "configured");

    const source = await readFile(plugin, "utf8");
    // The contract the plugin runs under: opencode installs nothing for it, so
    // every import has to be a Node built-in.
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map(([, name]) => name);
    assert.deepEqual(imports, ["node:child_process"]);
    // It must checkpoint on idle and never block opencode waiting for us.
    assert.match(source, /session\.idle/);
    assert.match(source, /properties\?\.sessionID/);
    assert.match(source, /unref\(\)/);
    assert.doesNotMatch(source, /\bawait\s+(?!undefined)/);

    // A plugin edited to spawn something else is broken, not configured.
    await writeFile(
      plugin,
      source.replace(/const ARGS = \[[^\]]*\];/, 'const ARGS = [];')
        .replace(/const COMMAND = "[^"]*";/, 'const COMMAND = "/usr/bin/env";'),
      "utf8",
    );
    assert.equal(await integration.inspect(), "invalid");

    // A foreign file under our name is ours to rewrite, never to merge.
    await writeFile(plugin, "export const Other = () => ({})\n", "utf8");
    assert.equal(await integration.inspect(), "invalid");
    assert.equal(integration.ownsHookFile, true);

    await integration.remove();
    assert.equal(await integration.inspect(), "missing");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
