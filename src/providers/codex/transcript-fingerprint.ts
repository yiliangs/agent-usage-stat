import { createHash } from "crypto";
import { open } from "fs/promises";
import { pricingFeedFingerprint } from "../../core/pricing-feed.js";
import { pricingFingerprintSource } from "./pricing.js";

const TAIL_BYTES = 64 * 1024;
// Bump only for usage-parser semantic changes. Pricing-table changes are
// included automatically through pricingFingerprintSource().
const USAGE_ALGORITHM_VERSION = "codex-usage-v4";

// Lazy, memoized on the feed fingerprint: the remote pricing feed loads after
// module import, so a version computed at import time would miss it.
let cachedVersion: { feed: string; version: string } | null = null;
export function codexSnapshotVersion(): string {
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
  return `${USAGE_ALGORITHM_VERSION}:${cachedVersion.version}`;
}

/** Fingerprint append-only rollout content without hashing the full history. */
export function fingerprintTranscriptContent(content: string): string {
  const bytes = Buffer.from(content, "utf-8");
  return fingerprintTranscriptTail(
    bytes.length,
    bytes.subarray(Math.max(0, bytes.length - TAIL_BYTES)),
  );
}

/** Read only the final 64 KB so unchanged long-running sessions stay cheap. */
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
    return fingerprintTranscriptTail(info.size, tail.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

export function fingerprintTranscriptTail(size: number, tail: Buffer): string {
  const hash = createHash("sha256").update(tail).digest("hex");
  return `${codexSnapshotVersion()}:${size}:${hash}`;
}
