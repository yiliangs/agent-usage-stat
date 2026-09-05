import { createHash } from "crypto";
import { open } from "fs/promises";
import { pricingFeedFingerprint } from "../../core/pricing-feed.js";
import { pricingFingerprintSource } from "./pricing.js";
import { TAIL_BYTES } from "./transcript-reader.js";

const USAGE_ALGORITHM_VERSION = "copilot-usage-v2";

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

export async function fingerprintTranscriptFile(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    const length = Math.min(info.size, TAIL_BYTES);
    const tail = Buffer.alloc(length);
    const { bytesRead } = await handle.read(
      tail,
      0,
      length,
      Math.max(0, info.size - length),
    );
    const hash = createHash("sha256")
      .update(tail.subarray(0, bytesRead))
      .digest("hex");
    return `${USAGE_ALGORITHM_VERSION}:${snapshotVersion()}:${info.size}:${hash}`;
  } finally {
    await handle.close();
  }
}
