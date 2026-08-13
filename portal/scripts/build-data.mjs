#!/usr/bin/env node
/** Repository CLI adapter for the compiled portal data builder. */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { buildPortalData as buildCompiledPortalData } from "../../dist/desktop/portal-data.js";
import { resolveUsageRootFromDisk } from "../../dist/utils/usage-root.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Preserve the repository script's optional root and output conveniences. */
export async function buildPortalData(options = {}) {
  const root = options.root || resolveUsageRootFromDisk().root;
  const outDir = resolve(
    options.outDir || resolve(here, "../../dist/dev-portal/data"),
  );
  return buildCompiledPortalData({ root, outDir });
}

function cliOption(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = cliOption("--root") || process.env.AGENT_USAGE_STAT_DATA_ROOT;
  const outDir = cliOption("--output");
  buildPortalData({ root, outDir }).catch((error) => {
    console.error(`[build-data] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
