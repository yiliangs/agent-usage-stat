import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fixtureDir = fileURLToPath(new URL("../fixtures/opencode/", import.meta.url));

export const SCHEMA = readFileSync(join(fixtureDir, "schema.sql"), "utf8");
export const FIXTURE = JSON.parse(
  readFileSync(join(fixtureDir, "session-rows.json"), "utf8"),
);

const SESSION_COLUMNS = [
  "id",
  "project_id",
  "parent_id",
  "slug",
  "directory",
  "title",
  "version",
  "cost",
  "tokens_input",
  "tokens_output",
  "tokens_reasoning",
  "tokens_cache_read",
  "tokens_cache_write",
  "model",
  "time_created",
  "time_updated",
];

/**
 * Build an opencode database from the captured fixture.
 *
 * The schema and the row bodies are opencode's own; only extra rows a single
 * throwaway session could not produce (a subagent child, a damaged body) are
 * synthesized by callers, and those are the rows a test is about.
 */
export function buildOpencodeDatabase(path, { sessions = [], messages = [], parts = [] } = {}) {
  const database = new DatabaseSync(path);
  // opencode runs its store in WAL, which is what lets a reconciliation read
  // and a live session write at the same time. A test that interleaves the two
  // is testing nothing unless the fixture is in the same mode.
  database.exec("PRAGMA journal_mode = WAL");
  database.exec(SCHEMA);

  const insertSession = database.prepare(
    `INSERT INTO session (${SESSION_COLUMNS.join(", ")})
     VALUES (${SESSION_COLUMNS.map(() => "?").join(", ")})`,
  );
  const insertMessage = database.prepare(
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
  );
  const insertPart = database.prepare(
    "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
  );

  // node:sqlite enforces foreign keys, and opencode owns a session through a
  // project, so the parent row has to exist even though nothing reads it.
  database
    .prepare(
      "INSERT INTO project (id, worktree, vcs, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      FIXTURE.session.project_id,
      FIXTURE.session.directory,
      "git",
      FIXTURE.session.time_created,
      FIXTURE.session.time_updated,
      "[]",
    );

  for (const session of [FIXTURE.session, ...sessions]) {
    insertSession.run(
      ...SESSION_COLUMNS.map((column) =>
        column === "version" ? session.version ?? "1.18.19" : session[column] ?? null
      ),
    );
  }
  for (const message of [...FIXTURE.messages, ...messages]) {
    insertMessage.run(
      message.id,
      message.session_id,
      message.time_created,
      message.time_updated ?? message.time_created,
      message.data,
    );
  }
  for (const part of [...FIXTURE.parts, ...parts]) {
    insertPart.run(
      part.id,
      part.message_id,
      part.session_id ?? FIXTURE.session.id,
      part.time_created,
      part.time_updated ?? part.time_created,
      part.data,
    );
  }

  database.close();
  return path;
}

/** A session row shaped like the fixture's, with the given fields replaced. */
export function sessionRow(overrides) {
  return { ...FIXTURE.session, ...overrides };
}

/** An assistant message body in opencode's own shape. */
export function assistantMessage({
  id,
  sessionId = FIXTURE.session.id,
  modelId,
  timeCreated,
  cost = 0,
  input = 0,
  output = 0,
  reasoning = 0,
  cacheRead = 0,
  cacheWrite = 0,
}) {
  return {
    id,
    session_id: sessionId,
    time_created: timeCreated,
    time_updated: timeCreated,
    data: JSON.stringify({
      role: "assistant",
      cost,
      tokens: {
        total: input + output + reasoning + cacheRead + cacheWrite,
        input,
        output,
        reasoning,
        cache: { read: cacheRead, write: cacheWrite },
      },
      modelID: modelId,
      providerID: "opencode",
      time: { created: timeCreated, completed: timeCreated + 1000 },
      finish: "stop",
    }),
  };
}
