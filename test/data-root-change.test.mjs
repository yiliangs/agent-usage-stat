import test from "node:test";
import assert from "node:assert/strict";
import { changeDataRoot } from "../dist/desktop/data-root-change.js";

/** Steps that record the order they ran in, with a settable setup outcome. */
function recordingSteps(setupReady) {
  const order = [];
  const roots = {};
  return {
    order,
    roots,
    steps: {
      configure: async (root) => {
        order.push("configure");
        roots.configure = root;
      },
      resetSetup: async () => {
        order.push("resetSetup");
      },
      refresh: async () => {
        order.push("refresh");
      },
      watch: async (root) => {
        order.push("watch");
        roots.watch = root;
      },
      reload: async () => {
        order.push("reload");
      },
      ensureSetup: async () => {
        order.push("ensureSetup");
        return setupReady;
      },
    },
  };
}

test("a failed capture setup still leaves the ledger, watcher, and view agreeing", async () => {
  const { order, roots, steps } = recordingSteps(false);

  const result = await changeDataRoot("/new/ledger", steps);

  // Hook installation can fail on a folder the ledger is perfectly happy in.
  // Gating the move on it used to return early, leaving config on the new
  // folder, the watcher armed on the old one, and the dashboard rendering a
  // snapshot of neither.
  assert.deepEqual(order, [
    "configure",
    "resetSetup",
    "refresh",
    "watch",
    "reload",
    "ensureSetup",
  ]);
  assert.equal(roots.configure, "/new/ledger");
  assert.equal(roots.watch, "/new/ledger");
  assert.deepEqual(result, { setupReady: false });
});

test("a completed change reports its capture setup as ready", async () => {
  const { order, steps } = recordingSteps(true);

  const result = await changeDataRoot("/new/ledger", steps);

  assert.deepEqual(result, { setupReady: true });
  assert.equal(order.length, 6);
});

test("a failing step stops the change where it failed", async () => {
  const { order, steps } = recordingSteps(true);
  steps.refresh = async () => {
    order.push("refresh");
    throw new Error("Usage synchronization failed.");
  };

  await assert.rejects(changeDataRoot("/new/ledger", steps), /synchronization/);
  assert.deepEqual(order, ["configure", "resetSetup", "refresh"]);
});
