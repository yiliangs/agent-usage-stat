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

/** A config file that exists but could not be read or parsed. */
export interface UsageRootConfigFault {
  path: string;
  reason: string;
}

export interface ResolvedUsageRoot {
  root: string;
  source: UsageRootSource;
  /**
   * Present only when a config file is there and unreadable. Resolution still
   * falls through to detection and the default, so captures keep landing
   * somewhere; this is what lets a caller say that the configured ledger was
   * abandoned rather than chosen.
   */
  configFault?: UsageRootConfigFault;
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
  const path = runtime.configPath ?? configFilePath();
  let config: { dataRoot?: string } = {};
  let configFault: UsageRootConfigFault | undefined;

  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (parsed === null || typeof parsed !== "object") {
      throw new Error("the config file does not hold a JSON object");
    }
    config = parsed as { dataRoot?: string };
  } catch (error) {
    // No config at all is the ordinary state before the first run, and it
    // resolves silently. Anything else means a config is there and the root it
    // names could not be read: a truncated write, a permission change, a
    // half-synced file. Resolution still falls through to detection and the
    // local default so captures keep landing somewhere, but silence there is
    // what #126 reports — the configured ledger is abandoned, nothing looks
    // broken, and the folder the user chose simply stops filling. The fault
    // rides along so the one caller that can say so does.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      configFault = {
        path,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const resolved = resolveUsageRoot(config, runtime);
  return configFault ? { ...resolved, configFault } : resolved;
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
