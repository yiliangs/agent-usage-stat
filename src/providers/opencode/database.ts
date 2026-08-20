import { existsSync, readdirSync } from "fs";
import { isAbsolute, join, resolve } from "path";
import { expandHome } from "../../utils/paths.js";

/**
 * opencode keeps every session, message, and message part in one SQLite
 * database under its data root, not in per-session files. Verified against
 * opencode 1.18.19: `opencode db path` reports `<dataRoot>/opencode.db`, and
 * the schema promotes ids and timestamps to columns while the record body
 * stays a JSON `data` column.
 *
 * The database is the transcript. `FoundSession.transcriptPath` therefore
 * carries the database path for every opencode session, and the session id
 * selects the rows — which is why `readSession` refuses an empty id rather
 * than guessing.
 */

const DEFAULT_DATABASE = "opencode.db";
/** Non-release channels get their own file (`opencode-<channel>.db`). */
const CHANNEL_DATABASE = /^opencode-[A-Za-z0-9._-]+\.db$/;

/** A row shape the caller declares; values arrive as SQLite scalars. */
export type Row = Record<string, string | number | bigint | null | Uint8Array>;

export interface OpencodeDatabase {
  path: string;
  all(sql: string, ...parameters: (string | number)[]): Row[];
  close(): void;
}

/**
 * Locate the database opencode is writing.
 *
 * `OPENCODE_DB` wins when set, matching opencode's own resolution: an absolute
 * path is used as given, anything else resolves inside the data root. Without
 * it the release-channel file is preferred, then the newest channel file, so a
 * machine on a development channel still reconciles.
 */
export function resolveDatabasePath(
  dataRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const override = environment.OPENCODE_DB?.trim();
  if (override) {
    return isAbsolute(expandHome(override))
      ? resolve(expandHome(override))
      : join(dataRoot, override);
  }

  const release = join(dataRoot, DEFAULT_DATABASE);
  if (existsSync(release)) return release;

  let newest: { path: string; name: string } | null = null;
  try {
    for (const name of readdirSync(dataRoot)) {
      if (!CHANNEL_DATABASE.test(name)) continue;
      if (!newest || name > newest.name) newest = { path: join(dataRoot, name), name };
    }
  } catch {
    // No data root yet: report the release path so callers show one location.
  }
  return newest?.path || release;
}

/**
 * Open the database read-only.
 *
 * `node:sqlite` is loaded on demand rather than imported: it initializes a
 * native binding, and a Claude or Codex capture must not pay for that just
 * because the provider registry names every provider.
 *
 * opencode runs the database in WAL mode, so a reader sees a consistent
 * snapshot while a session is still being written. Read-only is what keeps a
 * reconciliation pass from ever perturbing the host's own store.
 */
export async function openDatabase(path: string): Promise<OpencodeDatabase> {
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(path, { readOnly: true });
  return {
    path,
    all(sql, ...parameters) {
      return database.prepare(sql).all(...parameters) as Row[];
    },
    close() {
      database.close();
    },
  };
}

export function textValue(value: Row[string]): string {
  return typeof value === "string" ? value : "";
}

export function numberValue(value: Row[string]): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "bigint") return Number(value);
  return 0;
}
