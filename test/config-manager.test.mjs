import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigManager } from "../dist/core/config-manager.js";

/**
 * What happens to a config file that will not parse.
 *
 * The file holds `dataRoot` and every provider root, and a crash or a full
 * disk during a settings change can leave it truncated. Loading defaults over
 * it is survivable; letting the next save replace it with those defaults is
 * not, because the ledger the user chose is then gone rather than merely
 * unreadable (#126). The unreadable bytes are copied aside once, before
 * anything overwrites them.
 */

/** A config directory this test owns, with the home variables pointed at it so
 *  `ConfigManager` resolves its config file inside. Removed however it ends. */
async function withConfigHome(run) {
  const home = await mkdtemp(join(tmpdir(), "agent-usage-stat-config-"));
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await run(home);
  } finally {
    restoreEnvironment(previous);
    await rm(home, { recursive: true, force: true });
  }
}

function restoreEnvironment(previous) {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

test("an unreadable config is preserved before defaults replace it", async () => {
  await withConfigHome(async () => {
    const manager = new ConfigManager();
    const configPath = manager.getConfigPath();
    const preservedPath = manager.getPreservedConfigPath();
    const truncated = '{"dataRoot": "D:/My Drive/agent-usage-stat"';
    await writeFile(configPath, truncated, "utf-8");

    const loaded = await manager.loadConfig();
    assert.equal(loaded.dataRoot, undefined, "an unreadable config names no root");
    assert.equal(
      await readFile(preservedPath, "utf-8"),
      truncated,
      "the bytes that named the ledger are kept beside the config",
    );

    // The save that follows is the one that used to destroy them.
    await manager.saveConfig({ ...loaded, dataRoot: "D:/My Drive/agent-usage-stat" });
    assert.deepEqual(
      JSON.parse(await readFile(configPath, "utf-8")).dataRoot,
      "D:/My Drive/agent-usage-stat",
      "a later save writes valid JSON at the config path",
    );
    assert.equal(
      await readFile(preservedPath, "utf-8"),
      truncated,
      "and leaves the preserved copy alone",
    );
  });
});

test("the first corruption is the copy kept, and nothing is staged beside it", async () => {
  await withConfigHome(async (home) => {
    const manager = new ConfigManager();
    const configPath = manager.getConfigPath();
    const preservedPath = manager.getPreservedConfigPath();

    await writeFile(configPath, '{"dataRoot": "first"', "utf-8");
    await manager.loadConfig();
    // A second unreadable config is already post-corruption. Overwriting the
    // copy with it would replace the only record of the original root.
    await writeFile(configPath, "{", "utf-8");
    await manager.loadConfig();
    assert.equal(await readFile(preservedPath, "utf-8"), '{"dataRoot": "first"');

    await manager.saveConfig(await manager.loadConfig());
    assert.deepEqual(
      (await readdir(home)).sort(),
      [".agent-usage-stat.config.json", ".agent-usage-stat.config.json.corrupt"],
      "no staged temporary outlives the write",
    );
  });
});

test("a config that was never written loads defaults and preserves nothing", async () => {
  await withConfigHome(async (home) => {
    const manager = new ConfigManager();
    const loaded = await manager.loadConfig();

    assert.equal(loaded.capturePolicy?.default, "continuous");
    assert.deepEqual(await readdir(home), []);
  });
});
