#!/usr/bin/env node
// Recompute and record one session directly from its transcript.
import { detectProvider } from "../dist/providers/registry.js";
import { ConfigManager } from "../dist/core/config-manager.js";
import { LogbookWriter } from "../dist/core/logbook-writer.js";
import { initializePricingFeed } from "../dist/core/pricing-feed.js";
import { resolveUsageRoot } from "../dist/utils/usage-root.js";

const [, , sessionId, transcriptPath] = process.argv;
if (!sessionId || !transcriptPath) {
  console.error("usage: regen-session.mjs <sessionId> <transcriptPath>");
  process.exit(1);
}

const config = await new ConfigManager().loadConfig();
const root = resolveUsageRoot(config).root;
// Same order capture and sync use: the snapshot must be active before pricing,
// or a regen prices feed-only models at $0 and pins a fingerprint no capture
// would ever write.
await initializePricingFeed(root);

const provider = await detectProvider(transcriptPath);
const { sessionData, transcriptData } = await provider.readSession(
  transcriptPath,
  sessionId,
);
const path = await new LogbookWriter().append(root, {
  sessionData,
  transcriptData,
});

console.log(
  `recorded ${provider.name} session ${sessionId}: ${sessionData.totalTokens} tokens, ` +
    `$${sessionData.totalCost.toFixed(2)} -> ${path}`,
);
