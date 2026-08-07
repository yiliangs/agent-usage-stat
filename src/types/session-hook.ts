/** Fields shared by Claude Code and Codex command hooks. */
export interface HookData {
  session_id: string;
  transcript_path?: string | null;
  cwd: string;
  permission_mode: string;
  hook_event_name: string;
  model?: string;
  turn_id?: string;
  agent_id?: string;
  agent_transcript_path?: string | null;
}

export interface SessionEndHookData extends HookData {
  transcript_path: string;
  hook_event_name: "SessionEnd";
  reason: "exit" | "clear" | "logout" | "prompt_input_exit" | "other";
}

export interface CodexStopHookData extends HookData {
  hook_event_name: "Stop" | "SubagentStop";
  stop_hook_active: boolean;
  last_assistant_message?: string | null;
}
