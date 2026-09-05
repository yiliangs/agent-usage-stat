import { constants } from "node:fs";
import { copyFile, rename, rm, writeFile } from "node:fs/promises";

/**
 * The one owner of replacing a file without ever exposing a half-written one.
 *
 * Five modules used to carry their own stage-and-rename, and the writer on the
 * hot path carried none: `LogbookWriter.append` truncated the live shard in
 * place on every SessionEnd (#84), and every third-party host config was
 * rewritten the same way (#114). A ledger root is routinely Google Drive File
 * Stream, where one write can stall for seconds, so the window between an
 * emptied file and a complete one is real rather than theoretical.
 *
 * Staging beside the target rather than in a temp directory is deliberate: the
 * rename is only atomic within one filesystem, and a sibling path is on the
 * same one by construction.
 *
 * Node built-ins only. `capture-run.ts` calls this on the detach-shim path, so
 * anything imported here is paid on every captured session.
 */

export interface AtomicWriteOptions {
  /** Permission bits for the staged file, carried through the rename. */
  mode?: number;
}

/** Write `content` and make it the whole content of `path`, or leave `path` as
 *  it was. Creates no directory: a caller that needs one still makes it. */
export async function writeFileAtomic(
  path: string,
  content: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const staged = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await writeFile(staged, content, {
      encoding: "utf-8",
      ...(options.mode === undefined ? {} : { mode: options.mode }),
    });
    await rename(staged, path);
  } catch (error) {
    // The staged bytes are ours alone, so removing them is safe and keeps a
    // failed write from leaving litter beside the file it could not replace.
    await rm(staged, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeJsonAtomic(
  path: string,
  value: unknown,
  space?: number,
  options: AtomicWriteOptions = {},
): Promise<void> {
  await writeFileAtomic(path, JSON.stringify(value, null, space), options);
}

/**
 * Copy `path` to `backupPath` only if no backup is there yet.
 *
 * The pristine pre-install state is what a backup is for, and it exists only
 * before the first install. Overwriting on every install replaces it with
 * already-modified content, which is what #114 reports. A missing source has
 * nothing to back up and is not an error.
 */
export async function backupOnce(
  path: string,
  backupPath: string,
): Promise<void> {
  try {
    await copyFile(path, backupPath, constants.COPYFILE_EXCL);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "ENOENT") throw error;
  }
}
