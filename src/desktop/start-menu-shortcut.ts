import { readdir, rename, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Where the Start Menu entry belongs, and how it gets there.
 *
 * Windows lists a shortcut file sitting directly under `Programs` as an
 * application and a subdirectory as a folder to expand. Squirrel only knows
 * how to write into a subdirectory named after the nuspec authors, and that
 * same field is the uninstall entry's Publisher, so the author name stays as
 * it is and the application moves its own entry into place afterwards (#72).
 */

/** The per-user Start Menu directory Windows enumerates applications from. */
export function startMenuProgramsDir(env: NodeJS.ProcessEnv): string {
  const roaming = env.APPDATA
    ?? join(env.USERPROFILE ?? env.HOME ?? "", "AppData", "Roaming");
  return join(roaming, "Microsoft", "Windows", "Start Menu", "Programs");
}

/** Squirrel names the shortcut after the executable it points at. */
export function startMenuShortcutName(executableName: string): string {
  return `${executableName.replace(/\.exe$/i, "")}.lnk`;
}

/** Move the shortcut Squirrel just wrote up to the application list. */
export async function promoteStartMenuShortcut(
  programs: string,
  shortcutName: string,
): Promise<void> {
  for (const folder of await foldersHoldingShortcut(programs, shortcutName)) {
    await rename(join(folder, shortcutName), join(programs, shortcutName));
    await discardEmptyFolder(folder);
  }
}

/** Take the application out of the Start Menu, wherever it currently sits. */
export async function removeStartMenuShortcut(
  programs: string,
  shortcutName: string,
): Promise<void> {
  await rm(join(programs, shortcutName), { force: true });
  for (const folder of await foldersHoldingShortcut(programs, shortcutName)) {
    await rm(join(folder, shortcutName), { force: true });
    await discardEmptyFolder(folder);
  }
}

/**
 * The search is by shortcut rather than by the author the package declares,
 * so an installation carrying a folder from an earlier author name is emptied
 * and cleared on the next update instead of being left orphaned.
 */
async function foldersHoldingShortcut(
  programs: string,
  shortcutName: string,
): Promise<string[]> {
  const entries = await readdir(programs, { withFileTypes: true })
    .catch(() => []);
  const holders: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const folder = join(programs, entry.name);
    const held: string[] = await readdir(folder).catch(() => []);
    if (held.includes(shortcutName)) holders.push(folder);
  }
  return holders;
}

/** A folder Squirrel created for one application has nothing else to hold. */
async function discardEmptyFolder(folder: string): Promise<void> {
  await rmdir(folder).catch(() => undefined);
}
