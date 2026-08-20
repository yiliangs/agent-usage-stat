import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  extractFeedRates,
  feedPriceFor,
  initializePricingFeed,
  pricingFeedFingerprint,
} from "../dist/core/pricing-feed.js";
import { priceFor as claudePriceFor } from "../dist/providers/claude/pricing.js";
import { priceFor as codexPriceFor } from "../dist/providers/codex/pricing.js";
import { claudeSnapshotVersion } from "../dist/providers/claude/transcript-fingerprint.js";

const FEED = {
  "claude-nova-6": {
    litellm_provider: "anthropic",
    mode: "chat",
    input_cost_per_token: 0.000008,
    output_cost_per_token: 0.00004,
    cache_creation_input_token_cost: 0.00001,
    cache_read_input_token_cost: 0.0000008,
  },
  // Dated snapshot of the same model; the sorted bare alias must win.
  "claude-nova-6-20270101": {
    litellm_provider: "anthropic",
    mode: "chat",
    input_cost_per_token: 0.000009,
    output_cost_per_token: 0.000045,
  },
  // Baked-table model with deliberately wrong feed rates; baked must win.
  "claude-opus-5": {
    litellm_provider: "anthropic",
    mode: "chat",
    input_cost_per_token: 0.000099,
    output_cost_per_token: 0.00099,
  },
  "gpt-6.1": {
    litellm_provider: "openai",
    mode: "responses",
    input_cost_per_token: 0.000004,
    output_cost_per_token: 0.000024,
    cache_read_input_token_cost: 0.0000004,
  },
  // Missing cache fields: anthropic ratios fill in.
  "claude-tide-1": {
    litellm_provider: "anthropic",
    mode: "chat",
    input_cost_per_token: 0.000002,
    output_cost_per_token: 0.00001,
  },
  "claude-on-bedrock": {
    litellm_provider: "bedrock",
    mode: "chat",
    input_cost_per_token: 0.000001,
    output_cost_per_token: 0.000005,
  },
  "dall-e-9": {
    litellm_provider: "openai",
    mode: "image_generation",
    input_cost_per_token: 0.00001,
    output_cost_per_token: 0.00004,
  },
  "reseller/claude-nova-6": {
    litellm_provider: "openai",
    mode: "chat",
    input_cost_per_token: 0.0000001,
    output_cost_per_token: 0.0000005,
  },
};

const fetchOk = (body) => async () => ({
  ok: true,
  status: 200,
  json: async () => body,
});

const fetchFail = () => async () => {
  throw new Error("network unreachable");
};

const countingFetch = (inner) => {
  const impl = async (...args) => {
    impl.calls++;
    return inner(...args);
  };
  impl.calls = 0;
  return impl;
};

async function freshRoot() {
  return mkdtemp(join(tmpdir(), "agent-usage-stat-pricing-feed-"));
}

test("extractFeedRates keeps first-party chat entries and converts to per-MTok", () => {
  const rates = extractFeedRates(FEED);

  assert.deepEqual(rates["claude-nova-6"], {
    input: 8,
    output: 40,
    cacheWrite: 10,
    cacheRead: 0.8,
  });
  assert.deepEqual(rates["gpt-6.1"], {
    input: 4,
    output: 24,
    cacheWrite: 4,
    cacheRead: 0.4,
  });
  // Anthropic cache ratios fill missing cache fields.
  assert.deepEqual(rates["claude-tide-1"], {
    input: 2,
    output: 10,
    cacheWrite: 2.5,
    cacheRead: 0.2,
  });
  assert.equal(rates["claude-on-bedrock"], undefined);
  assert.equal(rates["dall-e-9"], undefined);
  assert.equal(Object.keys(rates).some((key) => key.includes("/")), false);
});

test("a fetched feed prices unknown models while baked tables stay authoritative", async () => {
  const root = await freshRoot();
  await initializePricingFeed(root, { fetchImpl: fetchOk(FEED) });

  assert.notEqual(pricingFeedFingerprint(), "none");
  // Unknown to every baked table: resolved from the feed, dated suffix and
  // all. Long-context fields stay unset — the feed carries no premium.
  const nova = claudePriceFor("claude-nova-6-20270101");
  assert.deepEqual(
    {
      input: nova.input,
      output: nova.output,
      cacheWrite: nova.cacheWrite,
      cacheRead: nova.cacheRead,
    },
    { input: 8, output: 40, cacheWrite: 10, cacheRead: 0.8 },
  );
  assert.equal(nova.longInput, undefined);
  assert.deepEqual(codexPriceFor("gpt-6.1"), {
    input: 4,
    cachedInput: 0.4,
    cacheWrite: 4,
    output: 24,
  });
  // The feed's wrong claude-opus-5 rates must not displace the baked table.
  assert.equal(claudePriceFor("claude-opus-5").input, 5);

  const cache = JSON.parse(await readFile(join(root, "pricing-feed.json"), "utf-8"));
  assert.equal(cache.rates["claude-nova-6"].input, 8);
});

test("a fresh cache is served without a network call", async () => {
  const root = await freshRoot();
  await initializePricingFeed(root, { fetchImpl: fetchOk(FEED) });

  const impl = countingFetch(fetchFail());
  await initializePricingFeed(root, { fetchImpl: impl });

  assert.equal(impl.calls, 0);
  assert.equal(feedPriceFor("claude-nova-6").input, 8);
});

test("fetch failure keeps baked-only pricing and backs off until the retry interval", async () => {
  const root = await freshRoot();
  const failing = countingFetch(fetchFail());
  await initializePricingFeed(root, { fetchImpl: failing });

  assert.equal(failing.calls, 1);
  assert.equal(pricingFeedFingerprint(), "none");
  assert.equal(feedPriceFor("claude-nova-6"), null);
  assert.equal(claudePriceFor("claude-opus-5").input, 5);

  // The failed attempt is recorded; the next initialize does not retry yet.
  await initializePricingFeed(root, { fetchImpl: failing });
  assert.equal(failing.calls, 1);

  // Once the backoff elapses, the retry succeeds and repopulates the feed.
  const cachePath = join(root, "pricing-feed.json");
  const cache = JSON.parse(await readFile(cachePath, "utf-8"));
  cache.attemptedAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  await writeFile(cachePath, JSON.stringify(cache), "utf-8");
  await initializePricingFeed(root, { fetchImpl: fetchOk(FEED) });
  assert.equal(feedPriceFor("claude-nova-6").input, 8);
});

test("the feed snapshot is pinned into transcript fingerprints", async () => {
  const emptyRoot = await freshRoot();
  await initializePricingFeed(emptyRoot, { fetchImpl: fetchFail() });
  const bakedOnly = claudeSnapshotVersion();

  const feedRoot = await freshRoot();
  await initializePricingFeed(feedRoot, { fetchImpl: fetchOk(FEED) });
  const withFeed = claudeSnapshotVersion();

  assert.notEqual(bakedOnly, withFeed);

  // Reloading the identical snapshot leaves the fingerprint stable.
  await initializePricingFeed(feedRoot, { fetchImpl: fetchFail() });
  assert.equal(claudeSnapshotVersion(), withFeed);
});
