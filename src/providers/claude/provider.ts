import { SessionFinder } from "./session-finder.js";
import { fingerprintSessionTranscript } from "./transcript-fingerprint.js";
import { readClaudeSnapshot } from "./incremental-snapshot.js";
import type {
  SessionProvider,
  FoundSession,
  ProviderSessionSnapshot,
} from "../../types/provider.js";

/**
 * Claude Code sessions: transcripts under `~/.claude/projects/`, per-message
 * `message.usage` billing events (deduped by message.id, subagent trees scanned
 * recursively), with pricing selected from the actual Claude or GPT model ID.
 */
export class ClaudeProvider implements SessionProvider {
  readonly name = "claude" as const;

  private finder: SessionFinder;

  constructor(claudeHome?: string) {
    this.finder = new SessionFinder(claudeHome);
  }

  findSession(query?: string): Promise<FoundSession> {
    return this.finder.find(query);
  }

  findAllSessions(): Promise<FoundSession[]> {
    return this.finder.findAll();
  }

  fingerprintSession(session: FoundSession): Promise<string> {
    return fingerprintSessionTranscript(
      session.transcriptPath,
      session.sessionId,
    );
  }

  readSession(
    transcriptPath: string,
    fallbackSessionId: string,
  ): Promise<ProviderSessionSnapshot> {
    return readClaudeSnapshot(transcriptPath, fallbackSessionId);
  }
}
