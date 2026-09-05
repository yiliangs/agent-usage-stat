import test from "node:test";
import assert from "node:assert/strict";
import { singleFlight, trailingFlight } from "../dist/desktop/single-flight.js";

test("callers arriving while a run is pending join it instead of starting another", async () => {
  let runs = 0;
  let finish;
  const guarded = singleFlight(() => {
    runs += 1;
    return new Promise((resolve) => {
      finish = () => resolve("window");
    });
  });

  const first = guarded();
  const second = guarded();

  assert.equal(runs, 1);
  finish();
  assert.equal(await first, "window");
  assert.equal(await second, "window");
  assert.equal(runs, 1);
});

test("a settled run releases the guard, so a later caller opens again", async () => {
  let runs = 0;
  const guarded = singleFlight(async () => {
    runs += 1;
    return runs;
  });

  assert.equal(await guarded(), 1);
  assert.equal(await guarded(), 2);
  assert.equal(runs, 2);
});

test("a failed run reaches every caller and still releases the guard", async () => {
  let runs = 0;
  let fail;
  const guarded = singleFlight(() => {
    runs += 1;
    return new Promise((_resolve, reject) => {
      fail = () => reject(new Error(`attempt ${runs}`));
    });
  });

  const first = guarded();
  const second = guarded();
  fail();

  await assert.rejects(first, /attempt 1/);
  await assert.rejects(second, /attempt 1/);
  assert.equal(runs, 1);

  const third = guarded();
  fail();

  await assert.rejects(third, /attempt 2/);
  assert.equal(runs, 2);
});

/** Let every promise callback the guard scheduled reach the run queue. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A guard whose runs are started by the caller and settled by the test. */
function recordedRuns() {
  const pending = [];
  let started = 0;
  const guarded = trailingFlight(() => {
    started += 1;
    const label = `run ${started}`;
    return new Promise((resolve, reject) => {
      pending.push({
        resolve: () => resolve(label),
        reject: () => reject(new Error(label)),
      });
    });
  });
  return { guarded, pending, started: () => started };
}

test("a trailing caller is answered by a fresh run, never the one in flight", async () => {
  const { guarded, pending, started } = recordedRuns();

  const first = guarded();
  const second = guarded();
  const third = guarded();
  assert.equal(started(), 1);

  pending[0].resolve();
  assert.equal(await first, "run 1");
  await flush();
  assert.equal(started(), 2, "the settled run hands over to the follow-up");

  pending[1].resolve();
  assert.equal(await second, "run 2");
  assert.equal(await third, "run 2");
  await flush();
  assert.equal(started(), 2, "one window of callers shares one follow-up");
});

test("a caller arriving during the follow-up chains one more run", async () => {
  const { guarded, pending, started } = recordedRuns();

  const first = guarded();
  const second = guarded();
  pending[0].resolve();
  await first;
  await flush();
  assert.equal(started(), 2);

  const third = guarded();
  assert.equal(started(), 2, "the follow-up is not restarted under its callers");

  pending[1].resolve();
  assert.equal(await second, "run 2");
  await flush();
  assert.equal(started(), 3);

  pending[2].resolve();
  assert.equal(await third, "run 3");
});

test("a rejected run still hands over, and reaches only its own callers", async () => {
  const { guarded, pending, started } = recordedRuns();

  const first = guarded();
  const second = guarded();

  pending[0].reject();
  await assert.rejects(first, /run 1/);
  await flush();
  assert.equal(started(), 2, "a failure must not strand the trailing caller");

  pending[1].reject();
  await assert.rejects(second, /run 2/);
  assert.equal(started(), 2);
});

test("a settled trailing flight starts fresh for the next caller", async () => {
  let runs = 0;
  const guarded = trailingFlight(async () => {
    runs += 1;
    return runs;
  });

  assert.equal(await guarded(), 1);
  assert.equal(await guarded(), 2);
  assert.equal(runs, 2);
});
