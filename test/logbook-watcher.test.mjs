import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LogbookWatcher } from "../dist/desktop/logbook-watcher.js";

const QUIET_MS = 120;

const shardDir = (root) => join(root, "logbook.d");

async function freshRoot() {
  return mkdtemp(join(tmpdir(), "agent-usage-stat-logbook-watcher-"));
}

async function waitFor(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

async function settle(ms = QUIET_MS * 4) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

test("a burst of shard writes settles into one refresh", async () => {
  const root = await freshRoot();
  let calls = 0;
  const watcher = new LogbookWatcher(async () => { calls++; }, QUIET_MS);
  await watcher.start(root);
  try {
    for (let index = 0; index < 5; index++) {
      await writeFile(join(shardDir(root), `session-${index}.json`), "{}");
    }
    assert.ok(await waitFor(() => calls === 1), `expected one refresh, saw ${calls}`);
    await settle();
    assert.equal(calls, 1);
  } finally {
    watcher.stop();
  }
});

test("writes landing during a refresh schedule exactly one follow-up", async () => {
  const root = await freshRoot();
  let calls = 0;
  const watcher = new LogbookWatcher(async () => {
    calls++;
    if (calls === 1) {
      // A refresh reconciles sessions, which can itself write shards.
      await writeFile(join(shardDir(root), "written-during-refresh.json"), "{}");
      await settle(QUIET_MS);
    }
  }, QUIET_MS);
  await watcher.start(root);
  try {
    await writeFile(join(shardDir(root), "session.json"), "{}");
    assert.ok(await waitFor(() => calls === 2), `expected a follow-up refresh, saw ${calls}`);
    await settle();
    assert.equal(calls, 2);
  } finally {
    watcher.stop();
  }
});

test("restarting repoints the watcher to the new root", async () => {
  const oldRoot = await freshRoot();
  const newRoot = await freshRoot();
  let calls = 0;
  const watcher = new LogbookWatcher(async () => { calls++; }, QUIET_MS);
  await watcher.start(oldRoot);
  await watcher.start(newRoot);
  try {
    // Watching a directory created a moment earlier can report the creation
    // itself, and this guard is about the root that was replaced rather than
    // about the noise a fresh watch makes, so let the new root settle first
    // and count only the refreshes that follow.
    await settle();
    calls = 0;

    await writeFile(join(shardDir(oldRoot), "old-root.json"), "{}");
    await settle();
    assert.equal(calls, 0, "the replaced root must no longer trigger refreshes");

    await writeFile(join(shardDir(newRoot), "new-root.json"), "{}");
    assert.ok(await waitFor(() => calls === 1), `expected the new root to refresh, saw ${calls}`);
  } finally {
    watcher.stop();
  }
});

test("overlapping restarts leave exactly one live watcher", async () => {
  const oldRoot = await freshRoot();
  const newRoot = await freshRoot();
  let calls = 0;
  const watcher = new LogbookWatcher(async () => { calls++; }, QUIET_MS);
  // start() releases the event loop between clearing the old watcher and
  // installing the new one, and a second start can land in that window: the
  // background sync arms the watcher on its last line, and changing the data
  // folder arms it from a user action. The older call must open nothing.
  const first = watcher.start(oldRoot);
  const second = watcher.start(newRoot);
  await Promise.all([first, second]);
  try {
    await settle();
    calls = 0;

    await writeFile(join(shardDir(oldRoot), "old-root.json"), "{}");
    await settle();
    assert.equal(calls, 0, "the overlapped root must not have kept a watcher");

    await writeFile(join(shardDir(newRoot), "new-root.json"), "{}");
    assert.ok(await waitFor(() => calls === 1), `expected the new root to refresh, saw ${calls}`);
  } finally {
    watcher.stop();
  }
});

test("stop() during a pending start leaves nothing watching", async () => {
  const root = await freshRoot();
  let calls = 0;
  const watcher = new LogbookWatcher(async () => { calls++; }, QUIET_MS);
  const pending = watcher.start(root);
  watcher.stop();
  await pending;

  await writeFile(join(shardDir(root), "after-stop.json"), "{}");
  await settle();
  assert.equal(calls, 0);
  watcher.stop();
});

test("stop() silences further events", async () => {
  const root = await freshRoot();
  let calls = 0;
  const watcher = new LogbookWatcher(async () => { calls++; }, QUIET_MS);
  await watcher.start(root);
  watcher.stop();
  await writeFile(join(shardDir(root), "after-stop.json"), "{}");
  await settle();
  assert.equal(calls, 0);
});
