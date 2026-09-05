import { createHash } from "crypto";
import { pricingFeedFingerprint } from "../../core/pricing-feed.js";
import { pricingFingerprintSource } from "./pricing.js";
import { readFingerprintInputs } from "./transcript-reader.js";

const USAGE_ALGORITHM_VERSION = "opencode-usage-v1";

// Lazy, memoized on the feed fingerprint: the remote pricing feed loads after
// module import, so a version computed at import time would miss it.
let cachedVersion: { feed: string; version: string } | null = null;
function snapshotVersion(): string {
  const feed = pricingFeedFingerprint();
  if (cachedVersion?.feed !== feed) {
    cachedVersion = {
      feed,
      version: createHash("sha256")
        .update(USAGE_ALGORITHM_VERSION)
        .update(pricingFingerprintSource())
        .digest("hex")
        .slice(0, 16),
    };
  }
  return cachedVersion.version;
}

/**
 * Fingerprint the session tree those inputs were read from.
 *
 * The other providers hash a file tail because their transcript is a file.
 * opencode's transcript is a set of rows, so the equivalent cheap summary is
 * the tree's recorded token columns plus its message count and timestamp
 * aggregate — every one of them indexed or already on the session row.
 *
 * Hashing is separate from reading because a read that also produces usage
 * already holds the inputs: `readSessionRecords` carries them out of the same
 * snapshot, and hashing them there is what keeps a shard's fingerprint
 * describing the tree its cost came from.
 */
export function fingerprintFromInputs(inputs: string): string {
  const hash = createHash("sha256").update(inputs).digest("hex");
  return `${USAGE_ALGORITHM_VERSION}:${snapshotVersion()}:${hash}`;
}

/** Fingerprint one session tree without reading a single message body. */
export async function fingerprintSessionTree(
  databasePath: string,
  sessionId: string,
): Promise<string> {
  return fingerprintFromInputs(
    await readFingerprintInputs(databasePath, sessionId),
  );
}
