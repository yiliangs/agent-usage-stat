/**
 * A ledger with nothing in it, which is what a freshly set up install has
 * until its first session is captured.
 *
 * Every window the portal draws is derived from the data except the one ALL
 * asks for, which starts on the oldest session recorded. With no session
 * recorded there is no such instant, so this fixture is the one input that
 * separates a window computed from the ledger from a window computed from a
 * day count.
 *
 * `meta.json` still describes a real snapshot: the build writes one whether or
 * not it found shards, and the header prints its timestamp regardless.
 */

/** `sessions.json` and `meta.json` as the desktop build writes them for an
 *  install that has captured nothing. */
export function buildEmptyLedgerFixture(now = Date.now()) {
  const meta = {
    generatedAt: new Date(now).toISOString(),
    source: "fixture",
    shardDir: "fixture/logbook.d",
    sessions: 0,
    projects: 0,
    machines: 0,
    totalCost: 0,
    parsedShards: 0,
    reusedShards: 0,
    span: null,
  };
  return { "sessions.json": [], "meta.json": meta };
}

/** The hero figure on an empty ledger, as `usdHeadline(0)` prints it. */
export const ZERO_COST_TEXT = "$0.00";

/** A counted quantity on an empty ledger: sessions, and tokens through
 *  `compact(0)`. */
export const ZERO_COUNT_TEXT = "0";

/** The folio, which counts the selected period against the whole ledger. */
export const ZERO_FOLIO_TEXT = "00 / 00";

/** What every comparison against a period that does not exist reads. */
export const NO_PRIOR_TEXT = "No prior baseline";

/**
 * Sample readings `portal/index.html` ships in its markup, which a render
 * overwrites.
 *
 * They are a design sample, not data, and are why a render that aborts partway
 * is worse than one that draws nothing: the reader is left looking at someone
 * else's spend as if it were their own. Any of these still on the page means
 * the render stopped before the panel holding it.
 *
 * These are drawn from panels the guard does not read a value out of, one per
 * renderer downstream of the header, so between them they say how far a render
 * reached.
 */
export const PLACEHOLDER_FIGURES = [
  "PEAK / $56.18",
  "Fable / largest",
  "INPUT 1.66M",
  "Three projects account for 63% of period value",
];
