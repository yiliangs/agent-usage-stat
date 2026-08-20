import { createHash } from "crypto";
import { open } from "fs/promises";
import { pricingFeedFingerprint } from "../../core/pricing-feed.js";
import { pricingFingerprintSource } from "./pricing.js";
import { findSessionTranscriptFiles } from "./session-files.js";

const TAIL_BYTES = 64 * 1024;
const USAGE_ALGORITHM_VERSION = "claude-usage-v4";

// Computed lazily, not at module load: the remote pricing feed is initialized
// by the invoking command, and a version frozen at import time would pin every
// fingerprint to the pre-initialization feed state. Memoized on the feed
// fingerprint, the only input that changes within a process.
let cachedVersion: { feed: string; version: string } | null = null;
export function claudeSnapshotVersion(): string {
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

export async function fingerprintSessionTranscript(
  mainPath: string,
  sessionId: string,
): Promise<string> {
  const files = await findSessionTranscriptFiles(mainPath, sessionId);
  const parts: string[] = [];
  for (const file of files) {
    parts.push(await fingerprintTranscriptFilePart(file));
  }
  return fingerprintTranscriptParts(parts);
}

export function fingerprintTranscriptContentPart(content: string): string {
  const bytes = Buffer.from(content, "utf-8");
  return fingerprintPart(
    bytes.length,
    bytes.subarray(Math.max(0, bytes.length - TAIL_BYTES)),
  );
}

export function fingerprintTranscriptParts(parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of [...parts].sort()) hash.update(part).update("\n");
  return `${USAGE_ALGORITHM_VERSION}:${claudeSnapshotVersion()}:${parts.length}:${hash.digest("hex")}`;
}

async function fingerprintTranscriptFilePart(path: string): Promise<string> {
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
    return fingerprintPart(info.size, tail.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

function fingerprintPart(size: number, tail: Buffer): string {
  return `${size}:${createHash("sha256").update(tail).digest("hex")}`;
}

export function fingerprintTranscriptTail(size: number, tail: Buffer): string {
  return fingerprintPart(size, tail);
}
