import { SessionFinder } from "./session-finder.js";
import { fingerprintTranscriptFile } from "./transcript-fingerprint.js";
import { readCodexSnapshot } from "./incremental-snapshot.js";
import type {
  FoundSession,
  ProviderSessionSnapshot,
  SessionProvider,
} from "../../types/provider.js";

/** Codex rollouts under ~/.codex/sessions, priced at OpenAI API list rates. */
export class CodexProvider implements SessionProvider {
  readonly name = "codex" as const;

  private finder: SessionFinder;

  constructor(codexHome?: string) {
    this.finder = new SessionFinder(codexHome);
  }

  findSession(query?: string): Promise<FoundSession> {
    return this.finder.find(query);
  }

  findAllSessions(): Promise<FoundSession[]> {
    return this.finder.findAll();
  }

  fingerprintSession(session: FoundSession): Promise<string> {
    return fingerprintTranscriptFile(session.transcriptPath);
  }

  readSession(
    transcriptPath: string,
    fallbackSessionId: string,
  ): Promise<ProviderSessionSnapshot> {
    return readCodexSnapshot(transcriptPath, fallbackSessionId);
  }
}
