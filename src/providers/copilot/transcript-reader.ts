import { readFile } from "fs/promises";
import { expandHome } from "../../utils/paths.js";
import type { CopilotEvent } from "./transcript-format.js";

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
