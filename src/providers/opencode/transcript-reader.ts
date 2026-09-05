import { numberValue, openDatabase, textValue } from "./database.js";
import type { OpencodeDatabase, OpenOpencodeDatabase, Row } from "./database.js";
import type {
  OpencodeAssistantMessage,
  OpencodeMessageData,
  OpencodePartData,
  OpencodeSessionRecords,
  OpencodeSessionRow,
} from "./transcript-format.js";

/**
 * Every query this provider issues, with per-row error isolation.
 *
 * A message body is JSON in a text column, so one malformed body is the exact
 * analogue of one malformed JSONL line: it is skipped, never fatal. opencode
 * writes a row as soon as an assistant turn starts and updates it as tokens
 * arrive, so a live session routinely yields rows that are merely incomplete.
 *
 * A session's usage folds in its descendants. opencode gives a subagent its
 * own `session` row linked by `parent_id`, and nothing rolls that usage back
 * into the parent's messages, so a parent read that stopped at its own rows
 * would silently drop every subagent turn.
 */

const SESSION_COLUMNS = `
  id,
  parent_id,
  directory,
  slug,
  title,
  cost,
  tokens_input,
  tokens_output,
  tokens_reasoning,
  tokens_cache_read,
  tokens_cache_write,
  time_created,
  time_updated
`;

const SESSION_TREE = `
  WITH RECURSIVE tree(id) AS (
    SELECT ?
    UNION
    SELECT session.id FROM session JOIN tree ON session.parent_id = tree.id
  )
`;

/** Root sessions only; descendants are read through their parent. */
export async function listRootSessions(
  databasePath: string,
): Promise<OpencodeSessionRow[]> {
  const database = await openDatabase(databasePath);
  try {
    return database
      .all(`SELECT ${SESSION_COLUMNS} FROM session WHERE parent_id IS NULL`)
      .map(toSessionRow);
  } finally {
    database.close();
  }
}

/**
 * Cheap change detector for one session tree, for callers that want nothing
 * else. A read that also produces usage takes these inputs from
 * `readSessionRecords` instead, so both describe the same snapshot.
 */
export async function readFingerprintInputs(
  databasePath: string,
  sessionId: string,
): Promise<string> {
  const database = await openDatabase(databasePath);
  try {
    return database.oneRead(() => fingerprintInputsOf(database, sessionId));
  } finally {
    database.close();
  }
}

/**
 * Every billing input is either a promoted token column or a message body, so
 * the tree's token columns plus the message count and timestamp aggregate move
 * whenever the recorded usage could have moved. No message body is parsed.
 */
function fingerprintInputsOf(
  database: OpencodeDatabase,
  sessionId: string,
): string {
  const [totals] = database.all(
    `${SESSION_TREE}
     SELECT
       count(*) AS sessions,
       coalesce(sum(session.cost), 0) AS cost,
       coalesce(sum(session.tokens_input), 0) AS input,
       coalesce(sum(session.tokens_output), 0) AS output,
       coalesce(sum(session.tokens_reasoning), 0) AS reasoning,
       coalesce(sum(session.tokens_cache_read), 0) AS cache_read,
       coalesce(sum(session.tokens_cache_write), 0) AS cache_write,
       coalesce(max(session.time_updated), 0) AS updated
     FROM session WHERE session.id IN (SELECT id FROM tree)`,
    sessionId,
  );
  const [messages] = database.all(
    `${SESSION_TREE}
     SELECT
       count(*) AS messages,
       coalesce(sum(message.time_updated), 0) AS updated_sum,
       coalesce(max(message.time_updated), 0) AS updated_max
     FROM message WHERE message.session_id IN (SELECT id FROM tree)`,
    sessionId,
  );
  return JSON.stringify([
    numbersOf(totals, [
      "sessions",
      "cost",
      "input",
      "output",
      "reasoning",
      "cache_read",
      "cache_write",
      "updated",
    ]),
    numbersOf(messages, ["messages", "updated_sum", "updated_max"]),
  ]);
}

/**
 * One consistent read of a session tree: the row, its turns, its prompt, and
 * the fingerprint inputs describing exactly that tree.
 *
 * The fingerprint travels with the records because a shard's usage and the
 * fingerprint pinning it have to describe the same tree. Read separately, a
 * message row landing in between would be fingerprinted but not billed, and
 * the next sync would compare fingerprints, find them equal, and never come
 * back for it. `open` exists so a test can interleave that write.
 */
export async function readSessionRecords(
  databasePath: string,
  sessionId: string,
  open: OpenOpencodeDatabase = openDatabase,
): Promise<OpencodeSessionRecords> {
  const database = await open(databasePath);
  try {
    return database.oneRead(() => sessionRecordsOf(database, sessionId));
  } finally {
    database.close();
  }
}

function sessionRecordsOf(
  database: OpencodeDatabase,
  sessionId: string,
): OpencodeSessionRecords {
  const [row] = database.all(
    `SELECT ${SESSION_COLUMNS} FROM session WHERE id = ?`,
    sessionId,
  );
  if (!row) {
    throw new Error(`opencode session not found: ${sessionId}`);
  }

  const messages = database.all(
    `${SESSION_TREE}
     SELECT message.id, message.session_id, message.data
     FROM message
     WHERE message.session_id IN (SELECT id FROM tree)
     ORDER BY message.time_created, message.id`,
    sessionId,
  );

  const assistants: OpencodeAssistantMessage[] = [];
  let userMessageCount = 0;
  let firstUserMessageId = "";
  for (const message of messages) {
    const data = parseData<OpencodeMessageData>(message.data);
    if (!data) continue;
    if (data.role === "user") {
      userMessageCount++;
      if (!firstUserMessageId) firstUserMessageId = textValue(message.id);
      continue;
    }
    if (data.role !== "assistant") continue;
    assistants.push(
      toAssistantMessage(textValue(message.id), textValue(message.session_id), data),
    );
  }

  return {
    session: toSessionRow(row),
    assistants,
    userMessageCount,
    firstPrompt: firstUserMessageId
      ? readFirstPromptText(database.all(
        `SELECT data FROM part WHERE message_id = ? ORDER BY id`,
        firstUserMessageId,
      ))
      : "",
    fingerprintInputs: fingerprintInputsOf(database, sessionId),
  };
}

function toSessionRow(row: Row): OpencodeSessionRow {
  return {
    id: textValue(row.id),
    parentId: typeof row.parent_id === "string" ? row.parent_id : null,
    directory: textValue(row.directory),
    slug: textValue(row.slug),
    title: textValue(row.title),
    cost: numberValue(row.cost),
    tokensInput: numberValue(row.tokens_input),
    tokensOutput: numberValue(row.tokens_output),
    tokensReasoning: numberValue(row.tokens_reasoning),
    tokensCacheRead: numberValue(row.tokens_cache_read),
    tokensCacheWrite: numberValue(row.tokens_cache_write),
    timeCreated: numberValue(row.time_created),
    timeUpdated: numberValue(row.time_updated),
  };
}

/**
 * Reasoning tokens are billed as output but recorded beside it, so they are
 * folded back in here — the one place that knows opencode's split.
 */
function toAssistantMessage(
  id: string,
  sessionId: string,
  data: OpencodeMessageData,
): OpencodeAssistantMessage {
  const tokens = data.tokens || {};
  return {
    id,
    sessionId,
    modelId: typeof data.modelID === "string" ? data.modelID : "",
    cost: nonNegative(data.cost),
    inputTokens: nonNegative(tokens.input),
    outputTokens: nonNegative(tokens.output) + nonNegative(tokens.reasoning),
    cacheReadTokens: nonNegative(tokens.cache?.read),
    cacheWriteTokens: nonNegative(tokens.cache?.write),
    timeCreated: nonNegative(data.time?.created),
    timeCompleted: nonNegative(data.time?.completed),
  };
}

function readFirstPromptText(rows: Row[]): string {
  for (const row of rows) {
    const part = parseData<OpencodePartData>(row.data);
    if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
      return part.text.trim();
    }
  }
  return "";
}

function parseData<T>(value: Row[string]): T | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as T) : null;
  } catch {
    // opencode may still be writing this record, or it may be damaged.
    // Either way one row must never sink the session.
    return null;
  }
}

function numbersOf(row: Row | undefined, keys: string[]): number[] {
  return keys.map((key) => numberValue(row?.[key] ?? 0));
}

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}
