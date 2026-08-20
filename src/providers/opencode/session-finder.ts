import { join } from "path";
import { homeDir } from "../../utils/paths.js";
import type { FoundSession } from "../../types/provider.js";
import { resolveDatabasePath } from "./database.js";
import { listRootSessions } from "./transcript-reader.js";

export class SessionFinder {
  private databasePath: string;

  constructor(dataRoot = defaultDataRoot()) {
    this.databasePath = resolveDatabasePath(dataRoot);
  }

  async find(query?: string): Promise<FoundSession> {
    const sessions = await this.findAll();
    const matches = query
      ? sessions.filter(
          (session) =>
            session.sessionId.startsWith(query) ||
            session.projectPath.toLowerCase().includes(query.toLowerCase()),
        )
      : sessions;
    if (matches.length === 0) {
      throw new Error(
        query
          ? `No opencode session matching "${query}".`
          : `No opencode sessions found in ${this.databasePath}.`,
      );
    }
    return matches.sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  }

  /**
   * Every root session is a candidate.
   *
   * opencode has no shutdown record to gate on the way Copilot does, and a
   * session stays writable indefinitely. Reconciling a still-active session is
   * safe because the shard writer is idempotent and never lowers a recorded
   * value, so an early read is a checkpoint rather than a mistake.
   */
  async findAll(): Promise<FoundSession[]> {
    let rows;
    try {
      rows = await listRootSessions(this.databasePath);
    } catch {
      // No opencode install, or a database this build cannot open.
      return [];
    }
    return rows
      .map((row) => ({
        sessionId: row.id,
        transcriptPath: this.databasePath,
        projectPath: row.directory,
        mtimeMs: row.timeUpdated || row.timeCreated,
      }))
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
  }
}

/** opencode nests its directory inside an XDG base on every platform. */
function defaultDataRoot(): string {
  const base = process.env.XDG_DATA_HOME?.trim() ||
    join(homeDir(), ".local", "share");
  return join(base, "opencode");
}
