import test from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import {
  resolveProviderDataRoot,
  resolveProviderDataRoots,
} from "../dist/utils/provider-data-roots.js";
import { detectProvider } from "../dist/providers/registry.js";
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

test("provider data roots preserve registry order", () => {
  assert.deepEqual(
    resolveProviderDataRoots({}, {}, resolve("home")).map((item) => item.provider),
    ["claude", "codex", "copilot"],
  );
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
