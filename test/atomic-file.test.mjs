import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  backupOnce,
  writeFileAtomic,
  writeJsonAtomic,
} from "../dist/utils/atomic-file.js";

/**
 * The one owner of "replace a file without ever exposing a half-written one".
 * Five modules used to carry their own copy of stage-and-rename and the hot
 * shard writer carried none (#84), so the rules the copies disagreed about are
 * pinned here instead: the previous file survives a failed write, and nothing
 * staged is left lying beside it.
 */

async function withDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "agent-usage-stat-atomic-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("an atomic write replaces the previous content and stages nothing behind it", async () => {
  await withDir(async (dir) => {
    const path = join(dir, "state.json");

    await writeFileAtomic(path, "first");
    assert.equal(await readFile(path, "utf8"), "first");

    await writeFileAtomic(path, "second");
    assert.equal(await readFile(path, "utf8"), "second");
    assert.deepEqual(await readdir(dir), ["state.json"]);
  });
});

test("a write that cannot land leaves the previous file whole and no staged remains", async () => {
  await withDir(async (dir) => {
    // A directory in the target's place is the cheapest deterministic way to
    // make the rename fail after the staged bytes are already on disk, which
    // is exactly the window a crashed writer used to leave truncated.
    const target = join(dir, "target");
    await mkdir(target);
    await writeFile(join(target, "keep.txt"), "old", "utf8");

    await assert.rejects(() => writeFileAtomic(target, "clobber"));

    assert.equal(await readFile(join(target, "keep.txt"), "utf8"), "old");
    assert.deepEqual(await readdir(dir), ["target"], "no staged file survives");
  });
});

test("a JSON write round-trips through the same staging", async () => {
  await withDir(async (dir) => {
    const path = join(dir, "record.json");
    await writeJsonAtomic(path, { session_id: "s-1", total_tokens: 10 }, 2);

    const text = await readFile(path, "utf8");
    assert.match(text, /\n {2}"session_id"/, "the indent argument is honoured");
    assert.deepEqual(JSON.parse(text), { session_id: "s-1", total_tokens: 10 });
    assert.deepEqual(await readdir(dir), ["record.json"]);
  });
});

test("a backup is taken once and never overwritten by a later install", async () => {
  await withDir(async (dir) => {
    const path = join(dir, "settings.json");
    const backup = `${path}.backup`;

    await writeFile(path, "pristine", "utf8");
    await backupOnce(path, backup);
    assert.equal(await readFile(backup, "utf8"), "pristine");

    await writeFile(path, "modified", "utf8");
    await backupOnce(path, backup);
    assert.equal(
      await readFile(backup, "utf8"),
      "pristine",
      "the first copy is the one worth keeping",
    );
  });
});

test("backing up a file that does not exist is not an error", async () => {
  await withDir(async (dir) => {
    const path = join(dir, "absent.json");
    await backupOnce(path, `${path}.backup`);
    assert.deepEqual(await readdir(dir), []);
  });
});
