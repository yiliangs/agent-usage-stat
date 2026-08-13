import type {
  FoundSession,
  ProviderSessionSnapshot,
  SessionProvider,
} from "../../types/provider.js";
import { SessionFinder } from "./session-finder.js";
import { readCopilotSnapshot } from "./session-reader.js";
import { fingerprintTranscriptFile } from "./transcript-fingerprint.js";

export class CopilotProvider implements SessionProvider {
  readonly name = "copilot" as const;

  private finder: SessionFinder;

  constructor(copilotHome?: string) {
    this.finder = new SessionFinder(copilotHome);
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
    return readCopilotSnapshot(transcriptPath, fallbackSessionId);
  }
}
