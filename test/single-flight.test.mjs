import test from "node:test";
import assert from "node:assert/strict";
import { singleFlight } from "../dist/desktop/single-flight.js";

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
