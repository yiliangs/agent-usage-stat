import { readdir, stat } from "fs/promises";
import { join } from "path";
import { homeDir } from "../../utils/paths.js";
import type { FoundSession } from "../../types/provider.js";
import { readCopilotEvents } from "./transcript-reader.js";

export class SessionFinder {
  private root: string;

  constructor(copilotHome = process.env.COPILOT_HOME || join(homeDir(), ".copilot")) {
    this.root = join(copilotHome, "session-state");
  }

  async find(query?: string): Promise<FoundSession> {
    const sessions = await this.findAll();
    const matches = query
      ? sessions.filter(
          (session) =>
            session.sessionId.startsWith(query) ||
            session.transcriptPath.toLowerCase().includes(query.toLowerCase()),
        )
      : sessions;
    if (matches.length === 0) {
      throw new Error(
        query
          ? `No Copilot session matching "${query}".`
          : `No completed Copilot sessions found under ${this.root}.`,
      );
    }
    return matches.sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  }

  async findAll(): Promise<FoundSession[]> {
    let entries;
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch {
      return [];
    }

    const sessions: FoundSession[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const transcriptPath = join(this.root, entry.name, "events.jsonl");
      try {
        const [info, events] = await Promise.all([
          stat(transcriptPath),
          readCopilotEvents(transcriptPath),
        ]);
        if (!events.some((event) => event.type === "session.shutdown")) continue;
        sessions.push({
          sessionId: entry.name,
          transcriptPath,
          projectPath: entry.name,
          mtimeMs: info.mtimeMs,
        });
      } catch {
        // A session can disappear while Copilot prunes its local history.
      }
    }
    return sessions.sort((a, b) => a.mtimeMs - b.mtimeMs);
  }
}
