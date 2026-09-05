/**
 * The order in which a data-root change reaches the parts that hold it.
 *
 * Config, the shard watcher, and the rendered snapshot each carry the root
 * separately, so the move is only finished when all three name the same
 * folder. Connecting the capture hooks is a separate concern: it can fail on a
 * folder that is perfectly good for the ledger, such as a sync target an agent
 * config cannot be written into, and its failure is reported on its own terms.
 * Gating the move on it left config pointing at the new folder while the
 * watcher stayed armed on the old one and the dashboard kept rendering the old
 * snapshot, a disagreement that survived until the next launch.
 *
 * So the ledger move completes first and the setup attempt runs last, with its
 * outcome returned rather than thrown: a caller that wants to say "the folder
 * moved, hooks are not connected" has both facts.
 *
 * Electron-free by design, so the sequence is testable without a desktop
 * shell. Every step is a callback the caller binds.
 */

export interface DataRootChangeSteps {
  /** Persist the new root as the configured data root. */
  configure: (root: string) => Promise<void>;
  /** Discard the recorded setup state, so the next attempt runs fresh. */
  resetSetup: () => Promise<void>;
  /** Rebuild the analytics snapshot from the new root. */
  refresh: () => Promise<void>;
  /** Repoint the shard watcher at the new root. */
  watch: (root: string) => Promise<void>;
  /** Show the rebuilt snapshot. */
  reload: () => Promise<void>;
  /** Connect capture hooks, reporting whether they are now in place. */
  ensureSetup: () => Promise<boolean>;
}

export interface DataRootChangeResult {
  /** False when the ledger moved but capture hooks are not connected. */
  setupReady: boolean;
}

/** Move the usage ledger to `root`, then reconnect capture. */
export async function changeDataRoot(
  root: string,
  steps: DataRootChangeSteps,
): Promise<DataRootChangeResult> {
  await steps.configure(root);
  await steps.resetSetup();
  await steps.refresh();
  await steps.watch(root);
  await steps.reload();
  return { setupReady: await steps.ensureSetup() };
}
