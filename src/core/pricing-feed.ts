import { createHash } from "crypto";
import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { join, resolve } from "path";
import { logHookEvent } from "../utils/hook-log.js";
import { normalizeModelId } from "./model-id.js";

/**
 * Remote pricing feed: LiteLLM's community-maintained price list, cached in
 * the usage root so every machine sharing a ledger prices against the same
 * snapshot.
 *
 * The feed never overrides a baked provider table — it only prices models the
 * tables have never heard of, so a model released between application updates
 * bills at its list rate instead of $0. Baked tables remain authoritative for
 * everything they cover, including fast-mode multipliers and long-context
 * premiums, which the feed does not carry.
 *
 * Refresh is best-effort and silent: hook-triggered capture must never fail or
 * block on the network, so a fetch failure keeps the cached snapshot (or the
 * baked tables alone) and is retried no sooner than RETRY_INTERVAL_MS later.
 *
 * The active snapshot is pinned into transcript fingerprints through
 * pricingFeedFingerprint(): a shard records which snapshot priced it, and a
 * changed snapshot recomputes sessions exactly the way a baked-table edit
 * always has. The fingerprint hashes only the extracted rates, so upstream
 * metadata churn (context windows, capability flags) does not trigger
 * recomputation.
 */

export interface FeedRates {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export interface PricingFeedOptions {
  url?: string;
  refreshIntervalMs?: number;
  retryIntervalMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface FeedCacheFile {
  source: string;
  fetchedAt: string;
  attemptedAt: string;
  rates: Record<string, FeedRates>;
}

const DEFAULT_FEED_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const CACHE_FILE = "pricing-feed.json";
const REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const RETRY_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 4000;

// Anthropic publishes uniform cache ratios (write 1.25x input, read 0.1x);
// applied only when a feed entry omits its cache fields.
const ANTHROPIC_CACHE_WRITE_RATIO = 1.25;
const ANTHROPIC_CACHE_READ_RATIO = 0.1;

let activeRates: Record<string, FeedRates> = {};
let activeFingerprint = "none";

/**
 * Load the cached feed snapshot from the usage root and refresh it from the
 * network when stale. Must run before any provider fingerprint or pricing
 * work; never throws.
 */
export async function initializePricingFeed(
  root: string,
  options: PricingFeedOptions = {},
): Promise<void> {
  const path = join(root, CACHE_FILE);
  const cached = await readCache(path);
  applySnapshot(cached?.rates ?? {});

  if (!needsRefresh(cached)) return;

  const url = options.url ??
    process.env.AGENT_USAGE_STAT_PRICING_FEED_URL ??
    DEFAULT_FEED_URL;
  const attemptedAt = new Date().toISOString();
  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(options.timeoutMs ?? FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const rates = extractFeedRates(await response.json());
    await writeCache(path, {
      source: url,
      fetchedAt: attemptedAt,
      attemptedAt,
      rates,
    });
    applySnapshot(rates);
    logHookEvent(
      `pricing feed refreshed models=${Object.keys(rates).length} fingerprint=${activeFingerprint}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logHookEvent(`pricing feed refresh failed: ${message}`);
    // Record the attempt so an offline machine retries on the backoff
    // interval instead of paying the fetch timeout on every capture.
    await writeCache(path, {
      source: url,
      fetchedAt: cached?.fetchedAt ?? "",
      attemptedAt,
      rates: cached?.rates ?? {},
    }).catch(() => undefined);
  }

  function needsRefresh(cache: FeedCacheFile | null): boolean {
    const now = Date.now();
    const fetchedAt = Date.parse(cache?.fetchedAt ?? "");
    const fresh = Number.isFinite(fetchedAt) &&
      now - fetchedAt < (options.refreshIntervalMs ?? REFRESH_INTERVAL_MS);
    if (fresh) return false;
    const attemptedAt = Date.parse(cache?.attemptedAt ?? "");
    return !Number.isFinite(attemptedAt) ||
      now - attemptedAt >= (options.retryIntervalMs ?? RETRY_INTERVAL_MS);
  }
}

/** Rates for a normalized model ID the baked tables missed, or null. */
export const feedPriceFor = (normalizedId: string): FeedRates | null =>
  activeRates[normalizedId] ?? null;

/** Identity of the active snapshot, pinned into transcript fingerprints. */
export const pricingFeedFingerprint = (): string => activeFingerprint;

/**
 * Extract per-MTok rates from the raw LiteLLM price map. Only first-party
 * "anthropic" and "openai" chat entries qualify — Bedrock, Vertex, and
 * reseller variants of the same models are excluded so one model cannot
 * resolve to conflicting rates. Keys iterate sorted, and the first normalized
 * key wins, so a bare alias ("claude-opus-5") beats its dated snapshots.
 */
export function extractFeedRates(raw: unknown): Record<string, FeedRates> {
  const rates: Record<string, FeedRates> = {};
  if (!raw || typeof raw !== "object") return rates;

  for (const key of Object.keys(raw as Record<string, unknown>).sort()) {
    const entry = (raw as Record<string, unknown>)[key];
    if (!entry || typeof entry !== "object" || key.includes("/")) continue;
    const fields = entry as Record<string, unknown>;
    const provider = fields.litellm_provider;
    if (provider !== "anthropic" && provider !== "openai") continue;
    const mode = fields.mode;
    if (mode !== "chat" && mode !== "responses") continue;
    const input = perTokenCost(fields.input_cost_per_token);
    const output = perTokenCost(fields.output_cost_per_token);
    if (input === null || output === null) continue;

    const normalized = normalizeModelId(key.toLowerCase());
    if (rates[normalized]) continue;
    const anthropic = provider === "anthropic";
    rates[normalized] = {
      input,
      output,
      cacheWrite: perTokenCost(fields.cache_creation_input_token_cost) ??
        trim(input * (anthropic ? ANTHROPIC_CACHE_WRITE_RATIO : 1)),
      // A missing read rate means the model has no published cache discount;
      // billing cache reads at the input rate never underbills.
      cacheRead: perTokenCost(fields.cache_read_input_token_cost) ??
        trim(input * (anthropic ? ANTHROPIC_CACHE_READ_RATIO : 1)),
    };
  }
  return rates;
}

function applySnapshot(rates: Record<string, FeedRates>): void {
  activeRates = rates;
  activeFingerprint = Object.keys(rates).length === 0
    ? "none"
    : createHash("sha256")
      .update(JSON.stringify(sortedEntries(rates)))
      .digest("hex")
      .slice(0, 16);
}

const sortedEntries = (rates: Record<string, FeedRates>): [string, FeedRates][] =>
  Object.keys(rates).sort().map((key) => [key, rates[key]]);

/** Per-token USD to per-MTok, or null when the field is absent or invalid. */
function perTokenCost(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return trim(value * 1e6);
}

/** Trim float multiplication noise so rates serialize stably. */
const trim = (value: number): number => Number(value.toPrecision(12));

async function readCache(path: string): Promise<FeedCacheFile | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as FeedCacheFile;
    if (!parsed || typeof parsed !== "object" || typeof parsed.rates !== "object") {
      return null;
    }
    for (const [key, value] of Object.entries(parsed.rates)) {
      if (
        !value ||
        ![value.input, value.output, value.cacheWrite, value.cacheRead]
          .every((rate) => typeof rate === "number" && Number.isFinite(rate))
      ) {
        delete parsed.rates[key];
      }
    }
    return parsed;
  } catch {
    return null;
  }
}

async function writeCache(path: string, cache: FeedCacheFile): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  const temp = `${path}.${process.pid}-${Date.now()}.tmp`;
  await writeFile(temp, JSON.stringify(cache), "utf-8");
  await rename(temp, path);
}
