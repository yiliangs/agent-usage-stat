/**
 * Home-directory resolution, centralized.
 *
 * Windows names the home directory $USERPROFILE, and $HOME is not simply
 * absent there: a Git Bash session, a roaming profile, or a home-drive setup
 * sets it, pointing somewhere else. Reading $HOME first therefore splits the
 * application's view of its own state (#119) — the Electron app launched from
 * Explorer resolves the profile while a helper spawned by a host started
 * inside such a shell resolves $HOME, and the two read different config files,
 * so hook-driven captures write to the default ledger while the dashboard
 * reads the configured one.
 *
 * The precedence is the platform's, not the caller's, and every path in the
 * application derives from it, so it lives here alone. A caller holding
 * another process's environment applies the same rule to it through
 * `homeDirFrom` rather than re-deriving the order.
 *
 * Built-ins only — no third-party imports — so this stays cheap to load and
 * safe for any module to depend on.
 */

/** The user's home directory, or "" if neither variable is set. */
export function homeDir(): string {
  return homeDirFrom(process.env);
}

/**
 * The same rule against a captured environment, such as one about to be handed
 * to a spawned helper. Falls back to nothing rather than to this process's own
 * home, so a caller can tell an empty environment from a resolved one.
 */
export function homeDirFrom(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string {
  const profile = environment.USERPROFILE || "";
  const home = environment.HOME || "";
  return platform === "win32" ? profile || home : home || profile;
}

/**
 * Absolute path of the user config file. Shared by ConfigManager (async R/W)
 * and usage-root.ts (sync read from scripts/portal), so the location can't
 * drift between the two.
 */
export function configFilePath(): string {
  return `${homeDir()}/.agent-usage-stat.config.json`;
}

/**
 * Expand a leading "~" to the home directory. Leaves any other path untouched.
 * Matches the prior inline behavior (`replace(/^~/, home)`).
 */
export function expandHome(path: string): string {
  return path.replace(/^~/, homeDir());
}
