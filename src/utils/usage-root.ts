/**
 * Canonical usage-data root resolution.
 *
 * Every shard writer and portal reader must resolve the same directory:
 *
 *   1. `dataRoot` in ~/.agent-usage-stat.config.json
 *   2. an existing shared root on a Google Drive mount
 *   3. the platform-native per-user Agent Usage Stat ledger directory
 *
 * Shared-root detection only accepts a directory that already contains
 * `logbook.d/`. It never creates a new cloud directory implicitly.
 */

import { existsSync, readFileSync, readdirSync } from "fs";
import { join, posix, win32 } from "path";
import { LOGBOOK_SHARD_DIR } from "../core/usage-ledger.js";
import { homeDir, expandHome, configFilePath } from "./paths.js";

const SHARED_DIR_NAME = "agent-usage-stat";

export type UsageRootSource = "config" | "detected" | "default";

export interface ResolvedUsageRoot {
  root: string;
  source: UsageRootSource;
}

export interface UsageRootRuntime {
  platform?: NodeJS.Platform;
  home?: string;
  localAppData?: string;
}

/** The application-owned ledger location offered to a new desktop user. */
export function defaultUsageRoot(runtime: UsageRootRuntime = {}): string {
  const platform = runtime.platform ?? process.platform;
  const home = runtime.home ?? homeDir();

  if (platform === "win32") {
    const localAppData = runtime.localAppData ??
      process.env.LOCALAPPDATA ??
      win32.join(home, "AppData", "Local");
    return win32.join(localAppData, "Agent Usage Stat", "ledger");
  }
  if (platform === "darwin") {
    return posix.join(
      home,
      "Library",
      "Application Support",
      "Agent Usage Stat",
      "ledger",
    );
  }
  return join(home, ".agent-usage-stat", "data");
}

export function resolveUsageRoot(config: {
  dataRoot?: string;
}): ResolvedUsageRoot {
  const configured = config.dataRoot?.trim();
  if (configured) {
    return { root: expandHome(configured), source: "config" };
  }

  const detected = detectSharedUsageRoot();
  if (detected) {
    return { root: detected, source: "detected" };
  }

  return { root: defaultUsageRoot(), source: "default" };
}

export function resolveUsageRootFromDisk(): ResolvedUsageRoot {
  let config: { dataRoot?: string } = {};
  try {
    config = JSON.parse(readFileSync(configFilePath(), "utf-8"));
  } catch {
    // Missing or invalid config falls through to detection and local default.
  }
  return resolveUsageRoot(config);
}

export function detectSharedUsageRoot(): string | null {
  for (const mount of driveMountCandidates()) {
    const root = join(mount, SHARED_DIR_NAME);
    if (existsSync(join(root, LOGBOOK_SHARD_DIR))) {
      return root;
    }
  }
  return null;
}

function driveMountCandidates(): string[] {
  const home = homeDir();
  const candidates: string[] = [];

  if (process.platform === "win32") {
    for (let c = "D".charCodeAt(0); c <= "Z".charCodeAt(0); c++) {
      candidates.push(`${String.fromCharCode(c)}:/My Drive`);
    }
    candidates.push(join(home, "Google Drive"), join(home, "My Drive"));
  } else if (process.platform === "darwin") {
    const cloudStorage = join(home, "Library", "CloudStorage");
    try {
      for (const entry of readdirSync(cloudStorage)) {
        if (entry.startsWith("GoogleDrive-")) {
          candidates.push(join(cloudStorage, entry, "My Drive"));
        }
      }
    } catch {
      // Google Drive is not installed or uses an older mount layout.
    }
    candidates.push(join(home, "Google Drive"));
  }

  return candidates;
}
