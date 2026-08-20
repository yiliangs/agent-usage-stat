/**
 * opencode's on-disk record shapes, captured from a real opencode 1.18.19
 * database rather than from documentation.
 *
 * The `session`, `message`, and `part` tables all promote identity and
 * timestamps to columns and keep the record body in a JSON `data` column, so
 * every interface below splits the same way.
 */

/** One row of `session`, restricted to the columns this provider reads. */
export interface OpencodeSessionRow {
  id: string;
  parentId: string | null;
  directory: string;
  slug: string;
  title: string;
  cost: number;
  tokensInput: number;
  tokensOutput: number;
  tokensReasoning: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  timeCreated: number;
  timeUpdated: number;
}

/**
 * Token counts as opencode records them.
 *
 * Two of these are not what the same words mean elsewhere in this codebase,
 * verified by driving opencode against a stub model API: `input` already
 * excludes cache reads, and `output` already excludes reasoning. An upstream
 * response reporting 1200 prompt / 800 cached / 340 completion / 90 reasoning
 * was stored as input 400, cache.read 800, output 250, reasoning 90.
 */
export interface OpencodeTokens {
  total?: number;
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: {
    read?: number;
    write?: number;
  };
}

/** The JSON body of a `message` row. `id` and `sessionID` live in columns. */
export interface OpencodeMessageData {
  role?: string;
  parentID?: string;
  mode?: string;
  agent?: string;
  path?: {
    cwd?: string;
    root?: string;
  };
  /** opencode's own cost estimate, in USD. Zero when it cannot price the model. */
  cost?: number;
  tokens?: OpencodeTokens;
  modelID?: string;
  /** Routing identity, never the model's maker. Deliberately not a vendor. */
  providerID?: string;
  time?: {
    created?: number;
    completed?: number;
  };
  finish?: string;
}

/** One assistant turn, already flattened out of its row and JSON body. */
export interface OpencodeAssistantMessage {
  id: string;
  sessionId: string;
  modelId: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  timeCreated: number;
  timeCompleted: number;
}

/** The JSON body of a `part` row; only text parts carry prompt content. */
export interface OpencodePartData {
  type?: string;
  text?: string;
}

/** Everything one session read yields, so the database opens exactly once. */
export interface OpencodeSessionRecords {
  session: OpencodeSessionRow;
  assistants: OpencodeAssistantMessage[];
  userMessageCount: number;
  firstPrompt: string;
}
