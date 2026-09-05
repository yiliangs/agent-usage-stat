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

/**
 * The environment resolution reads. Every field is optional and falls back to
 * this process, so production callers pass nothing and a test can state the
 * platform, the home, the mounts to probe, and the config file to read.
 */
export interface UsageRootRuntime {
  platform?: NodeJS.Platform;
  home?: string;
  localAppData?: string;
  /** Mount directories to probe instead of the platform's own candidates. */
  driveMounts?: string[];
  /** Config file to read instead of the one in the home directory. */
  configPath?: string;
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

export function resolveUsageRoot(
  config: { dataRoot?: string },
  runtime: UsageRootRuntime = {},
): ResolvedUsageRoot {
  const configured = config.dataRoot?.trim();
  if (configured) {
    return { root: expandHome(configured, runtime.home), source: "config" };
  }

  const detected = detectSharedUsageRoot(runtime);
  if (detected) {
    return { root: detected, source: "detected" };
  }

  return { root: defaultUsageRoot(runtime), source: "default" };
}

export function resolveUsageRootFromDisk(
  runtime: UsageRootRuntime = {},
): ResolvedUsageRoot {
  let config: { dataRoot?: string } = {};
  try {
    const path = runtime.configPath ?? configFilePath();
    config = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    // Missing or invalid config falls through to detection and local default.
  }
  return resolveUsageRoot(config, runtime);
}

export function detectSharedUsageRoot(
  runtime: UsageRootRuntime = {},
): string | null {
  for (const mount of driveMountCandidates(runtime)) {
    const root = join(mount, SHARED_DIR_NAME);
    if (existsSync(join(root, LOGBOOK_SHARD_DIR))) {
      return root;
    }
  }
  return null;
}

function driveMountCandidates(runtime: UsageRootRuntime): string[] {
  if (runtime.driveMounts) {
    return runtime.driveMounts;
  }

  const platform = runtime.platform ?? process.platform;
  const home = runtime.home ?? homeDir();
  const candidates: string[] = [];

  if (platform === "win32") {
    for (let c = "D".charCodeAt(0); c <= "Z".charCodeAt(0); c++) {
      candidates.push(`${String.fromCharCode(c)}:/My Drive`);
    }
    candidates.push(join(home, "Google Drive"), join(home, "My Drive"));
  } else if (platform === "darwin") {
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
