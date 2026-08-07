import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  openSync,
  readSync,
  closeSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { spawn } from "child_process";
import { logHookEvent } from "../utils/hook-log.js";
import { createCorrelatedInputPath } from "../utils/capture-run.js";
import type { HookData } from "../types/session-hook.js";

/**
 * The capture options the shim needs to forward to the worker.
 * Declared locally so this module's import graph stays limited to Node
 * built-ins. Fast startup is the whole point of the shim.
 */
export interface DetachShimOptions {
  quiet?: boolean;
  /** Arguments placed before the worker command when re-launching this runtime. */
  workerArgsPrefix?: string[];
}

/**
 * Shim path: read stdin synchronously, write it to a temp file, spawn the real
 * worker as a detached child, exit. The shim deliberately avoids config
 * loading, transcript parsing, and usage calculation. Importing those modules
 * here would push the worker spawn past Claude Code's SessionEnd teardown on
 * /exit, which kills the still-starting hook ("hook cancelled") before it can
 * spawn anything. Importing only built-ins keeps the shim at ~0.3s so the
 * detached worker is launched well inside the teardown window. The worker reads
 * the temp file and unlinks it when done.
 */
export function runDetachShim(options: DetachShimOptions): void {
  logHookEvent(`shim pid=${process.pid} cwd=${process.cwd()}`);

  let raw = "";
  try {
    raw = readFileSync(0, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    logHookEvent(`shim stdin read failed: ${msg}`);
    return;
  }

  if (!raw.trim()) {
    logHookEvent(`shim stdin empty — nothing to do`);
    return;
  }

  // Skip non-interactive sessions. Headless SDK / `claude -p` runs (e.g.
  // background automations) each end with reason=other and would otherwise
  // record automation probes as real interactive work. They are identified
  // by the transcript's entrypoint
  // ("sdk-cli"); interactive runs report "cli". Override with
  // AGENT_USAGE_STAT_ALL_SESSIONS=1.
  if (
    hookEventName(raw) === "SessionEnd" &&
    !process.env.AGENT_USAGE_STAT_ALL_SESSIONS
  ) {
    const entrypoint = hookTranscriptEntrypoint(raw);
    if (entrypoint && entrypoint.startsWith("sdk")) {
      logHookEvent(`shim skip: non-interactive entrypoint=${entrypoint}`);
      return;
    }
  }

  const captureId = randomBytes(12).toString("hex");
  const fallbackFile = join(
    tmpdir(),
    `agent-usage-stat-hook-${Date.now()}-${captureId}.json`,
  );
  const correlatedFile = createCorrelatedInputPath(
    process.env.AGENT_USAGE_STAT_RUN_ID,
    captureId,
  );
  let tmpFile = correlatedFile || fallbackFile;

  try {
    writeFileSync(tmpFile, raw, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    if (!correlatedFile) {
      logHookEvent(`shim temp write failed: ${msg}`);
      return;
    }

    logHookEvent(
      `shim correlated write failed run=${process.env.AGENT_USAGE_STAT_RUN_ID} capture=${captureId}: ${msg}`,
    );
    tmpFile = fallbackFile;
    try {
      writeFileSync(tmpFile, raw, "utf-8");
    } catch (fallbackError) {
      const fallbackMessage =
        fallbackError instanceof Error ? fallbackError.message : "unknown";
      logHookEvent(`shim temp write failed: ${fallbackMessage}`);
      return;
    }
  }

  const args = [
    ...(options.workerArgsPrefix ?? [process.argv[1]]),
    "capture",
    "--input-file",
    tmpFile,
  ];
  if (options.quiet) {
    args.push("--quiet");
  }

  try {
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    const correlation =
      correlatedFile && tmpFile === correlatedFile
        ? ` run=${process.env.AGENT_USAGE_STAT_RUN_ID} capture=${captureId}`
        : "";
    logHookEvent(
      `shim spawned worker pid=${child.pid} tmp=${tmpFile}${correlation}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    logHookEvent(`shim spawn failed: ${msg}`);
    if (!correlatedFile || tmpFile !== correlatedFile) {
      try {
        unlinkSync(tmpFile);
      } catch {
        // best-effort cleanup
      }
    }
  }
}

/**
 * Peek at the SessionEnd hook JSON (raw stdin) to find the transcript, then
 * read the head of that transcript for its `entrypoint`. Interactive runs
 * report "cli"; headless SDK runs report "sdk-cli". Only the first chunk is
 * read — these transcripts can be hundreds of MB. Returns null when it can't
 * be determined (missing file, unparseable JSON, entrypoint not in the head)
 * so the caller errs toward recording usage rather than dropping a real one.
 */
function hookTranscriptEntrypoint(rawHookJson: string): string | null {
  let transcriptPath: string | undefined;
  try {
    transcriptPath =
      (JSON.parse(rawHookJson) as HookData).transcript_path || undefined;
  } catch {
    return null;
  }
  if (!transcriptPath) return null;

  let fd: number | undefined;
  try {
    fd = openSync(transcriptPath, "r");
    const buf = Buffer.alloc(131072); // 128 KB head — entrypoint is on the first message record
    const n = readSync(fd, buf, 0, buf.length, 0);
    const head = buf.toString("utf-8", 0, n);
    const match = /"entrypoint"\s*:\s*"([^"]+)"/.exec(head);
    return match ? match[1] : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore close errors
      }
    }
  }
}

function hookEventName(rawHookJson: string): string | null {
  try {
    return (JSON.parse(rawHookJson) as HookData).hook_event_name || null;
  } catch {
    return null;
  }
}
