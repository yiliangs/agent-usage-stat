// Provider-neutral session metadata, produced by each provider's transcript
// parser. The provider-specific wire formats live with their providers
// (e.g. src/providers/claude/transcript-format.ts).

export interface ParsedTranscript {
  sessionSlug: string;
  firstPrompt: string;
  startTime: Date;
  endTime: Date;
  userMessageCount: number;
  assistantMessageCount: number;
  totalMessages: number;
  gitBranch?: string;
  cwd?: string;
}
