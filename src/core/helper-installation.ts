/**
 * Installs the helper executable that the agent hooks invoke.
 *
 * The hooks run this binary at every session end whether or not the desktop
 * application has ever been launched, so whoever refreshes the application
 * payload has to refresh the helper in the same breath. Deferring it to the
 * next launch leaves capture running last release's pricing on a machine whose
 * owner rarely opens the dashboard, which is the ordinary case for a tool that
 * lives in the notification area.
 *
 * Both callers reach the machine through here — the application's startup sync
 * and the local-iteration installer — so there is one staged copy, one
 * rollback, and one recorded state rather than a second implementation in a
 * script.
 *
 * The staging is not decoration. A detached hook worker can hold the helper
 * open, and Windows refuses to overwrite a running executable while still
 * permitting it to be renamed, so the installed path is renamed aside and the
 * replacement renamed into place.
 */
import { existsSync } from "fs";
import { chmod, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "fs/promises";
import { join } from "path";
import { installedHelperPath, installedHelperStatePath } from "./application-paths.js";

/** The helper's file name on a given platform. */
export const helperBinaryName = (
  platform: NodeJS.Platform = process.platform,
): string =>
  platform === "win32" ? "agent-usage-stat-helper.exe" : "agent-usage-stat-helper";

/** The recorded identity of the installed helper, or null when unreadable. */
export async function installedHelperVersion(): Promise<string | null> {
  try {
    const state = JSON.parse(
      await readFile(installedHelperStatePath(), "utf8"),
    ) as { version?: string };
    return state.version ?? null;
  } catch {
    // Missing or invalid state requires reinstalling the helper.
    return null;
  }
}

/**
 * Put `source` in place as the installed helper and record `version`.
 * Returns whether the binary was actually replaced; an identical binary
 * already in place only refreshes the recorded state.
 */
export async function installHelperBinary(
  source: string,
  version: string,
): Promise<boolean> {
  const destination = installedHelperPath();
  if (!existsSync(source)) {
    throw new Error(`Bundled application helper is missing: ${source}`);
  }

  await mkdir(join(destination, ".."), { recursive: true });
  if (await filesEqual(source, destination)) {
    await writeHelperState(version);
    return false;
  }

  const staged = `${destination}.${process.pid}.new`;
  const previous = `${destination}.previous`;
  await copyFile(source, staged);
  if (process.platform !== "win32") await chmod(staged, 0o755);

  try {
    await rm(previous, { force: true });
    if (existsSync(destination)) await rename(destination, previous);
    await rename(staged, destination);
    await rm(previous, { force: true });
    await writeHelperState(version);
    return true;
  } catch (error) {
    await rm(staged, { force: true }).catch(() => undefined);
    if (!existsSync(destination) && existsSync(previous)) {
      await rename(previous, destination).catch(() => undefined);
    }
    throw error;
  }
}

const writeHelperState = (version: string): Promise<void> =>
  writeFile(
    installedHelperStatePath(),
    JSON.stringify({ version }, null, 2),
    "utf8",
  );

async function filesEqual(left: string, right: string): Promise<boolean> {
  try {
    const [leftStat, rightStat] = await Promise.all([stat(left), stat(right)]);
    if (leftStat.size !== rightStat.size) return false;
    const [leftData, rightData] = await Promise.all([
      readFile(left),
      readFile(right),
    ]);
    return leftData.equals(rightData);
  } catch {
    return false;
  }
}
