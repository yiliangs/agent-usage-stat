// Codex rollout JSONL wire format. Codex documents transcript_path as a
// convenience rather than a stable hook interface, so parsing stays tolerant:
// every field is optional and unknown records are ignored.

export interface CodexTokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

export interface CodexRolloutRecord {
  timestamp?: string;
  type?: "session_meta" | "turn_context" | "event_msg" | "response_item" | string;
  payload?: {
    type?: string;
    id?: string;
    session_id?: string;
    cwd?: string;
    model?: string;
    model_provider?: string;
    turn_id?: string;
    message?: string;
    thread_settings?: {
      model?: string;
      service_tier?: string;
    };
    git?: {
      branch?: string;
    };
    info?: {
      total_token_usage?: CodexTokenUsage;
      last_token_usage?: CodexTokenUsage;
    } | null;
    role?: string;
    content?: Array<{
      type?: string;
      text?: string;
    }>;
    [key: string]: unknown;
  };
}
