import test from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import {
  resolveProviderDataRoot,
  resolveProviderDataRoots,
} from "../dist/utils/provider-data-roots.js";
import {
  detectProvider,
  providerByName,
} from "../dist/providers/registry.js";
import {
  isProviderName,
  PROVIDER_NAMES,
} from "../dist/core/provider-definition.js";
import { createAgentIntegrations } from "../dist/integrations/agent-integrations.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

test("provider data roots distinguish default, environment, and custom paths", () => {
  const home = resolve("test-home");
  const environment = {
    CLAUDE_CONFIG_DIR: join(home, "env-claude"),
    CODEX_HOME: join(home, "env-codex"),
  };
  const config = {
    providerDataRoots: {
      codex: join(home, "custom-codex"),
    },
  };

  assert.deepEqual(
    resolveProviderDataRoot("claude", config, environment, home),
    {
      provider: "claude",
      label: "Claude Code",
      root: join(home, "env-claude"),
      source: "environment",
      environmentVariable: "CLAUDE_CONFIG_DIR",
    },
  );
  assert.deepEqual(
    resolveProviderDataRoot("codex", config, environment, home),
    {
      provider: "codex",
      label: "Codex",
      root: join(home, "custom-codex"),
      source: "custom",
      environmentVariable: "CODEX_HOME",
    },
  );
  assert.deepEqual(
    resolveProviderDataRoot("copilot", config, environment, home),
    {
      provider: "copilot",
      label: "Copilot CLI",
      root: join(home, ".copilot"),
      source: "default",
      environmentVariable: "COPILOT_HOME",
    },
  );
});

test("provider inventory covers roots, factories, detectors, integrations, and validation", async () => {
  const expectedNames = ["claude", "codex", "copilot"];
  const expectedDetectionRecords = {
    claude: { type: "user" },
    codex: { type: "session_meta" },
    copilot: { type: "session.start" },
  };
  const home = resolve("provider-inventory-home");
  const roots = resolveProviderDataRoots({}, {}, home);
  const integrations = createAgentIntegrations(home, () => false, {}, {});
  const transcripts = await mkdtemp(join(tmpdir(), "agent-usage-stat-inventory-"));

  try {
    assert.deepEqual(PROVIDER_NAMES, expectedNames);
    assert.deepEqual(
      roots.map((item) => item.provider),
      expectedNames,
    );
    assert.deepEqual(
      roots.map((item) => item.environmentVariable),
      ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "COPILOT_HOME"],
    );
    assert.deepEqual(
      roots.map((item) => item.root),
      [join(home, ".claude"), join(home, ".codex"), join(home, ".copilot")],
    );
    assert.deepEqual(
      integrations.map((integration) => [integration.provider, integration.label]),
      [
        ["claude", "Claude Code"],
        ["codex", "Codex"],
        ["copilot", "GitHub Copilot CLI"],
      ],
    );

    for (const [index, provider] of PROVIDER_NAMES.entries()) {
      assert.equal(isProviderName(provider), true);
      assert.equal(providerByName(provider, roots[index].root).name, provider);

      const transcript = join(transcripts, `${provider}.jsonl`);
      await writeFile(
        transcript,
        `${JSON.stringify(expectedDetectionRecords[provider])}\n`,
      );
      assert.equal((await detectProvider(transcript)).name, provider);
    }

    for (const value of [undefined, null, "", "github-copilot", 0, {}]) {
      assert.equal(isProviderName(value), false);
    }
  } finally {
    await rm(transcripts, { recursive: true, force: true });
  }
});

test("provider detection falls back to a configured custom root", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-usage-stat-detect-root-"));
  const claudeHome = join(home, "provider-state", "anthropic-agent");
  const transcript = join(claudeHome, "projects", "project", "partial.jsonl");
  await mkdir(join(transcript, ".."), { recursive: true });
  await writeFile(transcript, '{"type":"partial-record"}\n');

  try {
    const provider = await detectProvider(
      transcript,
      { providerDataRoots: { claude: claudeHome } },
      {},
      home,
    );
    assert.equal(provider.name, "claude");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
