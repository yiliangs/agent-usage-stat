import { realpathSync, watch, type FSWatcher } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { LOGBOOK_SHARD_DIR } from "../core/usage-ledger.js";

/**
 * Debounced observer of logbook shard writes, so an open dashboard refreshes
 * itself when detached hook captures land instead of waiting for the refresh
 * button or the next launch.
 *
 * Shard writes arrive in bursts (a capture writes temp files and renames, and
 * several sessions can land together), so events are coalesced: the callback
 * fires once per quiet period, not once per event. Events that arrive while
 * the callback is running simply schedule the next quiet period — the refresh
 * a callback triggers rewrites nothing when records are already current, so a
 * self-triggered follow-up settles after one no-op cycle.
 *
 * Electron-free by design: the module watches the filesystem only, which keeps
 * it testable without a desktop shell. Watch failures disable auto-refresh
 * silently — the manual refresh path stays authoritative.
 */
export class LogbookWatcher {
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private notifying = false;
  private rearmed = false;

  constructor(
    private readonly onSettled: () => Promise<void>,
    private readonly quietMs = 1500,
  ) {}

  /** Watch the shard directory under `root`, replacing any previous target. */
  async start(root: string): Promise<void> {
    this.stop();
    const shardDir = join(root, LOGBOOK_SHARD_DIR);
    try {
      await mkdir(shardDir, { recursive: true });
      // Windows reports a change against the directory in its long form, so
      // a watcher opened on an 8.3 short path fails libuv's prefix assertion
      // and aborts the process. os.tmpdir() alone resolves to one on a default
      // profile, and a libuv abort is not catchable here, so resolve first.
      this.watcher = watch(realpathSync.native(shardDir), () => this.handleEvent());
      this.watcher.on("error", () => this.stop());
    } catch {
      this.watcher = null;
    }
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.watcher?.close();
    this.watcher = null;
  }

  private handleEvent(): void {
    if (this.notifying) {
      this.rearmed = true;
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.notify();
    }, this.quietMs);
  }

  private async notify(): Promise<void> {
    this.notifying = true;
    try {
      await this.onSettled();
    } finally {
      this.notifying = false;
      if (this.rearmed) {
        this.rearmed = false;
        // Only re-fires while the watcher is still active.
        if (this.watcher) this.handleEvent();
      }
    }
  }
}
