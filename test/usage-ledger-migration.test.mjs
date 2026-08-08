import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mergeUsageLedger,
  removeUsageLedger,
} from "../dist/core/usage-ledger-migration.js";

test("ledger migration merges history without downgrading records and removes only on request", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-usage-stat-migrate-"));
  const source = join(root, "source");
  const destination = join(root, "destination");
  await mkdir(join(source, "logbook.d"), { recursive: true });
  await mkdir(join(destination, "logbook.d"), { recursive: true });
  await writeFile(join(source, "keep-me.txt"), "unrelated");

  await writeShard(source, "shared", 100, 0.5);
  await writeShard(destination, "shared", 200, 0.6);
  await writeShard(source, "source-only", 300, 0.7);
  await writeShard(source, "source-newer", 400, 0.9);
  await writeShard(destination, "source-newer", 350, 0.8);

  try {
    assert.deepEqual(await mergeUsageLedger(source, destination), {
      copied: 2,
      retained: 1,
    });
    assert.equal((await readShard(destination, "shared")).total_tokens, 200);
    assert.equal((await readShard(destination, "source-only")).total_tokens, 300);
    assert.equal((await readShard(destination, "source-newer")).total_tokens, 400);
    assert.equal(existsSync(join(source, "logbook.d")), true);

    await removeUsageLedger(source);
    assert.equal(existsSync(join(source, "logbook.d")), false);
    assert.equal(await readFile(join(source, "keep-me.txt"), "utf8"), "unrelated");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeShard(root, id, tokens, cost) {
  await writeFile(
    join(root, "logbook.d", `${id}.json`),
    JSON.stringify({
      session_id: id,
      provider: "codex",
      total_tokens: tokens,
      total_cost_usd: cost,
    }),
  );
}

async function readShard(root, id) {
  return JSON.parse(
    await readFile(join(root, "logbook.d", `${id}.json`), "utf8"),
  );
}
