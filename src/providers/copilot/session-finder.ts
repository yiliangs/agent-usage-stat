import { readdir, stat } from "fs/promises";
import { join } from "path";
import { homeDir } from "../../utils/paths.js";
import type { FoundSession } from "../../types/provider.js";
import { hasShutdownRecord } from "./transcript-reader.js";

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
        // Discovery runs on every launch, so completion is decided from a
        // bounded tail rather than a full parse of the whole history.
        const [info, complete] = await Promise.all([
          stat(transcriptPath),
          hasShutdownRecord(transcriptPath),
        ]);
        if (!complete) continue;
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
