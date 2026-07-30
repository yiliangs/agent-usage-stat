import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTokenTraffic,
  robustTokenTrafficScale,
  tokenTrafficIntervalMinutes,
} from "../portal/token-traffic.js";

const start = Date.parse("2026-07-01T00:00:00.000Z");
const end = Date.parse("2026-07-02T00:00:00.000Z");

test("token traffic uses 15-minute bins for short windows and hourly bins for longer windows", () => {
  assert.equal(tokenTrafficIntervalMinutes(start, start + 14 * 86_400_000), 15);
  assert.equal(tokenTrafficIntervalMinutes(start, start + 14 * 86_400_000 + 1), 60);
});

test("token traffic breaks the linear scale when isolated spikes dwarf the majority", () => {
  const scale = robustTokenTrafficScale([0, 8, 9, 10, 11, 12, 13, 14, 120]);

  assert.deepEqual(scale, {
    max: 20,
    rawMax: 120,
    broken: true,
    outlierCount: 1,
  });
});

test("token traffic can place the broken-axis ceiling at 75M for a 50M-range mainstream", () => {
  const scale = robustTokenTrafficScale([18_000_000, 24_000_000, 31_000_000, 42_000_000, 54_000_000, 455_000_000]);

  assert.equal(scale.max, 75_000_000);
  assert.equal(scale.broken, true);
});

test("token traffic keeps an unbroken linear scale for a continuous distribution", () => {
  const scale = robustTokenTrafficScale([5, 8, 12, 16, 20, 24]);

  assert.deepEqual(scale, {
    max: 25,
    rawMax: 24,
    broken: false,
    outlierCount: 0,
  });
});

test("token traffic preserves exact token totals while placing complete turns by completion time", () => {
  const session = usage({
    input: 90,
    output: 10,
    cacheCreate: 20,
    cacheRead: 80,
    totalTokens: 200,
    turns: [
      usage({ end: "2026-07-01T00:07:00.000Z", input: 40, output: 5, cacheCreate: 10, cacheRead: 45, totalTokens: 100 }),
      usage({ end: "2026-07-01T00:22:00.000Z", input: 50, output: 5, cacheCreate: 10, cacheRead: 35, totalTokens: 100 }),
    ],
  });

  const traffic = buildTokenTraffic([session], start, end, 15);
  const active = traffic.buckets.filter((bucket) => bucket.totalTokens);

  assert.deepEqual(active.map((bucket) => bucket.totalTokens), [100, 100]);
  assert.equal(total(traffic.buckets, "input"), 90);
  assert.equal(total(traffic.buckets, "output"), 10);
  assert.equal(total(traffic.buckets, "cacheCreate"), 20);
  assert.equal(total(traffic.buckets, "cacheRead"), 80);
  assert.equal(total(traffic.buckets, "totalTokens"), 200);
  assert.equal(total(traffic.buckets, "turns"), 2);
  assert.equal(total(traffic.buckets, "sessions"), 0);
});

test("token traffic falls back to one session completion when turn detail is incomplete", () => {
  const session = usage({
    end: "2026-07-01T13:42:00.000Z",
    input: 90,
    output: 10,
    totalTokens: 100,
    turns: [usage({ end: "2026-07-01T13:20:00.000Z", input: 40, output: 5, totalTokens: 45 })],
  });

  const traffic = buildTokenTraffic([session], start, end, 60);
  const active = traffic.buckets.filter((bucket) => bucket.totalTokens);

  assert.equal(active.length, 1);
  assert.equal(active[0].start, Date.parse("2026-07-01T13:00:00.000Z"));
  assert.equal(active[0].totalTokens, 100);
  assert.equal(active[0].turns, 0);
  assert.equal(active[0].sessions, 1);
});

function usage(overrides = {}) {
  return {
    start: "2026-07-01T00:00:00.000Z",
    end: "2026-07-01T00:01:00.000Z",
    input: 0,
    output: 0,
    cacheCreate: 0,
    cacheRead: 0,
    totalTokens: 0,
    turns: [],
    ...overrides,
  };
}

function total(buckets, field) {
  return buckets.reduce((sum, bucket) => sum + bucket[field], 0);
}
