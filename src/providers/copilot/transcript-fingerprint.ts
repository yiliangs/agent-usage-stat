import { createHash } from "crypto";
import { open } from "fs/promises";
import { pricingFingerprintSource } from "./pricing.js";

const TAIL_BYTES = 64 * 1024;
const USAGE_ALGORITHM_VERSION = "copilot-usage-v2";
const VERSION = createHash("sha256")
  .update(USAGE_ALGORITHM_VERSION)
  .update(pricingFingerprintSource())
  .digest("hex")
  .slice(0, 16);

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
    return `${USAGE_ALGORITHM_VERSION}:${VERSION}:${info.size}:${hash}`;
  } finally {
    await handle.close();
  }
}
