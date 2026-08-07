// Claude Code transcript JSONL wire format — provider-private. The neutral
// output shape (ParsedTranscript) lives in src/types/transcript.ts.

export interface TranscriptMessage {
  type: "user" | "assistant" | "file-history-snapshot";
  message?: {
    // Anthropic message id (e.g. "msg_…"). A single assistant turn with
    // multiple content blocks is written across several JSONL lines that
    // share this id and repeat the same usage — used to dedupe billing.
    id?: string;
    content:
      | string
      | Array<{ type: string; text?: string; [key: string]: unknown }>;
    role?: "user" | "assistant";
    model?: string;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      speed?: "fast" | "standard" | string;
    };
  };
  // Anthropic request id (e.g. "req_…"). GPT-routed Claude Code responses
  // omit it, so billing deduplication uses the response/message id itself.
  requestId?: string;
  slug?: string;
  sessionId?: string;
  cwd?: string;
  version?: string;
  gitBranch?: string;
  timestamp: string;
  uuid?: string;
}
