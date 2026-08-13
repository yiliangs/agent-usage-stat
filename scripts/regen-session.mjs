#!/usr/bin/env node
// Recompute and record one session directly from its transcript.
import { detectProvider } from "../dist/providers/registry.js";
import { ConfigManager } from "../dist/core/config-manager.js";
import { LogbookWriter } from "../dist/core/logbook-writer.js";
import { resolveUsageRoot } from "../dist/utils/usage-root.js";

const [, , sessionId, transcriptPath] = process.argv;
if (!sessionId || !transcriptPath) {
  console.error("usage: regen-session.mjs <sessionId> <transcriptPath>");
  process.exit(1);
}

const provider = await detectProvider(transcriptPath);
const { sessionData, transcriptData } = await provider.readSession(
  transcriptPath,
  sessionId,
);
const config = await new ConfigManager().loadConfig();
const root = resolveUsageRoot(config).root;
const path = await new LogbookWriter().append(root, {
  sessionData,
  transcriptData,
});

console.log(
  `recorded ${provider.name} session ${sessionId}: ${sessionData.totalTokens} tokens, ` +
    `$${sessionData.totalCost.toFixed(2)} -> ${path}`,
);
