import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { withShardLock } from "../dist/core/shard-lock.js";

/**
 * Who may take a shard lock, and who may remove one.
 *
 * The lock used to carry no owner, so it inferred all three answers from an
 * mtime (#109): anything older than 30 seconds was stolen, acquisition gave up
 * after about two seconds, and release deleted whatever sat at the path. On a
 * Google Drive ledger, where a single write can stall for seconds, each of
 * those is a live writer being overrun. The tests below pin the checks that
 * replaced them.
 */

const HOST = hostname();

async function withWorkspace(run) {
  const dir = await mkdtemp(join(tmpdir(), "agent-usage-stat-shard-lock-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A lock file naming a given owner, written the way the lock itself does. */
function lockContent(pid, nonce) {
  return JSON.stringify({
    pid,
    host: HOST,
    nonce,
    acquired_at: new Date().toISOString(),
  });
}

/** A pid on this machine that no longer names a process. Spawning and waiting
 *  for the exit is what makes it a real dead owner rather than a guess. */
async function deadPid() {
  const child = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
  const pid = child.pid;
  await new Promise((resolve) => child.on("close", resolve));

  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return pid;
      throw error;
    }
    await delay(25);
  }
  throw new Error(`pid ${pid} never stopped responding to a signal probe`);
}

test("a lock left by a process that is gone frees the shard at once", async () => {
  await withWorkspace(async (dir) => {
    const shard = join(dir, "session.json");
    const lockPath = `${shard}.lock`;
    await writeFile(lockPath, lockContent(await deadPid(), "dead-owner"));

    const startedAt = Date.now();
    let held = null;
    await withShardLock(shard, async () => {
      held = JSON.parse(await readFile(lockPath, "utf-8"));
    });

    assert.ok(held, "the action ran");
    assert.equal(held.pid, process.pid, "the lock names the writer holding it");
    assert.equal(held.host, HOST);
    assert.ok(held.nonce, "and a nonce only that writer knows");
    assert.ok(
      Date.now() - startedAt < 1_000,
      "a provably dead owner is not waited out",
    );
    assert.equal(existsSync(lockPath), false, "the lock is released after");
  });
});

test("a lock held by a live process is not stolen for being old", async () => {
  await withWorkspace(async (dir) => {
    const shard = join(dir, "session.json");
    const lockPath = `${shard}.lock`;
    // This process is alive by definition, and the mtime is far past the 30
    // seconds the old rule stole at.
    await writeFile(lockPath, lockContent(process.pid, "live-owner"));
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);

    let acquired = false;
    let failure = null;
    const pending = withShardLock(shard, async () => {
      acquired = true;
    }).catch((error) => {
      failure = error;
    });

    await delay(500);
    assert.equal(acquired, false, "age alone is not evidence the owner is gone");
    assert.equal(
      JSON.parse(await readFile(lockPath, "utf-8")).nonce,
      "live-owner",
      "the waiter left the lock alone",
    );

    // Releasing it is what lets the waiter in, rather than the clock.
    await unlink(lockPath);
    await pending;
    assert.equal(failure, null);
    assert.equal(acquired, true, "the waiter kept trying past the old ceiling");
  });
});

test("a lock stolen mid-action is not deleted by the writer it was taken from", async () => {
  await withWorkspace(async (dir) => {
    const shard = join(dir, "session.json");
    const lockPath = `${shard}.lock`;

    await withShardLock(shard, async () => {
      await writeFile(lockPath, lockContent(process.pid, "new-owner"));
    });

    assert.equal(
      existsSync(lockPath),
      true,
      "the lock belongs to its new owner, not to the writer that lost it",
    );
    assert.equal(
      JSON.parse(await readFile(lockPath, "utf-8")).nonce,
      "new-owner",
    );
  });
});
