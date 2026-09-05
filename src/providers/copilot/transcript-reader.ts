import { open, readFile } from "fs/promises";
import { expandHome } from "../../utils/paths.js";
import type { CopilotEvent } from "./transcript-format.js";

/**
 * How much of a transcript a bounded read covers, shared with the fingerprint
 * so the window discovery inspects is the window a change is detected in.
 */
export const TAIL_BYTES = 64 * 1024;

/** Read JSONL with per-line isolation so a partial tail never sinks a session. */
export async function readCopilotEvents(path: string): Promise<CopilotEvent[]> {
  const content = await readFile(expandHome(path), "utf-8");
  const events: CopilotEvent[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as CopilotEvent);
    } catch {
      // Copilot may still be appending the final line.
    }
  }
  return events;
}

/**
 * Whether a session declared itself complete, read from the tail alone.
 *
 * Copilot writes the shutdown aggregate as the last record, so a shutdown
 * record that is not within the tail is not a completed session. That rule is
 * what lets discovery cost a bounded read per session rather than a full parse
 * of every historical transcript on every launch.
 */
export async function hasShutdownRecord(path: string): Promise<boolean> {
  const handle = await open(expandHome(path), "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, TAIL_BYTES);
    const offset = Math.max(0, size - length);
    const tail = Buffer.alloc(length);
    const { bytesRead } = await handle.read(tail, 0, length, offset);
    const lines = tail.subarray(0, bytesRead).toString("utf-8").split("\n");
    // A tail that starts mid-file opens on a fragment of the line it landed in.
    if (offset > 0) lines.shift();
    return lines.some(isShutdownRecord);
  } finally {
    await handle.close();
  }
}

/** The substring test is the cheap filter; the parse is what decides. */
function isShutdownRecord(line: string): boolean {
  if (!line.includes("session.shutdown")) return false;
  try {
    return (JSON.parse(line) as CopilotEvent).type === "session.shutdown";
  } catch {
    return false;
  }
}
