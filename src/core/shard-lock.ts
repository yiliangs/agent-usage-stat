import { open, readFile, stat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

/**
 * The lock that serializes two writers on one shard.
 *
 * Detached hook workers for the same session can overlap, so one shard needs
 * one writer at a time. The lock used to be a bare file with no record of who
 * held it, and the three rules it inferred from that were all wrong (#109):
 * any lock older than 30 seconds was deleted, acquisition gave up after about
 * two seconds, and release unlinked whatever sat at the path. On a ledger
 * hosted by Google Drive File Stream, where one write can stall for seconds,
 * that is a lock stolen from a live writer, a capture that fails while a peer
 * is merely slow, and a release that hands a third writer a lock the second
 * one still holds.
 *
 * Writing the owner into the lock replaces every one of those guesses with a
 * check. A lock is stolen only from a process that is provably gone, waited on
 * long enough for a network-backed root to finish, and released only by the
 * writer that took it.
 */

/** The identity a lock file carries, so a waiter can ask about its owner. */
export interface ShardLockOwner {
  pid: number;
  host: string;
  nonce: string;
  acquired_at: string;
}

/** How long acquisition keeps trying. Sized for a stalling network root, not
 *  for a local disk: a capture that gives up loses the session's usage until
 *  the user runs a sync, while waiting costs a detached worker nothing. */
const ACQUIRE_TIMEOUT_MS = 60_000;

/** Retry delays, doubling from the first to the cap. Early contention is over
 *  in milliseconds; a Drive stall is not, and polling it 3000 times is waste. */
const FIRST_RETRY_MS = 20;
const MAX_RETRY_MS = 1_000;

/**
 * When a lock nobody can be shown to own is treated as abandoned.
 *
 * Two locks are unattributable: one written by another machine, whose pids
 * mean nothing here, and one still empty because its owner is between the
 * `open` that created it and the write that names it. Neither can be checked,
 * so both are presumed live until this ceiling, which exists only to free a
 * shard from a machine that died holding it. It is far longer than the acquire
 * budget on purpose: waiting out a live writer costs one deferred capture,
 * while stealing from one corrupts the shard both are writing.
 */
const ABANDONED_LOCK_MS = 600_000;

/**
 * Hold the lock for `path` while `action` runs, and release it after.
 *
 * The lock file is a sibling of the shard, so it lives on the same filesystem
 * and the same synced folder as the file it guards.
 */
export async function withShardLock<T>(
  path: string,
  action: () => Promise<T>,
): Promise<T> {
  const lockPath = `${path}.lock`;
  const owner: ShardLockOwner = {
    pid: process.pid,
    host: hostname(),
    nonce: randomUUID(),
    acquired_at: new Date().toISOString(),
  };

  const handle = await acquire(lockPath, owner);
  try {
    return await action();
  } finally {
    await release(lockPath, handle, owner);
  }
}

async function acquire(lockPath: string, owner: ShardLockOwner) {
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
  let retryIn = FIRST_RETRY_MS;

  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        // Name the owner immediately. A waiter reading an empty lock cannot
        // tell a writer mid-creation from a file nobody owns, and the window
        // between these two lines is the only time that is true.
        await handle.writeFile(JSON.stringify(owner));
        return handle;
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    // A lock whose owner is provably gone frees the shard at once. The `open`
    // above is what actually decides who takes it next, so two waiters racing
    // to clear the same dead lock still end up with one winner.
    if (await removeAbandonedLock(lockPath, owner)) continue;

    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for shard lock: ${lockPath}`);
    }
    await delay(retryIn);
    retryIn = Math.min(retryIn * 2, MAX_RETRY_MS);
  }
}

/** Remove a lock no live owner can be found for, and say whether it went. */
async function removeAbandonedLock(
  lockPath: string,
  self: ShardLockOwner,
): Promise<boolean> {
  let holder: ShardLockOwner | null;
  let ageMs: number;
  try {
    const [raw, info] = await Promise.all([
      readFile(lockPath, "utf-8"),
      stat(lockPath),
    ]);
    holder = parseOwner(raw);
    ageMs = Date.now() - info.mtimeMs;
  } catch {
    // Released between the failed open and this read. The next attempt takes
    // it; nothing here needs to remove anything.
    return false;
  }

  if (holder && holder.host === self.host) {
    // The one case that can be checked rather than guessed.
    if (isRunning(holder.pid)) return false;
    return await removeLock(lockPath);
  }

  if (ageMs > ABANDONED_LOCK_MS) return await removeLock(lockPath);
  return false;
}

async function removeLock(lockPath: string): Promise<boolean> {
  try {
    await unlink(lockPath);
    return true;
  } catch {
    // Another waiter cleared the same lock first, which is the outcome either
    // way: the path is free and the next open decides who holds it.
    return true;
  }
}

/**
 * Release a lock this process took.
 *
 * The nonce is what makes this different from unlinking the path. A lock stolen
 * while the action ran belongs to whoever took it, and deleting it would admit
 * a third writer beside the two already inside.
 */
async function release(
  lockPath: string,
  handle: Awaited<ReturnType<typeof open>>,
  owner: ShardLockOwner,
): Promise<void> {
  await handle.close().catch(() => undefined);
  try {
    const holder = parseOwner(await readFile(lockPath, "utf-8"));
    if (holder?.nonce !== owner.nonce) return;
    await unlink(lockPath);
  } catch {
    // Already gone, or unreadable and therefore not ours to remove.
  }
}

function parseOwner(raw: string): ShardLockOwner | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ShardLockOwner>;
    if (typeof parsed?.pid !== "number" || typeof parsed?.host !== "string") {
      return null;
    }
    return parsed as ShardLockOwner;
  } catch {
    return null;
  }
}

/** Whether a pid on this machine still names a process. */
function isRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH is the only answer that proves the owner is gone. EPERM means a
    // process holds the pid and is simply not ours to signal.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
