import { join } from "path";
import { homeDir } from "../../utils/paths.js";
import type { FoundSession } from "../../types/provider.js";
import type { OpencodeSessionRow } from "./transcript-format.js";
import { resolveDatabasePath } from "./database.js";
import { listRootSessions, rootSessionOf } from "./transcript-reader.js";

export class SessionFinder {
  private databasePath: string;

  constructor(dataRoot = defaultDataRoot()) {
    this.databasePath = resolveDatabasePath(dataRoot);
  }

  /**
   * A candidate first, then the tree an exact id sits in.
   *
   * The candidates are roots, because that is the granularity usage is
   * reconciled at. But opencode fires `session.idle` on subagent sessions too
   * and its plugin forwards whatever id the event carried, so a query naming
   * no root is routinely a live descendant rather than a mistake: resolve it
   * to the root that folds its tokens in. An id no row carries still fails.
   */
  async find(query?: string): Promise<FoundSession> {
    const sessions = await this.findAll();
    const matches = query
      ? sessions.filter(
          (session) =>
            session.sessionId.startsWith(query) ||
            session.projectPath.toLowerCase().includes(query.toLowerCase()),
        )
      : sessions;
    if (matches.length > 0) {
      return matches.sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
    }
    const root = query ? await this.rootOf(query) : null;
    if (root) return this.toFoundSession(root);
    throw new Error(
      query
        ? `No opencode session matching "${query}".`
        : `No opencode sessions found in ${this.databasePath}.`,
    );
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
      .map((row) => this.toFoundSession(row))
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
  }

  private async rootOf(sessionId: string): Promise<OpencodeSessionRow | null> {
    try {
      return await rootSessionOf(this.databasePath, sessionId);
    } catch {
      // No opencode install, or a database this build cannot open.
      return null;
    }
  }

  private toFoundSession(row: OpencodeSessionRow): FoundSession {
    return {
      sessionId: row.id,
      transcriptPath: this.databasePath,
      projectPath: row.directory,
      mtimeMs: row.timeUpdated || row.timeCreated,
    };
  }
}

/** opencode nests its directory inside an XDG base on every platform. */
function defaultDataRoot(): string {
  const base = process.env.XDG_DATA_HOME?.trim() ||
    join(homeDir(), ".local", "share");
  return join(base, "opencode");
}
